/**
 * Archive preview / extraction (port of OpenList's internal/archive).
 *
 * Supported formats:
 *  - ZIP: central directory is read via HTTP Range requests (works on large
 *    archives without downloading the whole file). Deflate via fflate.
 *  - TAR: sequential ustar header parsing via chunked Range reads.
 *  - TAR.GZ / GZ: gunzip via fflate (whole-file, bounded by worker memory).
 *
 * Encrypted archives (zip AES/ZipCrypto) are detected and reported as
 * `encrypted`; extraction returns a clear error.
 */

import { inflateSync, gunzipSync, unzlibSync } from 'fflate';
import { Env } from '../types';
import { getStorageForPath, getRelativePath } from '../routes/fs';
import { getDriverInstance } from '../drivers/registry';

export interface ArchiveEntry {
  name: string;        // full path inside the archive
  is_dir: boolean;
  size: number;        // uncompressed size
  modified?: string;
  /** zip: raw info for extraction */
  method?: number;
  compressedSize?: number;
  localHeaderOffset?: number;
  flags?: number;
  /** tar: block offset of the data */
  dataOffset?: number;
}

const ARCHIVE_EXTS = ['.zip', '.tar', '.tgz', '.tar.gz', '.gz', '.tar.bz2', '.tar.xz', '.tbz2', '.7z', '.rar', '.xz', '.bz2'];

export function isArchiveFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTS.some(ext => lower.endsWith(ext));
}

function fixPath(p: string): string {
  if (!p) return '/';
  let c = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!c.startsWith('/')) c = '/' + c;
  while (c.length > 1 && c.endsWith('/')) c = c.slice(0, -1);
  return c;
}

// ---------------------------------------------------------------------------
// archive source resolution
// ---------------------------------------------------------------------------

interface ArchiveSource {
  url: string;
  header?: Record<string, string>;
  storage: any;
}

async function getArchiveSource(path: string, env: Env): Promise<ArchiveSource> {
  const storage = await getStorageForPath(path, env);
  if (!storage) throw new Error('Storage not found');
  const addition = JSON.parse(storage.addition);
  const driver = await getDriverInstance(storage.driver, addition);
  const relativePath = getRelativePath(path, storage.mount_path);
  const link = await driver.link(relativePath, addition);
  return { url: link.url, header: link.header, storage };
}

interface RangeResult {
  data: Uint8Array;
  total: number;   // total file length (from Content-Range or Content-Length)
  status: number;
}

// Fetch a byte range, following redirects manually and stripping sensitive
// headers on cross-origin hops.
async function rangeFetch(source: ArchiveSource, offset: number, length: number): Promise<RangeResult> {
  const headers: Record<string, string> = { ...(source.header || {}), Range: `bytes=${offset}-${offset + length - 1}` };
  let r = await fetch(source.url, { method: 'GET', headers, redirect: 'manual' });
  let hops = 0;
  const redirectStatus = [301, 302, 303, 307, 308];
  while (redirectStatus.includes(r.status) && hops < 5) {
    const loc = r.headers.get('location');
    if (!loc) break;
    const next = new URL(loc, r.url);
    if (next.origin !== new URL(source.url).origin) {
      for (const k of Object.keys(headers)) {
        if (/^authorization$/i.test(k) || /^cookie$/i.test(k)) delete headers[k];
      }
    }
    r = await fetch(next.toString(), { method: 'GET', headers, redirect: 'manual' });
    hops++;
  }
  const buf = await r.arrayBuffer();
  // Parse total length from Content-Range ("bytes 0-99/12345") or Content-Length.
  const cr = r.headers.get('content-range') || '';
  const totalMatch = cr.match(/\/(\d+)/);
  let total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
  if (!total) {
    const cl = r.headers.get('content-length');
    if (cl) total = parseInt(cl, 10);
  }
  return { data: new Uint8Array(buf), total, status: r.status };
}

// ---------------------------------------------------------------------------
// ZIP parsing (central directory via Range)
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

function readU32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function readU16(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8)) >>> 0;
}

/** Charset used when a zip entry has no EFS flag and the raw name is not UTF-8. */
const DEFAULT_LEGACY_CHARSET = 'GB18030';
const LEGACY_CHARSET_SETTING = 'non_efs_zip_encoding';

const utf8Decoder = new TextDecoder('utf-8');
const utf8StrictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const charsetDecoderCache = new Map<string, TextDecoder | null>();

function getCharsetDecoder(charset: string): TextDecoder | null {
  const key = (charset || '').trim().toLowerCase();
  if (!key) return null;
  if (key === 'utf-8' || key === 'utf8') return utf8Decoder;
  if (charsetDecoderCache.has(key)) return charsetDecoderCache.get(key)!;
  let decoder: TextDecoder | null = null;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    // label not supported by this runtime (e.g. "ibm437"/"cp936")
    decoder = null;
  }
  charsetDecoderCache.set(key, decoder);
  return decoder;
}

/**
 * Decode an archive entry name.
 *
 * - `forceUtf8` (zip EFS flag bit 0x800 set) -> the name is declared UTF-8.
 * - otherwise prefer strict UTF-8; only when the bytes are *not* valid UTF-8
 *   (e.g. GBK names written by Windows zip tools without the EFS flag) fall
 *   back to the configured legacy charset.
 */
export function decodeName(b: Uint8Array, legacyCharset: string, forceUtf8 = false): string {
  if (forceUtf8) return utf8Decoder.decode(b);
  try {
    return utf8StrictDecoder.decode(b);
  } catch {
    // Not valid UTF-8 -> retry with the configured legacy charset.
    const decoder = getCharsetDecoder(legacyCharset);
    if (decoder) {
      try {
        return decoder.decode(b);
      } catch {
        // fall through
      }
    }
    return utf8Decoder.decode(b);
  }
}

/** Resolve the configured zip legacy charset, falling back to GB18030. */
async function resolveLegacyCharset(env: Env): Promise<string> {
  try {
    const row: any = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
      .bind(LEGACY_CHARSET_SETTING).first();
    const v = row?.value;
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch {
    // DB unavailable (unit tests / non-DB envs) -> default.
  }
  return DEFAULT_LEGACY_CHARSET;
}

async function parseZipEntries(source: ArchiveSource, fileSize: number, legacyCharset: string): Promise<{ entries: ArchiveEntry[]; encrypted: boolean; comment: string }> {
  // Read the EOCD by scanning the last 64KB.
  const tailLen = Math.min(65557, fileSize);
  const tail = await rangeFetch(source, fileSize - tailLen, tailLen);
  const buf = tail.data;

  let eocdIndex = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (readU32(buf, i) === EOCD_SIG) {
      eocdIndex = i;
      break;
    }
  }
  if (eocdIndex < 0) {
    throw new Error('invalid zip: EOCD not found');
  }

  const totalEntries = readU16(buf, eocdIndex + 10);
  const cdSize = readU32(buf, eocdIndex + 12);
  const cdOffset = readU32(buf, eocdIndex + 16);
  const commentLen = readU16(buf, eocdIndex + 20);
  const comment = decodeName(buf.slice(eocdIndex + 22, eocdIndex + 22 + commentLen), legacyCharset);

  // ZIP64: total entries = 0xffff or cdSize/cdOffset = 0xffffffff signals ZIP64.
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // Read the ZIP64 EOCD locator (20 bytes before the EOCD).
    const locatorOffset = fileSize - tailLen + eocdIndex - 20;
    if (locatorOffset >= 0) {
      const locator = await rangeFetch(source, locatorOffset, 20);
      const loc = locator.data;
      if (readU32(loc, 0) === ZIP64_EOCD_LOCATOR_SIG) {
        const z64Offset = readU32(loc, 8);
        const z64 = await rangeFetch(source, z64Offset, 56);
        const zb = z64.data;
        // ZIP64 EOCD: 8 bytes offset 0 = sig, then size, version... entries at
        // offsets 32 (total entries disk), 40 (cd size), 48 (cd offset).
        const totalEntries64 = Number(readU32(zb, 32)) | (Number(readU32(zb, 36)) << 32);
        const cdSize64 = Number(readU32(zb, 40)) | (Number(readU32(zb, 44)) << 32);
        const cdOffset64 = Number(readU32(zb, 48)) | (Number(readU32(zb, 52)) << 32);
        return parseCentralDirectory(source, cdOffset64, cdSize64, totalEntries64, legacyCharset);
      }
    }
  }

  return parseCentralDirectory(source, cdOffset, cdSize, totalEntries, legacyCharset);
}

async function parseCentralDirectory(source: ArchiveSource, cdOffset: number, cdSize: number, totalEntries: number, legacyCharset: string): Promise<{ entries: ArchiveEntry[]; encrypted: boolean; comment: string }> {
  const cd = await rangeFetch(source, cdOffset, Math.min(cdSize, 64 * 1024 * 1024));
  const buf = cd.data;
  const entries: ArchiveEntry[] = [];
  let encrypted = false;
  let pos = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length) break;
    if (readU32(buf, pos) !== 0x02014b50) break; // central file header sig
    const flags = readU16(buf, pos + 8);
    const method = readU16(buf, pos + 10);
    const modTime = readU16(buf, pos + 12);
    const modDate = readU16(buf, pos + 14);
    const compressedSize = readU32(buf, pos + 20);
    const uncompressedSize = readU32(buf, pos + 24);
    const nameLen = readU16(buf, pos + 28);
    const extraLen = readU16(buf, pos + 30);
    const commentLen = readU16(buf, pos + 32);
    const localHeaderOffset = readU32(buf, pos + 42);
    const nameBytes = buf.slice(pos + 46, pos + 46 + nameLen);
    // Bit 11 (0x800) = EFS: filename is UTF-8. Otherwise prefer strict UTF-8
    // and fall back to the configured legacy charset when the bytes are not
    // valid UTF-8 (GBK etc.).
    const name = decodeName(nameBytes, legacyCharset, (flags & 0x800) !== 0);

    // Bit 0 = encrypted (ZipCrypto); AES uses method 99.
    if ((flags & 1) !== 0 || method === 99) encrypted = true;

    const isDir = name.endsWith('/');
    entries.push({
      name: fixPath('/' + name),
      is_dir: isDir,
      size: uncompressedSize,
      modified: zipDosTime(modDate, modTime),
      method,
      compressedSize,
      localHeaderOffset,
      flags,
    });

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return { entries, encrypted, comment: '' };
}

function zipDosTime(date: number, time: number): string {
  const year = ((date >> 9) & 0x7f) + 1980;
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  const hour = (time >> 11) & 0x1f;
  const minute = (time >> 5) & 0x3f;
  const second = (time & 0x1f) * 2;
  const d = new Date(year, month, day, hour, minute, second);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// Extract a single file from a zip by local header + compressed data.
async function extractZipEntry(source: ArchiveSource, entry: ArchiveEntry): Promise<Uint8Array> {
  if (entry.is_dir) throw new Error('is a directory');
  if (entry.flags !== undefined && (entry.flags & 1) !== 0) {
    throw new Error('encrypted zip is not supported');
  }
  if (entry.method === 99) throw new Error('AES-encrypted zip is not supported');
  if (entry.localHeaderOffset === undefined || entry.compressedSize === undefined) {
    throw new Error('missing zip entry info');
  }

  const lh = await rangeFetch(source, entry.localHeaderOffset, 30);
  const lb = lh.data;
  if (readU32(lb, 0) !== 0x04034b50) throw new Error('invalid zip local header');
  const nameLen = readU16(lb, 26);
  const extraLen = readU16(lb, 28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen;

  const data = await rangeFetch(source, dataOffset, entry.compressedSize);
  const raw = data.data;

  if (entry.method === 0) {
    return raw; // stored
  }
  if (entry.method === 8) {
    return inflateSync(raw); // raw deflate (fflate handles it directly)
  }
  throw new Error(`unsupported zip compression method: ${entry.method}`);
}

// ---------------------------------------------------------------------------
// TAR parsing (ustar)
// ---------------------------------------------------------------------------

async function parseTarEntries(source: ArchiveSource, fileSize: number, legacyCharset: string): Promise<{ entries: ArchiveEntry[]; encrypted: boolean; comment: string }> {
  const entries: ArchiveEntry[] = [];
  const chunkSize = 512 * 1024;
  let offset = 0;
  let chunk: Uint8Array = new Uint8Array(0);
  let chunkOffset = 0; // absolute offset of chunk[0]

  const readBytes = async (absOffset: number, length: number): Promise<Uint8Array> => {
    if (absOffset + length > fileSize) return new Uint8Array(0);
    if (absOffset >= chunkOffset && absOffset + length <= chunkOffset + chunk.length) {
      return chunk.slice(absOffset - chunkOffset, absOffset - chunkOffset + length);
    }
    chunkOffset = absOffset - (absOffset % chunkSize);
    const r = await rangeFetch(source, chunkOffset, Math.min(chunkSize, fileSize - chunkOffset));
    chunk = r.data;
    const rel = absOffset - chunkOffset;
    return chunk.slice(rel, rel + length);
  };

  while (offset < fileSize) {
    const header = await readBytes(offset, 512);
    if (header.length < 512) break;
    // End of archive: two zero blocks
    if (header.every(b => b === 0)) break;

    const nameBuf = header.subarray(0, 100);
    const prefixBuf = header.subarray(345, 345 + 155);
    let name = decodeName(nameBuf, legacyCharset).replace(/\0.*$/, '');
    const prefix = decodeName(prefixBuf, legacyCharset).replace(/\0.*$/, '');
    if (prefix) name = `${prefix}/${name}`;

    const sizeStr = decodeName(header.subarray(124, 136), legacyCharset).replace(/[^0-9o]/gi, '');
    let size = 0;
    try {
      size = parseInt(sizeStr, 8) || 0;
    } catch {
      size = 0;
    }
    const typeflag = String.fromCharCode(header[156] || 0);
    const modStr = decodeName(header.subarray(136, 148), legacyCharset).replace(/\0.*$/, '');
    let modified: string | undefined;
    const modTs = parseInt(modStr.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(modTs) && modTs > 0) modified = new Date(modTs * 1000).toISOString();

    const dataOffset = offset + 512;
    const isDir = typeflag === '5' || typeflag === '0' && name.endsWith('/');
    entries.push({ name: fixPath('/' + name), is_dir: isDir, size, modified, dataOffset });

    // Advance: header + data, padded to 512.
    offset = dataOffset + Math.ceil(size / 512) * 512;
    if (entries.length > 200000) break; // safety
  }

  return { entries, encrypted: false, comment: '' };
}

async function extractTarEntry(source: ArchiveSource, entry: ArchiveEntry): Promise<Uint8Array> {
  if (entry.is_dir) throw new Error('is a directory');
  if (entry.dataOffset === undefined) throw new Error('missing tar entry offset');
  const r = await rangeFetch(source, entry.dataOffset, entry.size);
  return r.data.slice(0, entry.size);
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

interface ParsedArchive {
  entries: ArchiveEntry[];
  encrypted: boolean;
  comment: string;
  format: 'zip' | 'tar' | 'gzip' | string;
}

async function getFileSize(source: ArchiveSource): Promise<number> {
  const probe = await rangeFetch(source, 0, 1);
  if (probe.total > 0) return probe.total;
  // Server didn't give a total (e.g. chunked); fall back to reading the whole file.
  const all = await fetchAll(source);
  return all.length;
}

async function fetchAll(source: ArchiveSource): Promise<Uint8Array> {
  const headers: Record<string, string> = { ...(source.header || {}) };
  let r = await fetch(source.url, { method: 'GET', headers, redirect: 'manual' });
  let hops = 0;
  const redirectStatus = [301, 302, 303, 307, 308];
  while (redirectStatus.includes(r.status) && hops < 5) {
    const loc = r.headers.get('location');
    if (!loc) break;
    const next = new URL(loc, r.url);
    if (next.origin !== new URL(source.url).origin) {
      for (const k of Object.keys(headers)) {
        if (/^authorization$/i.test(k) || /^cookie$/i.test(k)) delete headers[k];
      }
    }
    r = await fetch(next.toString(), { method: 'GET', headers, redirect: 'manual' });
    hops++;
  }
  if (!r.ok) throw new Error(`archive fetch failed: ${r.status}`);
  const buf = await r.arrayBuffer();
  return new Uint8Array(buf);
}

export async function parseArchive(path: string, env: Env): Promise<ParsedArchive> {
  const source = await getArchiveSource(path, env);
  const fileSize = await getFileSize(source);
  const legacyCharset = await resolveLegacyCharset(env);
  const lower = path.toLowerCase();

  if (lower.endsWith('.zip')) {
    const r = await parseZipEntries(source, fileSize, legacyCharset);
    return { ...r, format: 'zip' };
  }
  if (lower.endsWith('.tar')) {
    const r = await parseTarEntries(source, fileSize, legacyCharset);
    return { ...r, format: 'tar' };
  }
  if (lower.endsWith('.tgz') || lower.endsWith('.tar.gz')) {
    const all = await fetchAll(source);
    const gunzipped = gunzipSync(all);
    const r = await parseTarEntriesFromBuffer(gunzipped, legacyCharset);
    return { ...r, format: 'tgz' };
  }
  if (lower.endsWith('.gz')) {
    const all = await fetchAll(source);
    gunzipSync(all); // validate
    return { entries: [], encrypted: false, comment: '', format: 'gzip' };
  }
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tar.xz') || lower.endsWith('.tbz2')) {
    throw new Error('this archive format is not supported on the Worker yet');
  }
  throw new Error('unsupported archive format');
}

async function parseTarEntriesFromBuffer(buf: Uint8Array, legacyCharset: string): Promise<{ entries: ArchiveEntry[]; encrypted: boolean; comment: string }> {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const name = decodeName(header.subarray(0, 100), legacyCharset).replace(/\0.*$/, '');
    const prefix = decodeName(header.subarray(345, 500), legacyCharset).replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const sizeStr = decodeName(header.subarray(124, 136), legacyCharset).replace(/[^0-9o]/gi, '');
    let size = 0;
    try { size = parseInt(sizeStr, 8) || 0; } catch { size = 0; }
    const typeflag = String.fromCharCode(header[156] || 0);
    const isDir = typeflag === '5' || (typeflag === '0' && full.endsWith('/'));
    entries.push({ name: fixPath('/' + full), is_dir: isDir, size, dataOffset: offset + 512 });
    offset += 512 + Math.ceil(size / 512) * 512;
    if (entries.length > 200000) break;
  }
  return { entries, encrypted: false, comment: '' };
}

export async function extractArchiveEntry(path: string, innerPath: string, env: Env): Promise<Uint8Array> {
  const source = await getArchiveSource(path, env);
  const fileSize = await getFileSize(source);
  const legacyCharset = await resolveLegacyCharset(env);
  const lower = path.toLowerCase();
  const target = fixPath(innerPath);

  if (lower.endsWith('.zip')) {
    const { entries } = await parseZipEntries(source, fileSize, legacyCharset);
    const entry = entries.find(e => fixPath(e.name) === target);
    if (!entry) throw new Error('file not found in archive');
    return extractZipEntry(source, entry);
  }
  if (lower.endsWith('.tar')) {
    const { entries } = await parseTarEntries(source, fileSize, legacyCharset);
    const entry = entries.find(e => fixPath(e.name) === target);
    if (!entry) throw new Error('file not found in archive');
    return extractTarEntry(source, entry);
  }
  if (lower.endsWith('.tgz') || lower.endsWith('.tar.gz')) {
    const all = await fetchAll(source);
    const gunzipped = gunzipSync(all);
    const { entries } = await parseTarEntriesFromBuffer(gunzipped, legacyCharset);
    const entry = entries.find(e => fixPath(e.name) === target);
    if (!entry) throw new Error('file not found in archive');
    return gunzipped.slice(entry.dataOffset!, entry.dataOffset! + entry.size);
  }
  throw new Error('unsupported archive format');
}

// Build the nested tree used by /api/fs/archive/meta.
export function buildArchiveTree(entries: ArchiveEntry[]): any[] {
  const root: any[] = [];
  const dirMap: Record<string, any[]> = { '/': root };

  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const e of sorted) {
    const p = fixPath(e.name);
    const parts = p.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let currentPath = '';
    let level = dirMap['/'];
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      currentPath += '/' + seg;
      const isLast = i === parts.length - 1;
      let node = level.find(n => n.name === seg);
      if (!node) {
        node = {
          name: seg,
          size: isLast && !e.is_dir ? e.size : 0,
          is_dir: isLast ? e.is_dir : true,
          modified: isLast && e.modified ? e.modified : new Date().toISOString(),
          created: isLast && e.modified ? e.modified : new Date().toISOString(),
          sign: '',
          thumb: '',
          type: isLast ? (e.is_dir ? 1 : 0) : 1,
          hashinfo: '',
          hash_info: {},
          children: [],
        };
        level.push(node);
      }
      if (i < parts.length - 1) {
        if (!node.children) node.children = [];
        level = node.children;
      }
    }
  }
  return root;
}
