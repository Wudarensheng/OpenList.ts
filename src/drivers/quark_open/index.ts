/**
 * 夸克网盘 (Quark Open API) Driver
 * Referenced from OpenList's official drivers/quark_open:
 * - Signed requests: x-pan-token = sha256(method&path&timestamp&sign_key)
 * - Token refreshed via online API on 11001 / 14001 errors
 * - List with query_cursor pagination, download via get_download_url
 * - mkdir / rename / move / delete
 * - Upload (with proof generation) and copy are not ported; see no_upload.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const quarkOpenConfig: DriverConfig = {
  name: 'QuarkOpen',
  label: '夸克网盘',
  local_sort: true,
  only_proxy: true,
  no_cache: false,
  no_upload: true,
  default_root: '0',
};

export const quarkOpenAdditional: DriverItem[] = [
  { name: 'root_folder_id', type: 'string', default: '0', options: '', required: false, help: 'Root folder id' },
  { name: 'order_by', type: 'select', default: 'none', options: 'none,file_type,file_name,updated_at,created_at', required: false, help: 'Sort field' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: 'Sort direction' },
  { name: 'use_online_api', type: 'bool', default: 'true', options: '', required: false, help: 'Use online API to refresh token' },
  { name: 'api_url_address', type: 'string', default: 'https://api.oplist.org/quarkyun/renewapi', options: '', required: false, help: 'Online token refresh API address' },
  { name: 'access_token', type: 'string', default: '', options: '', required: false, help: 'Access token' },
  { name: 'refresh_token', type: 'string', default: '', options: '', required: true, help: 'Refresh token' },
  { name: 'app_id', type: 'string', default: '', options: '', required: true, help: 'App id (keep empty if you do not have one)' },
  { name: 'sign_key', type: 'string', default: '', options: '', required: true, help: 'Sign key (keep empty if you do not have one)' },
];

const API = 'https://open-api-drive.quark.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

interface QueryCursor {
  version?: string;
  token?: string;
}

interface QuarkFile {
  fid: string;
  parent_fid: string;
  category: number;
  filename: string;
  size: number;
  file_type: string; // "0" = dir
  thumbnail_url: string;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

interface FileListResp {
  status: number;
  errno: number;
  error_info: string;
  data: { file_list: QuarkFile[]; last_page: boolean; next_query_cursor: QueryCursor };
}

interface DownloadResp {
  status: number;
  errno: number;
  error_info: string;
  data: { download_url: string };
}

/**
 * 夸克网盘 Driver Implementation
 */
export class QuarkOpenDriver implements Driver {
  private accessToken = '';
  private refreshToken = '';
  private cfg: Record<string, any> = {};

  config(): DriverConfig {
    return quarkOpenConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.accessToken = cfg.access_token || '';
    this.refreshToken = cfg.refresh_token || '';
    if (this.cfg.use_online_api === 'false') {
      throw new Error('quark_open: local token refresh is not implemented, please use online API');
    }
    // Validate the access token by fetching the user profile (mirrors Go Init).
    try {
      await this.request('/open/v1/user/info', 'GET');
    } catch {
      // Token may be expired; a forced refresh keeps the driver usable.
      await this.refreshTokenNow();
    }
  }

  // 13-digit millisecond timestamp.
  private nowMs(): string {
    return String(Date.now());
  }

  private randomReqId(): string {
    return crypto.randomUUID();
  }

  // x-pan-token = sha256(method&pathname&timestamp&signKey)
  private async sign(method: string, pathname: string): Promise<{ tm: string; token: string; reqId: string }> {
    const tm = this.nowMs();
    const data = `${method}&${pathname}&${tm}&${this.cfg.sign_key || ''}`;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    const token = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return { tm, token, reqId: this.randomReqId() };
  }

  private async request(pathname: string, method: string, body?: unknown, retried = false): Promise<any> {
    const { tm, token, reqId } = await this.sign(method, pathname);
    const query = new URLSearchParams({ req_id: reqId, access_token: this.accessToken }).toString();
    const init: RequestInit = {
      method,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': UA,
        'x-pan-tm': tm,
        'x-pan-token': token,
        'x-pan-client-id': this.cfg.app_id || '',
      },
    };
    if (body !== undefined) {
      init.headers = { ...init.headers as Record<string, string>, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(`${API}${pathname}?${query}`, init);
    const data = await resp.json().catch(() => ({})) as any;
    const status = data.status ?? 0;
    const errno = data.errno ?? 0;
    if (status === -1 && (errno === 11001 || (errno === 14001 && String(data.error_info || '').includes('access_token')))) {
      if (retried) throw new Error(data.error_info || 'quark_open: token expired');
      await this.refreshTokenNow();
      return this.request(pathname, method, body, true);
    }
    if (status >= 400 || errno !== 0) {
      throw new Error(data.error_info || `quark_open: API error (status ${status}, errno ${errno})`);
    }
    return data;
  }

  private async refreshTokenNow(): Promise<void> {
    if (!this.cfg.api_url_address) {
      throw new Error('quark_open: no token refresh API configured');
    }
    const params = new URLSearchParams({
      refresh_ui: this.refreshToken,
      server_use: 'true',
      driver_txt: 'quarkyun_oa',
    });
    const resp = await fetch(`${this.cfg.api_url_address}?${params.toString()}`);
    const body: any = await resp.json().catch(() => ({}));
    if (!body.refresh_token || !body.access_token) {
      throw new Error(body.text || 'empty token returned from official API, a wrong refresh token may have been used');
    }
    this.refreshToken = body.refresh_token;
    this.accessToken = body.access_token;
  }

  private async getFiles(parentFid: string): Promise<QuarkFile[]> {
    const files: QuarkFile[] = [];
    let cursor: QueryCursor | undefined;
    for (;;) {
      const sort = this.cfg.order_by && this.cfg.order_by !== 'none'
        ? `${this.cfg.order_by}:${this.cfg.order_direction || 'asc'}`
        : 'file_name:asc';
      const body: Record<string, unknown> = { parent_fid: parentFid, size: 100, sort };
      if (cursor?.token) body.query_cursor = cursor;
      const resp = await this.request('/open/v1/file/list', 'POST', body) as FileListResp;
      files.push(...(resp.data?.file_list || []));
      if (resp.data?.last_page) break;
      cursor = resp.data?.next_query_cursor;
      if (!cursor?.token) break;
    }
    return files;
  }

  // Resolve a path to a fid by walking each segment.
  private async getFidByPath(path: string): Promise<string> {
    const root = this.cfg.root_folder_id || '0';
    const parts = path.split('/').filter(p => p);
    let currentFid = root;
    for (const part of parts) {
      const files = await this.getFiles(currentFid);
      const found = files.find(f => f.filename === part);
      if (!found) {
        throw new Error(`quark_open: path not found: ${path}`);
      }
      currentFid = found.fid;
    }
    return currentFid;
  }

  private fileToObj(f: QuarkFile): Obj {
    const common = {
      name: f.filename,
      size: f.size || 0,
      modified: f.updated_at ? new Date(f.updated_at).toISOString() : new Date().toISOString(),
      created: f.created_at ? new Date(f.created_at).toISOString() : undefined,
      thumb: f.thumbnail_url || undefined,
      id: f.fid,
    };
    return f.file_type === '0'
      ? createDirObj(common)
      : createFileObj(common);
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const parentFid = await this.getFidByPath(path);
    const files = await this.getFiles(parentFid);
    const content = files.map(f => this.fileToObj(f));
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const fid = await this.getFidByPath(path);
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const files = await this.getFiles(await this.getFidByPath(parent));
    const found = files.find(f => f.fid === fid);
    if (found) return this.fileToObj(found);
    const name = path.split('/').pop() || path;
    return createFileObj({ name, modified: new Date().toISOString(), id: fid });
  }

  // Download link. The CDN requires the auth cookie header (mirrors Go Link()).
  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const fid = await this.getFidByPath(path);
    const resp = await this.request('/open/v1/file/get_download_url', 'POST', { fid }) as DownloadResp;
    if (!resp.data?.download_url) {
      throw new Error('quark_open: failed to get download url');
    }
    return {
      url: resp.data.download_url,
      header: {
        'Cookie': `x_pan_client_id=${this.cfg.app_id || ''}; x_pan_access_token=${this.accessToken}`,
      },
    };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').pop() || '';
    const parentFid = await this.getFidByPath(parent);
    await this.request('/open/v1/dir', 'POST', { dir_path: name, pdir_fid: parentFid });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const fid = await this.getFidByPath(path);
    await this.request('/open/v1/file/rename', 'POST', { fid, file_name: newName, conflict_mode: 'REUSE' });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcFid = await this.getFidByPath(src);
    const dstFid = await this.getFidByPath(dst);
    await this.request('/open/v1/file/move', 'POST', { action_type: 1, fid_list: [srcFid], to_pdir_fid: dstFid });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('quark_open: copy not supported');
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const fid = await this.getFidByPath(path);
    await this.request('/open/v1/file/delete', 'POST', { action_type: 1, fid_list: [fid] });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('quark_open: upload not supported (proof/chunked upload not ported)');
  }
}

registerDriver(QuarkOpenDriver, quarkOpenConfig, quarkOpenAdditional);
