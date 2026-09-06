/**
 * 夸克网盘 / UC网盘 (Quark Cookie) Driver
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/quark.
 *
 * Cookie-authenticated driver for Quark (drive-m.quark.cn) and UC
 * (pc-api.uc.cn). Paths are resolved by walking folder listings from
 * root_folder_id (default '0'). Download URL requests must be made with the
 * account Cookie + Referer (the fs layer proxies when link returns a header).
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const quarkConfig: DriverConfig = {
  name: 'Quark',
  label: '夸克网盘(Cookie)',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: true,
  default_root: '0',
};

export const quarkAdditional: DriverItem[] = [
  { name: 'variant', type: 'select', default: 'Quark', options: 'Quark,UC', required: false, help: '网盘类型: 夸克 or UC' },
  { name: 'cookie', type: 'string', default: '', options: '', required: true, help: '登录 Cookie（从浏览器复制）' },
  { name: 'root_folder_id', type: 'string', default: '0', options: '', required: false, help: '根目录文件夹 ID，默认为 0 (根目录)' },
  { name: 'order_by', type: 'select', default: 'none', options: 'none,file_type,file_name,updated_at', required: false, help: '排序字段' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: '排序方向' },
  { name: 'use_transcoding_address', type: 'bool', default: 'false', options: '', required: false, help: '转码地址（仅 Quark，需配合代理使用）' },
  { name: 'only_list_video_file', type: 'bool', default: 'false', options: '', required: false, help: '仅列出视频文件和文件夹' },
];

type QuarkVariant = 'Quark' | 'UC';

interface QuarkConf {
  ua: string;
  referer: string;
  api: string;
  pr: string;
}

const QUARK_CONF: QuarkConf = {
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch',
  referer: 'https://pan.quark.cn',
  api: 'https://drive-m.quark.cn/1/clouddrive',
  pr: 'ucpro',
};

const UC_CONF: QuarkConf = {
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch',
  referer: 'https://drive.uc.cn',
  api: 'https://pc-api.uc.cn/1/clouddrive',
  pr: 'UCBrowser',
};

interface QuarkFile {
  fid: string;
  file_name: string;
  pdir_fid: string;
  category: number;
  size: number;
  /** true = file, false / undefined = folder */
  file: boolean;
  created_at: number;
  updated_at: number;
  thumbnail?: string;
}

interface QuarkResp {
  status: number;
  code: number;
  message: string;
  msg?: string;
}

interface QuarkSortResp extends QuarkResp {
  data: { list: QuarkFile[] };
  metadata: { size: number; page: number; count: number; total: number };
}

interface QuarkDownloadItem {
  fid: string;
  file_name: string;
  download_url: string;
}

interface QuarkDownResp extends QuarkResp {
  data: QuarkDownloadItem[];
}

interface QuarkMkdirData {
  fid: string;
  file_name: string;
}

interface QuarkMkdirResp extends QuarkResp {
  data: QuarkMkdirData[];
}

// ---------------------------------------------------------------- cookie utils

function setCookieValue(cookieStr: string, key: string, value: string): string {
  const parts = cookieStr.split(';').map(p => p.trim()).filter(Boolean);
  const existing = parts.findIndex(p => {
    const idx = p.indexOf('=');
    return idx !== -1 && p.substring(0, idx).trim() === key;
  });
  const newPart = `${key}=${value}`;
  if (existing !== -1) {
    parts[existing] = newPart;
  } else {
    parts.push(newPart);
  }
  return parts.join('; ');
}

function extractCookieFromSetCookie(header: string, name: string): string | null {
  // Multiple Set-Cookie headers may be joined by comma or newline
  const segments = header.split(/,(?=[^;]+=[^;]+)/);
  for (const seg of segments) {
    const parts = seg.split(';');
    const kv = parts[0].trim();
    const eqIdx = kv.indexOf('=');
    if (eqIdx !== -1) {
      const k = kv.substring(0, eqIdx).trim();
      if (k === name) {
        return kv.substring(eqIdx + 1).trim();
      }
    }
  }
  return null;
}

/** Simple HTML entity unescaping (matching Go's html.UnescapeString for common cases) */
function unescapeHtml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function decodePart(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 夸克网盘(Cookie) Driver Implementation
 */
export class QuarkDriver implements Driver {
  private cfg: Record<string, any> = {};
  private cookie = '';
  private pathFileIdCache = new Map<string, string>();

  config(): DriverConfig {
    return quarkConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.cookie = String(cfg.cookie || '').trim();
    this.pathFileIdCache = new Map();
    if (!this.cookie) {
      throw new Error('quark: cookie is required');
    }
    // Best-effort cookie validation (mirrors reference init via /config).
    try {
      await this.request<QuarkResp>('/config', 'GET');
    } catch {
      // A stale cookie will surface as an API error on real operations.
    }
  }

  private variant(): QuarkVariant {
    return this.cfg.variant === 'UC' ? 'UC' : 'Quark';
  }

  private conf(): QuarkConf {
    return this.variant() === 'UC' ? UC_CONF : QUARK_CONF;
  }

  private rootFolderId(): string {
    const id = String(this.cfg.root_folder_id || '').trim();
    return id || '0';
  }

  private cleanPath(p: string): string {
    const s = '/' + (p || '').split('/').filter(Boolean).join('/');
    return s === '/' ? '/' : s;
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  // ---- Core request method ----

  private async request<T = any>(
    pathname: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    queryParams?: Record<string, string>,
    body?: any,
  ): Promise<T> {
    const conf = this.conf();
    const url = new URL(conf.api + pathname);
    url.searchParams.set('pr', conf.pr);
    url.searchParams.set('fr', 'pc');
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      Cookie: this.cookie,
      Accept: 'application/json, text/plain, */*',
      Referer: conf.referer,
      'Content-Type': 'application/json',
      'User-Agent': conf.ua,
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
    };
    if (body !== undefined && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    const res = await fetch(url.toString(), fetchOptions);

    // Update __puus cookie if server refreshes it
    const setCookieHeader = res.headers.get('set-cookie');
    if (setCookieHeader) {
      const puus = extractCookieFromSetCookie(setCookieHeader, '__puus');
      if (puus) {
        this.cookie = setCookieValue(this.cookie, '__puus', puus);
      }
      // Quark transcoding also refreshes __pus
      if (this.variant() === 'Quark') {
        const pus = extractCookieFromSetCookie(setCookieHeader, '__pus');
        if (pus) {
          this.cookie = setCookieValue(this.cookie, '__pus', pus);
        }
      }
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (
      !res.ok ||
      (data.status !== undefined && data.status >= 400) ||
      (data.code !== undefined && data.code !== 0)
    ) {
      const msg = data.message || data.msg || `HTTP ${res.status}`;
      throw new Error(`[Quark/UC] API error [${res.status}] ${pathname}: ${msg}`);
    }
    return data as T;
  }

  // ---- File listing ----

  private async getFiles(parentId: string): Promise<QuarkFile[]> {
    const files: QuarkFile[] = [];
    let page = 1;
    const size = 100;

    const query: Record<string, string> = {
      pdir_fid: parentId,
      _size: String(size),
      _fetch_total: '1',
      fetch_all_file: '1',
      fetch_risk_file_name: '1',
    };

    const orderBy = this.cfg.order_by;
    if (orderBy && orderBy !== 'none') {
      const dir = this.cfg.order_direction || 'asc';
      query._sort = `file_type:asc,${orderBy}:${dir}`;
    }

    for (;;) {
      query._page = String(page);
      const resp = await this.request<QuarkSortResp>('/file/sort', 'GET', query);
      const list = resp?.data?.list || [];
      if (list.length === 0) break;

      for (const file of list) {
        // HTML-unescape file names (the Go source does html.UnescapeString)
        file.file_name = unescapeHtml(file.file_name);

        if (this.cfg.only_list_video_file === true || this.cfg.only_list_video_file === 'true') {
          // Only include videos (category === 1) and folders
          if (!file.file || file.category === 1) {
            files.push(file);
          }
        } else {
          files.push(file);
        }
      }

      const total = resp.metadata?.total ?? 0;
      if (total > 0 && page * size >= total) break;
      if (list.length < size) break;
      page++;
    }

    return files;
  }

  // ---- Path resolution ----

  private async resolveFileId(path: string): Promise<string> {
    const clean = this.cleanPath(path);
    const parts = clean.split('/').filter(Boolean);
    if (parts.length === 0) return this.rootFolderId();

    const cacheKey = '/' + parts.join('/');
    const cached = this.pathFileIdCache.get(cacheKey);
    if (cached) return cached;

    let currentId = this.rootFolderId();
    for (let i = 0; i < parts.length; i++) {
      const rawPart = parts[i];
      const decodedPart = decodePart(rawPart);

      const items = await this.getFiles(currentId);
      const target = items.find(
        (f) =>
          f.file_name === rawPart ||
          f.file_name === decodedPart ||
          f.fid === rawPart,
      );
      if (!target) {
        throw new Error(`[Quark/UC] Path '${rawPart}' not found in folder '${currentId}'`);
      }
      currentId = target.fid;
      this.pathFileIdCache.set('/' + parts.slice(0, i + 1).join('/'), currentId);
    }

    return currentId;
  }

  private fileToObj(f: QuarkFile): Obj {
    const isDir = !f.file;
    const modified = f.updated_at ? new Date(f.updated_at).toISOString() : this.nowIso();
    const created = f.created_at ? new Date(f.created_at).toISOString() : undefined;
    const common = {
      name: f.file_name,
      size: f.size || 0,
      modified,
      created,
      thumb: f.thumbnail || undefined,
      id: f.fid,
    };
    return isDir ? createDirObj(common) : createFileObj(common);
  }

  // ---- Download link ----

  private async getDownloadUrl(
    fileId: string,
    fileName: string,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const resp = await this.request<QuarkDownResp>('/file/download', 'POST', undefined, {
      fids: [fileId],
    });

    const item = resp.data?.[0];
    if (!item?.download_url) {
      throw new Error(`[Quark/UC] No download_url for file: ${fileName}`);
    }

    const conf = this.conf();
    return {
      url: item.download_url,
      headers: {
        Cookie: this.cookie,
        Referer: conf.referer,
        'User-Agent': conf.ua,
      },
    };
  }

  // ---- StorageDriver operations ----

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const folderId = await this.resolveFileId(this.cleanPath(path));
    const files = await this.getFiles(folderId);
    const content = files.map(f => this.fileToObj(f));
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const clean = this.cleanPath(path);
    const parts = clean.split('/').filter(Boolean);
    const rawName = parts[parts.length - 1];
    const name = rawName ? decodePart(rawName) : 'root';

    const fileId = await this.resolveFileId(clean);
    if (parts.length === 0) {
      return createDirObj({ name: 'root', modified: this.nowIso(), id: fileId });
    }

    const parentPath = '/' + parts.slice(0, parts.length - 1).join('/');
    const parentId = await this.resolveFileId(parentPath);
    const files = await this.getFiles(parentId);
    const file = files.find(
      (f) => f.fid === fileId || f.file_name === rawName || f.file_name === name,
    );
    if (file) return this.fileToObj(file);

    // Fallback: probe the item by listing it — a successful listing means a folder.
    try {
      await this.getFiles(fileId);
      return createDirObj({ name, modified: this.nowIso(), id: fileId });
    } catch {
      return createFileObj({ name, size: 0, modified: this.nowIso(), id: fileId });
    }
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const clean = this.cleanPath(path);
    const name = decodePart(clean.split('/').filter(Boolean).pop() || clean);
    const fileId = await this.resolveFileId(clean);
    const { url, headers } = await this.getDownloadUrl(fileId, name);
    return { url, header: headers };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const clean = this.cleanPath(path);
    const parts = clean.split('/').filter(Boolean);
    const name = parts.pop() || '新文件夹';
    const parentPath = '/' + parts.join('/');
    const parentId = await this.resolveFileId(parentPath);
    const resp = await this.request<QuarkMkdirResp>('/file', 'POST', undefined, {
      dir_init_lock: false,
      dir_path: '',
      file_name: name,
      pdir_fid: parentId,
    });
    const fid = resp.data?.[0]?.fid;
    if (fid) this.pathFileIdCache.set(clean, fid);
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const fileId = await this.resolveFileId(this.cleanPath(path));
    await this.request('/file/rename', 'POST', undefined, {
      fid: fileId,
      file_name: newName,
    });
  }

  private async dstDirId(dst: string): Promise<string> {
    // fs passes the full destination path (dir + name); the API wants the
    // destination directory id.
    const clean = this.cleanPath(dst);
    const i = clean.lastIndexOf('/');
    const dirPath = i <= 0 ? '/' : clean.substring(0, i);
    return this.resolveFileId(dirPath);
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const fileId = await this.resolveFileId(this.cleanPath(src));
    const dstId = await this.dstDirId(dst);
    await this.request('/file/move', 'POST', undefined, {
      filelist: [fileId],
      to_pdir_fid: dstId,
    });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const fileId = await this.resolveFileId(this.cleanPath(src));
    const dstId = await this.dstDirId(dst);
    await this.request('/file/copy', 'POST', undefined, {
      filelist: [fileId],
      to_pdir_fid: dstId,
    });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const fileId = await this.resolveFileId(this.cleanPath(path));
    await this.request('/file/delete', 'POST', undefined, {
      action_type: 2,
      filelist: [fileId],
      exclude_fids: [],
    });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('[Quark/UC] Direct put not supported in stateless environment');
  }
}

registerDriver(QuarkDriver, quarkConfig, quarkAdditional);
