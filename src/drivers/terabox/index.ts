/**
 * TeraBox (Terabox) Driver
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/terabox.
 *
 * Cookie-authenticated path-based driver. Direct download links are either
 * signed via /api/download + /api/home/info ("official") or obtained through
 * /api/filemetas ("crack"). Upload uses the locateupload / precreate /
 * superfile2 chunk / create flow; MD5 is computed with an inlined pure-JS
 * RFC-1321 implementation (no external dependency).
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const teraboxConfig: DriverConfig = {
  name: 'Terabox',
  label: 'Terabox',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

export const teraboxAdditional: DriverItem[] = [
  { name: 'cookie', type: 'string', default: '', options: '', required: true, help: '登录 Cookie（从浏览器复制）' },
  { name: 'download_api', type: 'select', default: 'official', options: 'official,crack', required: false, help: '下载接口' },
  { name: 'root_folder_path', type: 'string', default: '/', options: '', required: false, help: '根文件夹路径，默认为 /' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,time,size', required: false, help: '排序字段' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: '排序方向' },
];

const TERABOX_UA = 'terabox;1.37.0.7;PC;PC-Windows;10.0.22631;WindowsTeraBox';

// ---------------------------------------------------------------- types

interface TeraboxFile {
  fs_id: number;
  server_mtime: number;
  thumbs?: { url3?: string };
  size: number;
  path: string;
  server_filename: string;
  isdir: number; // 1: dir, 0: file
}

interface TeraboxListResp {
  errno: number;
  guid_info?: string;
  list?: TeraboxFile[];
  guid?: number;
}

interface TeraboxDownloadResp {
  errno: number;
  dlink?: Array<{ dlink: string }>;
}

interface TeraboxDownloadResp2 {
  errno: number;
  info?: Array<{ dlink: string }>;
}

interface TeraboxHomeInfoResp {
  errno: number;
  data?: {
    sign1: string;
    sign3: string;
    timestamp: number;
  };
}

interface TeraboxPrecreateResp {
  path: string;
  uploadid: string;
  return_type: number;
  block_list: number[];
  errno: number;
}

interface TeraboxCheckLoginResp {
  errno: number;
}

interface TeraboxLocateUploadResp {
  host: string;
}

// ---------------------------------------------------------------- crypto / sign

// RFC 1321 pure-JS MD5 (dependency-free; SubtleCrypto does not support MD5).
function md5(input: string | Uint8Array): string {
  const msg = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const msgLen = msg.length;
  const bitLen = msgLen * 8;

  const padLen = (56 - ((msgLen + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(msgLen + 1 + padLen + 8);
  padded.set(msg);
  padded[msgLen] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  const T = new Int32Array(64);
  for (let i = 0; i < 64; i++) T[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;

  const r = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
  ];

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let i = 0; i < padded.length; i += 64) {
    const chunk = new DataView(padded.buffer, i, 64);
    const M = Array.from({ length: 16 }, (_, j) => chunk.getInt32(j * 4, true));
    let A = a0, B = b0, C = c0, D = d0;

    for (let j = 0; j < 64; j++) {
      let F: number, g: number;
      if (j < 16) { F = (B & C) | (~B & D); g = j; }
      else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
      else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * j) % 16; }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + T[j] + M[g]) | 0;
      B = (B + ((sum << r[j]) | (sum >>> (32 - r[j])))) | 0;
      A = tmp;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const result = new DataView(new ArrayBuffer(16));
  result.setInt32(0, a0, true);
  result.setInt32(4, b0, true);
  result.setInt32(8, c0, true);
  result.setInt32(12, d0, true);
  return Array.from(new Uint8Array(result.buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function teraboxSign(s1: string, s2: string): string {
  const a = new Array(256);
  const p = new Array(256);
  const o: number[] = [];
  const v = s1.length;

  for (let q = 0; q < 256; q++) {
    a[q] = s1.charCodeAt(q % v);
    p[q] = q;
  }

  let u = 0;
  for (let q = 0; q < 256; q++) {
    u = (u + p[q] + a[q]) % 256;
    const tmp = p[q];
    p[q] = p[u];
    p[u] = tmp;
  }

  let i = 0;
  u = 0;
  for (let q = 0; q < s2.length; q++) {
    i = (i + 1) % 256;
    u = (u + p[i]) % 256;
    const tmp = p[i];
    p[i] = p[u];
    p[u] = tmp;
    const k = p[(p[i] + p[u]) % 256];
    o.push(s2.charCodeAt(q) ^ k);
  }

  let binary = '';
  for (const b of o) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

/**
 * TeraBox Driver Implementation
 */
export class TeraboxDriver implements Driver {
  private cfg: Record<string, any> = {};
  private cookie = '';
  private baseUrl = 'https://www.terabox.com';
  private urlDomainPrefix = 'jp';
  private jsToken = '';

  config(): DriverConfig {
    return teraboxConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.cookie = String(cfg.cookie || '');
    this.baseUrl = 'https://www.terabox.com';
    this.urlDomainPrefix = 'jp';
    this.jsToken = '';
    if (!this.cookie.trim()) {
      throw new Error('Terabox cookie is required');
    }
    const check = await this.request<TeraboxCheckLoginResp>('/api/check/login', { method: 'GET' });
    if (check && check.errno !== 0) {
      if (check.errno === 9000) {
        throw new Error('TeraBox is not yet available in this area (errno 9000)');
      }
      throw new Error(
        `Failed to verify TeraBox login status according to cookie (errno ${check.errno})`,
      );
    }
  }

  private cleanPath(p: string): string {
    const s = '/' + (p || '').split('/').filter(Boolean).join('/');
    return s === '/' ? '/' : s;
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private async resetJsToken(): Promise<void> {
    const res = await fetch(this.baseUrl, {
      method: 'GET',
      headers: {
        Cookie: this.cookie,
        Accept: 'application/json, text/plain, */*',
        Referer: this.baseUrl,
        'User-Agent': TERABOX_UA,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch TeraBox home page: ${res.statusText}`);
    }

    const html = await res.text();
    const match = html.match(
      /`function%20fn%28a%29%7Bwindow.jsToken%20%3D%20a%7D%3Bfn%28%22([^"]+?)%22%29`/,
    );
    if (match && match[1]) {
      this.jsToken = match[1];
      return;
    }

    const simpleMatch = html.match(/jsToken\s*=\s*["']([^"']+)["']/);
    if (simpleMatch && simpleMatch[1]) {
      this.jsToken = simpleMatch[1];
      return;
    }

    // Default fallback jsToken if present in cookies or empty
    this.jsToken = '';
  }

  private async request<T = any>(
    pathOrUrl: string,
    options: {
      method?: string;
      params?: Record<string, string>;
      body?: any;
      isFormData?: boolean;
      retryCount?: number;
    } = {},
  ): Promise<T> {
    const {
      method = 'GET',
      params,
      body,
      isFormData = false,
      retryCount = 0,
    } = options;

    let fullUrl = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl}`;

    const queryParams: Record<string, string> = {
      app_id: '250528',
      web: '1',
      channel: 'dubox',
      clienttype: '0',
      ...(params || {}),
    };
    if (this.jsToken) {
      queryParams.jsToken = this.jsToken;
    }

    const q = new URLSearchParams(queryParams).toString();
    fullUrl += (fullUrl.includes('?') ? '&' : '?') + q;

    const headers: Record<string, string> = {
      Cookie: this.cookie,
      Accept: 'application/json, text/plain, */*',
      Referer: this.baseUrl,
      'User-Agent': TERABOX_UA,
      'X-Requested-With': 'XMLHttpRequest',
    };

    let requestBody: any = body;
    if (isFormData && body && !(body instanceof FormData)) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        form.set(k, String(v));
      }
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      requestBody = form.toString();
    } else if (
      body &&
      typeof body === 'object' &&
      !(body instanceof FormData) &&
      !(body instanceof Uint8Array)
    ) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(body);
    }

    const res = await fetch(fullUrl, {
      method,
      headers,
      body: requestBody,
    });

    const text = await res.text();
    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (data && typeof data === 'object' && data.errno !== undefined) {
      const errno = Number(data.errno);
      if ((errno === 4000023 || errno === 450016) && retryCount < 2) {
        await this.resetJsToken();
        return this.request<T>(pathOrUrl, {
          ...options,
          retryCount: retryCount + 1,
        });
      }
      if (errno === -6 && retryCount < 2) {
        const prefix = res.headers.get('url-domain-prefix');
        if (prefix) {
          this.urlDomainPrefix = prefix;
          this.baseUrl = `https://${prefix}.terabox.com`;
          return this.request<T>(pathOrUrl, {
            ...options,
            retryCount: retryCount + 1,
          });
        }
      }
    }

    return data as T;
  }

  private async genSign(): Promise<string> {
    const home = await this.request<TeraboxHomeInfoResp>('/api/home/info', {
      method: 'GET',
    });
    if (!home.data || !home.data.sign1 || !home.data.sign3) {
      throw new Error('Failed to get TeraBox sign keys from home/info');
    }
    return teraboxSign(home.data.sign3, home.data.sign1);
  }

  private async linkOfficial(fsId: string | number): Promise<string> {
    const signString = await this.genSign();
    const params = {
      type: 'dlink',
      fidlist: `[${fsId}]`,
      sign: signString,
      vip: '2',
      timestamp: String(Math.floor(Date.now() / 1000)),
    };

    const resp = await this.request<TeraboxDownloadResp>('/api/download', {
      method: 'GET',
      params,
    });

    if (!resp.dlink || resp.dlink.length === 0) {
      throw new Error(
        `TeraBox fid ${fsId} no dlink found (errno: ${resp.errno})`,
      );
    }

    // Follow first redirect to get direct URL without downloading content
    const dlink = resp.dlink[0].dlink;
    const headRes = await fetch(dlink, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Cookie: this.cookie,
        'User-Agent': TERABOX_UA,
      },
    });

    const loc = headRes.headers.get('location');
    return loc || dlink;
  }

  private async linkCrack(path: string): Promise<string> {
    const params = {
      target: JSON.stringify([path]),
      dlink: '1',
      origin: 'dlna',
    };

    const resp = await this.request<TeraboxDownloadResp2>('/api/filemetas', {
      method: 'GET',
      params,
    });

    if (!resp.info || resp.info.length === 0 || !resp.info[0].dlink) {
      throw new Error(`TeraBox crack download failed for ${path}`);
    }

    return resp.info[0].dlink;
  }

  private async manage(opera: string, filelist: any): Promise<any> {
    const listJson = JSON.stringify(filelist);
    return this.request('/api/filemanager', {
      method: 'POST',
      params: {
        onnest: 'fail',
        opera,
      },
      isFormData: true,
      body: {
        async: '0',
        filelist: listJson,
        ondup: 'newcopy',
      },
    });
  }

  // ---------------------------------------------------------------- mapping

  private fileToObj(f: TeraboxFile): Obj {
    const isDir = f.isdir === 1;
    const common = {
      name: f.server_filename,
      size: f.size || 0,
      modified: f.server_mtime
        ? new Date(f.server_mtime * 1000).toISOString()
        : this.nowIso(),
      thumb: f.thumbs?.url3 || undefined,
      id: String(f.fs_id),
    };
    return isDir ? createDirObj(common) : createFileObj(common);
  }

  private sortItems(items: Obj[]): Obj[] {
    const asc = String(this.cfg.order_direction || '') !== 'desc';
    const key = String(this.cfg.order_by || 'name').toLowerCase();
    return [...items].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let cmp: number;
      if (key.includes('size')) {
        cmp = (a.size || 0) - (b.size || 0);
      } else if (key.includes('time') || key.includes('modified')) {
        cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
      } else {
        cmp = String(a.name).localeCompare(String(b.name));
      }
      return asc ? cmp : -cmp;
    });
  }

  // Find one file entry under a directory (single page, mirrors reference get()).
  private async findInDir(dir: string, fileName: string): Promise<TeraboxFile | undefined> {
    const resp = await this.request<TeraboxListResp>('/api/list', {
      method: 'GET',
      params: {
        dir: this.cleanPath(dir),
        page: '1',
        num: '1000',
      },
    });
    return resp.list?.find((f) => f.server_filename === fileName);
  }

  // ---------------------------------------------------------------- operations

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const clean = this.cleanPath(path);
    const allFiles: TeraboxFile[] = [];
    let page = 1;
    const num = 100;

    for (;;) {
      const params: Record<string, string> = {
        dir: clean,
        page: String(page),
        num: String(num),
      };
      if (this.cfg.order_by) {
        params.order = this.cfg.order_by;
        if (this.cfg.order_direction === 'desc') {
          params.desc = '1';
        }
      }

      const resp = await this.request<TeraboxListResp>('/api/list', {
        method: 'GET',
        params,
      });

      if (resp.errno === 9000) {
        throw new Error('TeraBox is not yet available in this area');
      }

      if (!resp.list || resp.list.length === 0) {
        break;
      }

      allFiles.push(...resp.list);
      page++;
    }

    const content = allFiles.map(f => this.fileToObj(f));
    return { content: this.sortItems(content), total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const clean = this.cleanPath(path);
    const name = clean.split('/').filter(Boolean).pop() || 'root';

    if (clean === '/') {
      return createDirObj({ name: 'root', modified: this.nowIso(), id: '0' });
    }

    const parentDir = clean.split('/').slice(0, -1).join('/') || '/';
    const fileName = clean.split('/').pop() || '';

    const resp = await this.request<TeraboxListResp>('/api/list', {
      method: 'GET',
      params: {
        dir: parentDir,
        page: '1',
        num: '1000',
      },
    });

    const found = resp.list?.find((f) => f.server_filename === fileName);
    if (!found) {
      return createFileObj({ name, size: 0, modified: this.nowIso() });
    }

    return this.fileToObj(found);
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const clean = this.cleanPath(path);
    const fileName = clean.split('/').filter(Boolean).pop() || '';
    const parentDir = clean.split('/').slice(0, -1).join('/') || '/';

    const found = await this.findInDir(parentDir, fileName);
    if (!found) {
      throw new Error(`TeraBox file not found: ${clean}`);
    }
    if (found.isdir === 1) {
      throw new Error(`Cannot get link for directory: ${clean}`);
    }

    const url =
      this.cfg.download_api === 'crack'
        ? await this.linkCrack(clean)
        : await this.linkOfficial(found.fs_id);

    return { url, header: { 'User-Agent': TERABOX_UA } };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const clean = this.cleanPath(path);
    await this.request('/api/create', {
      method: 'POST',
      isFormData: true,
      params: { a: 'commit' },
      body: {
        path: clean,
        isdir: '1',
        block_list: '[]',
      },
    });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const clean = this.cleanPath(path);
    await this.manage('rename', [
      {
        path: clean,
        newname: newName,
      },
    ]);
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const clean = this.cleanPath(path);
    await this.manage('delete', [clean]);
  }

  private dstDirOf(dst: string): string {
    const clean = this.cleanPath(dst);
    const i = clean.lastIndexOf('/');
    return i <= 0 ? '/' : clean.substring(0, i);
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcClean = this.cleanPath(src);
    const dstClean = this.dstDirOf(dst);
    const name = srcClean.split('/').filter(Boolean).pop() || '';

    await this.manage('move', [
      {
        path: srcClean,
        dest: dstClean,
        newname: name,
      },
    ]);
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcClean = this.cleanPath(src);
    const dstClean = this.dstDirOf(dst);
    const name = srcClean.split('/').filter(Boolean).pop() || '';

    await this.manage('copy', [
      {
        path: srcClean,
        dest: dstClean,
        newname: name,
      },
    ]);
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    if (!this.cookie) {
      throw new Error('TeraBox 上传需要 Cookie 登录，请填写 Cookie');
    }

    const clean = this.cleanPath(path);
    const parentPath = clean.split('/').slice(0, -1).join('/') || '/';
    const fileName = clean.split('/').filter(Boolean).pop() || 'upload';
    const bytes = new Uint8Array(file);

    const locateRes = await fetch(
      'https://jp-data.terabox.com/rest/2.0/pcs/file?method=locateupload',
    );
    const locateData = (await locateRes.json()) as TeraboxLocateUploadResp;
    const uploadHost = locateData.host || 'd.terabox.com';

    const contentMd5 = md5(bytes);
    const precreateBody = {
      path: clean,
      autoinit: '1',
      target_path: parentPath,
      block_list: JSON.stringify([contentMd5]),
      local_mtime: String(Math.floor(Date.now() / 1000)),
      file_limit_switch_v34: 'true',
    };

    const precreateRes = await this.request<TeraboxPrecreateResp>('/api/precreate', {
      method: 'POST',
      isFormData: true,
      body: precreateBody,
    });

    if (precreateRes.errno !== 0) {
      throw new Error(`TeraBox precreate failed (errno: ${precreateRes.errno})`);
    }

    // Direct rapid return
    if (precreateRes.return_type === 2) {
      return;
    }

    const uploadUrl = `https://${uploadHost}/rest/2.0/pcs/superfile2?method=upload&path=${encodeURIComponent(clean)}&uploadid=${encodeURIComponent(precreateRes.uploadid)}&partseq=0`;

    const formData = new FormData();
    formData.append(
      'file',
      new Blob([bytes], { type: 'application/octet-stream' }),
      fileName,
    );

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Cookie: this.cookie,
        'User-Agent': TERABOX_UA,
      },
      body: formData,
    });

    if (!uploadRes.ok) {
      throw new Error(`TeraBox upload chunk failed: ${uploadRes.statusText}`);
    }

    const createBody = {
      path: clean,
      size: String(bytes.length),
      uploadid: precreateRes.uploadid,
      target_path: parentPath,
      block_list: JSON.stringify([contentMd5]),
      local_mtime: String(Math.floor(Date.now() / 1000)),
    };

    await this.request('/api/create', {
      method: 'POST',
      isFormData: true,
      params: {
        isdir: '0',
        rtype: '1',
      },
      body: createBody,
    });
  }
}

registerDriver(TeraboxDriver, teraboxConfig, teraboxAdditional);
