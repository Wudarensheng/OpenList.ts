/**
 * 123云盘 (123 Open API) Driver
 * Referenced from OpenList's official drivers/123_open:
 * - Open API (https://open-api.123pan.com), Bearer token auth
 * - Token refreshed via online API or client credentials
 * - List with lastFileId pagination, download via download_info
 * - mkdir / rename / move / trash
 * - copy & upload via SHA1/ETag 秒传 (create API); real chunked upload is not
 *   ported, so non-instant copy/upload reports NotSupported
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const open123Config: DriverConfig = {
  name: '123Open',
  label: '123云盘',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '0',
};

export const open123Additional: DriverItem[] = [
  { name: 'ClientID', type: 'string', default: '', options: '', required: false, help: 'Client ID (apply at https://www.123pan.com/developer)' },
  { name: 'ClientSecret', type: 'string', default: '', options: '', required: false, help: 'Client secret' },
  { name: 'AccessToken', type: 'string', default: '', options: '', required: false, help: 'Access token (expires; prefer refresh token)' },
  { name: 'RefreshToken', type: 'string', default: '', options: '', required: false, help: 'Refresh token' },
  { name: 'use_online_api', type: 'bool', default: 'true', options: '', required: false, help: 'Use online API to refresh token' },
  { name: 'api_url_address', type: 'string', default: 'https://api.oplist.org/123cloud/renewapi', options: '', required: false, help: 'Online token refresh API address' },
  { name: 'root_folder_id', type: 'string', default: '0', options: '', required: false, help: 'Root folder id' },
  { name: 'DirectLink', type: 'bool', default: 'false', options: '', required: false, help: 'Use direct link when downloading' },
  { name: 'DirectLinkPrivateKey', type: 'string', default: '', options: '', required: false, help: 'Private key for direct link (URL authentication)' },
  { name: 'DirectLinkValidDuration', type: 'number', default: '30', options: '', required: false, help: 'Direct link valid duration (minutes)' },
];

const API = 'https://open-api.123pan.com';

interface BaseResp {
  code: number;
  message: string;
}

interface RefreshTokenResp extends BaseResp {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error_description?: string;
  text?: string;
  error?: string;
}

interface AccessTokenResp extends BaseResp {
  data?: { accessToken?: string; expiredAt?: string };
}

interface FileEntry {
  filename: string;
  size: number;
  createAt: string;
  updateAt: string;
  fileId: number;
  type: number; // 1 = dir, 2 = file
  etag: string;
  parentFileId: number;
  category: number;
  status: number;
  trashed: number;
  SHA1?: string;
}

interface FileListResp extends BaseResp {
  data?: { lastFileId: number; fileList: FileEntry[] };
}

interface DownloadInfoResp extends BaseResp {
  data?: { downloadUrl: string };
}

interface CreateResp extends BaseResp {
  data?: { fileID: number; preuploadID: string; reuse: boolean; sliceSize: number; servers: string[] };
}

/**
 * 123云盘 Driver Implementation
 */
export class Open123Driver implements Driver {
  private accessToken = '';
  private expiredAt = 0; // epoch ms
  private blockRefresh = false;
  private cfg: Record<string, any> = {};

  config(): DriverConfig {
    return open123Config;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.accessToken = cfg.AccessToken || '';
    this.blockRefresh = false;
    // Without a refresh path, assume the provided token lasts 90 days.
    this.expiredAt = this.accessToken ? Date.now() + 90 * 24 * 3600 * 1000 : 0;
    await this.getAccessToken(false);
  }

  private async getAccessToken(forceRefresh: boolean): Promise<string> {
    if (this.blockRefresh) {
      throw new Error('Authentication expired');
    }
    if (!forceRefresh && this.accessToken && Date.now() < this.expiredAt - 5 * 60 * 1000) {
      return this.accessToken;
    }
    await this.flushAccessToken();
    return this.accessToken;
  }

  private async flushAccessToken(): Promise<void> {
    // Online refresh API (no client credentials needed).
    if (this.cfg.use_online_api !== 'false' && this.cfg.RefreshToken && this.cfg.api_url_address) {
      const params = new URLSearchParams({
        refresh_ui: this.cfg.RefreshToken,
        server_use: 'true',
        driver_txt: '123cloud_oa',
      });
      const resp = await fetch(`${this.cfg.api_url_address}?${params.toString()}`);
      const body = await resp.json().catch(() => ({})) as RefreshTokenResp;
      if (!body.access_token || !body.refresh_token) {
        const msg = body.error_description || body.text || body.message || body.error || 'empty access_token or refresh_token returned from official API';
        throw new Error(`failed to refresh token: ${msg}`);
      }
      this.accessToken = body.access_token;
      this.cfg.RefreshToken = body.refresh_token;
      this.expiredAt = Date.now() + ((body.expires_in ?? 0) > 0 ? (body.expires_in as number) * 1000 : 90 * 24 * 3600 * 1000);
      this.blockRefresh = false;
      return;
    }
    // Developer API (client credentials).
    if (this.cfg.ClientID && this.cfg.ClientSecret) {
      const resp = await fetch(`${API}/api/v1/access_token`, {
        method: 'POST',
        headers: { 'platform': 'open_platform', 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientID: this.cfg.ClientID, clientSecret: this.cfg.ClientSecret }),
      });
      const body = await resp.json().catch(() => ({})) as AccessTokenResp;
      if (body.code !== 0 || !body.data?.accessToken || !body.data?.expiredAt) {
        throw new Error(`get access token failed: ${body.message || 'invalid token payload'}`);
      }
      this.accessToken = body.data.accessToken;
      this.expiredAt = new Date(body.data.expiredAt).getTime();
      this.blockRefresh = false;
      return;
    }
    throw new Error('no valid authentication method available');
  }

  // Unified request with Bearer auth, 401 -> force refresh + retry, 429 -> backoff.
  private async request(
    url: string,
    method: string,
    opts: { params?: Record<string, string>; body?: unknown } = {},
    retried = false
  ): Promise<any> {
    const token = await this.getAccessToken(false);
    const query = opts.params ? '?' + new URLSearchParams(opts.params).toString() : '';
    const init: RequestInit = {
      method,
      headers: {
        'authorization': `Bearer ${token}`,
        'platform': 'open_platform',
        'Content-Type': 'application/json',
      },
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const resp = await fetch(url + query, init);
    const body = await resp.json().catch(() => ({})) as any;
    if (body.code === 0) return body;
    if (body.code === 401) {
      if (retried) throw new Error(body.message || 'Unauthorized');
      await this.getAccessToken(true);
      return this.request(url, method, opts, true);
    }
    if (body.code === 429) {
      await new Promise(r => setTimeout(r, 500));
      return this.request(url, method, opts, retried);
    }
    throw new Error(body.message || `API error ${body.code}`);
  }

  // Resolve a path to a file id by walking each segment.
  private async getFileIdByPath(path: string): Promise<number> {
    const root = Number(this.cfg.root_folder_id || '0') || 0;
    const parts = path.split('/').filter(p => p);
    let currentId = root;
    for (const part of parts) {
      const resp = await this.request(`${API}/api/v2/file/list`, 'GET', {
        params: { parentFileId: String(currentId), limit: '100', lastFileId: '0', trashed: 'false' },
      }) as FileListResp;
      const found = (resp.data?.fileList || []).find(f => f.filename === part && f.trashed === 0);
      if (!found) {
        throw new Error(`123: path not found: ${path}`);
      }
      currentId = found.fileId;
    }
    return currentId;
  }

  private async listFiles(parentFileId: number): Promise<FileEntry[]> {
    const files: FileEntry[] = [];
    let lastFileId = 0;
    for (;;) {
      const resp = await this.request(`${API}/api/v2/file/list`, 'GET', {
        params: { parentFileId: String(parentFileId), limit: '100', lastFileId: String(lastFileId), trashed: 'false' },
      }) as FileListResp;
      for (const f of (resp.data?.fileList || [])) {
        if (f.trashed === 0) files.push(f);
      }
      const next = resp.data?.lastFileId ?? -1;
      if (next === -1 || next === lastFileId) break;
      lastFileId = next;
    }
    return files;
  }

  private parseCnTime(t: string): string {
    if (!t) return new Date().toISOString();
    const d = new Date(t.replace(' ', 'T') + '+08:00');
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const parentId = await this.getFileIdByPath(path);
    const files = await this.listFiles(parentId);
    const content = files.map(f => {
      const common = {
        name: f.filename,
        modified: this.parseCnTime(f.updateAt),
        created: this.parseCnTime(f.createAt),
        id: String(f.fileId),
      };
      return f.type === 1
        ? createDirObj(common)
        : createFileObj({ ...common, size: f.size || 0 });
    });
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const id = await this.getFileIdByPath(path);
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').pop() || path;
    const list = await this.listFiles(await this.getFileIdByPath(parent));
    const found = list.find(f => String(f.fileId) === String(id));
    if (found) {
      const common = { name: found.filename, modified: this.parseCnTime(found.updateAt), created: this.parseCnTime(found.createAt), id: String(found.fileId) };
      return found.type === 1 ? createDirObj(common) : createFileObj({ ...common, size: found.size || 0 });
    }
    return createFileObj({ name, modified: new Date().toISOString(), id: String(id) });
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const fileId = await this.getFileIdByPath(path);
    const resp = await this.request(`${API}/api/v1/file/download_info`, 'GET', {
      params: { fileId: String(fileId) },
    }) as DownloadInfoResp;
    if (!resp.data?.downloadUrl) {
      throw new Error('123: failed to get download url');
    }
    return { url: resp.data.downloadUrl };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').pop() || '';
    const parentId = await this.getFileIdByPath(parent);
    await this.request(`${API}/upload/v1/file/mkdir`, 'POST', {
      body: { parentID: String(parentId), name },
    });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const fileId = await this.getFileIdByPath(path);
    await this.request(`${API}/api/v1/file/name`, 'PUT', {
      body: { fileId, fileName: newName },
    });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcId = await this.getFileIdByPath(src);
    const dstParentId = await this.getFileIdByPath(dst);
    await this.request(`${API}/api/v1/file/move`, 'POST', {
      body: { fileIDs: [srcId], toParentFileID: dstParentId },
    });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcParent = src.substring(0, src.lastIndexOf('/')) || '/';
    const name = src.split('/').pop() || '';
    const srcFiles = await this.listFiles(await this.getFileIdByPath(srcParent));
    const srcFile = srcFiles.find(f => f.filename === name);
    if (!srcFile) throw new Error('123: source file not found');
    const sha1 = srcFile.SHA1 || '';
    if (!sha1) throw new Error('123: source has no SHA1, copy not supported');
    const dstParentId = await this.getFileIdByPath(dst);
    const resp = await this.request(`${API}/upload/v2/file/sha1_reuse`, 'POST', {
      body: { parentFileID: dstParentId, filename: name, sha1, size: srcFile.size, type: 2, lastWriteTime: '' },
    }) as CreateResp;
    if (!resp.data?.reuse) {
      throw new Error('123: copy not supported (chunked upload not ported)');
    }
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const fileId = await this.getFileIdByPath(path);
    await this.request(`${API}/api/v1/file/trash`, 'POST', {
      body: { fileIDs: [fileId] },
    });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').pop() || '';
    const parentId = await this.getFileIdByPath(parent);
    // Try SHA1 秒传 first (Web Crypto has SHA-1 but not MD5); real chunked
    // upload is not ported, so non-instant uploads report NotSupported.
    const sha1 = await this.sha1Hex(new Uint8Array(file));
    const resp = await this.request(`${API}/upload/v2/file/sha1_reuse`, 'POST', {
      body: { parentFileID: parentId, filename: name, sha1, size: file.byteLength, type: 2, lastWriteTime: '' },
    }) as CreateResp;
    if (resp.data?.reuse) return;
    throw new Error('123: upload not supported (chunked upload not ported)');
  }

  private async sha1Hex(data: Uint8Array): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-1', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

registerDriver(Open123Driver, open123Config, open123Additional);
