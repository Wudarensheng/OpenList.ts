/**
 * 123 云盘分享 (Pan123 Share) Driver — read-only
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/123_share.
 *
 * Browse/links of a share key via https://yun.123pan.com/b/api/share/*.
 * Requests are signed with a crc32-based signPath; download info may return a
 * base64 `params` payload that must be decoded into the real CDN URL.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const pan123ShareConfig: DriverConfig = {
  name: '123Share',
  label: '123云盘分享',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: true,
  default_root: '0',
};

export const pan123ShareAdditional: DriverItem[] = [
  { name: 'sharekey', type: 'string', default: '', options: '', required: true, help: '分享 key' },
  { name: 'sharepassword', type: 'string', default: '', options: '', required: false, help: '分享密码' },
  { name: 'root_folder_id', type: 'string', default: '0', options: '', required: false, help: '根文件夹 ID' },
  { name: 'accesstoken', type: 'string', default: '', options: '', required: false, help: 'Access token' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,size,modified', required: false, help: '排序字段' },
  { name: 'order_direction', type: 'select', default: '', options: 'ASC,DESC', required: false, help: '排序方向' },
];

const MAIN_API = 'https://yun.123pan.com/b/api';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(str: string | Uint8Array): number {
  const bytes = typeof str === 'string' ? new TextEncoder().encode(str) : str;
  let crc = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function signPath(path: string, os = 'web', version = '3'): [string, string] {
  const table = ['a', 'd', 'e', 'f', 'g', 'h', 'l', 'm', 'y', 'i', 'j', 'n', 'o', 'p', 'k', 'q', 'r', 's', 't', 'u', 'b', 'c', 'v', 'w', 's', 'z'];
  const random = String(Math.round(1e7 * Math.random()));
  const now = new Date();
  const timestamp = String(Math.floor(now.getTime() / 1000));

  const pad = (n: number) => String(n).padStart(2, '0');
  const nowStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;

  const mappedChars: string[] = [];
  for (let i = 0; i < nowStr.length; i++) {
    const code = nowStr.charCodeAt(i) - 48;
    mappedChars.push(table[code] || 'a');
  }
  const timeSign = String(crc32(mappedChars.join('')));
  const data = [timestamp, random, path, os, version, timeSign].join('|');
  const dataSign = String(crc32(data));

  return [timeSign, [timestamp, random, dataSign].join('-')];
}

function getSignedApiUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  const [k, v] = signPath(u.pathname, 'web', '3');
  u.searchParams.set(k, v);
  return u.toString();
}

interface ShareFileInfo {
  FileId: number | string;
  FileName: string;
  Size: number;
  Etag?: string;
  S3KeyFlag?: string;
  Type: number; // 0 = file, 1 = folder
  UpdateAt?: string;
  CreateAt?: string;
}

class Pan123ShareApiClient {
  private sharekey: string;
  private sharepassword?: string;
  private accesstoken?: string;

  constructor(cfg: Record<string, any>) {
    this.sharekey = cfg.sharekey || '';
    this.sharepassword = cfg.sharepassword || undefined;
    this.accesstoken = cfg.accesstoken || undefined;
  }

  async init(): Promise<void> {
    if (!this.sharekey) {
      throw new Error('123Share: sharekey is required');
    }
  }

  async request<T = any>(
    url: string,
    options: { method?: string; params?: Record<string, string>; body?: any } = {},
  ): Promise<T> {
    const targetUrl = new URL(url);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        targetUrl.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      Origin: 'https://yun.123pan.com',
      Referer: 'https://yun.123pan.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) openlist-client',
      Platform: 'web',
      'App-Version': '3',
    };
    if (this.accesstoken) {
      headers['Authorization'] = `Bearer ${this.accesstoken}`;
    }

    let requestBody: string | undefined;
    if (options.body) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(options.body);
    }

    const res = await fetch(getSignedApiUrl(targetUrl.toString()), {
      method: options.method || 'GET',
      headers,
      body: requestBody,
    });
    if (!res.ok) {
      throw new Error(`123Share API error: HTTP ${res.status}`);
    }

    const json = (await res.json()) as any;
    if (json.code !== 0 && json.code !== 200) {
      throw new Error(json.message || `123Share API error (${json.code})`);
    }
    return json as T;
  }

  async getFiles(parentId = '0'): Promise<ShareFileInfo[]> {
    const files: ShareFileInfo[] = [];
    let page = 1;
    for (;;) {
      const res = await this.request<any>(`${MAIN_API}/share/get`, {
        method: 'GET',
        params: {
          limit: '100',
          next: '0',
          orderBy: 'file_id',
          orderDirection: 'desc',
          parentFileId: parentId || '0',
          Page: String(page),
          shareKey: this.sharekey,
          SharePwd: this.sharepassword || '',
        },
      });

      const list: ShareFileInfo[] = res?.data?.InfoList || [];
      files.push(...list);
      page++;
      if (list.length === 0 || res?.data?.Next === '-1' || res?.data?.Next === -1) break;
    }
    return files;
  }

  async getDownloadUrl(file: ShareFileInfo): Promise<string> {
    const res = await this.request<any>(`${MAIN_API}/share/download/info`, {
      method: 'POST',
      body: {
        shareKey: this.sharekey,
        SharePwd: this.sharepassword || '',
        etag: file.Etag || '',
        fileId: file.FileId,
        s3keyFlag: file.S3KeyFlag || '',
        size: file.Size,
      },
    });

    let downloadUrl = res?.data?.DownloadURL || '';
    if (!downloadUrl) {
      throw new Error('Failed to obtain download URL from 123Share');
    }
    try {
      const ou = new URL(downloadUrl);
      const params = ou.searchParams.get('params');
      if (params) downloadUrl = atob(params);
    } catch {
      // keep the original URL
    }
    return downloadUrl;
  }
}

export class Pan123ShareDriver implements Driver {
  private cfg: Record<string, any> = {};
  private client: Pan123ShareApiClient = new Pan123ShareApiClient({});

  config(): DriverConfig {
    return pan123ShareConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.client = new Pan123ShareApiClient(cfg);
    await this.client.init();
  }

  private cleanPath(p: string): string {
    const s = '/' + (p || '').split('/').filter(Boolean).join('/');
    return s === '/' ? '/' : s;
  }

  private async resolveParentId(path: string): Promise<string> {
    const clean = this.cleanPath(path);
    if (clean === '/') {
      return this.cfg.root_folder_id || '0';
    }

    let currentId = this.cfg.root_folder_id || '0';
    for (const part of clean.split('/').filter(Boolean)) {
      const files = await this.client.getFiles(currentId);
      const folder = files.find(f => f.Type === 1 && f.FileName === part);
      if (!folder) break;
      currentId = String(folder.FileId);
    }
    return currentId;
  }

  private toObj(f: ShareFileInfo, isDir: boolean): Obj {
    const common = {
      name: f.FileName,
      size: isDir ? 0 : f.Size || 0,
      modified: f.UpdateAt || f.CreateAt || new Date().toISOString(),
      id: String(f.FileId),
    };
    return isDir ? createDirObj(common) : createFileObj(common);
  }

  private sort(items: Obj[]): Obj[] {
    const asc = (this.cfg.order_direction || '').toLowerCase() !== 'desc';
    const key = String(this.cfg.order_by || 'name').toLowerCase();
    return [...items].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let cmp: number;
      if (key.includes('size')) cmp = (a.size || 0) - (b.size || 0);
      else if (key.includes('time') || key.includes('modified')) {
        cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
      } else {
        cmp = String(a.name).localeCompare(String(b.name));
      }
      return asc ? cmp : -cmp;
    });
  }

  async list(path: string): Promise<ListResult> {
    const parentId = await this.resolveParentId(path);
    const files = await this.client.getFiles(parentId);
    const content = files.map(f => this.toObj(f, f.Type === 1));
    return { content: this.sort(content), total: content.length };
  }

  async get(path: string): Promise<Obj> {
    const clean = this.cleanPath(path);
    const name = clean.split('/').filter(Boolean).pop() || 'root';

    if (clean === '/') {
      return createDirObj({ name: 'root', modified: new Date().toISOString(), id: this.cfg.root_folder_id || '0' });
    }

    const parentPath = clean.substring(0, clean.lastIndexOf('/')) || '/';
    const parentId = await this.resolveParentId(parentPath);
    const files = await this.client.getFiles(parentId);

    const found = files.find(f => f.FileName === name);
    if (!found) throw new Error(`File not found: ${clean}`);
    return this.toObj(found, found.Type === 1);
  }

  async link(path: string): Promise<LinkResult> {
    const clean = this.cleanPath(path);
    const parentPath = clean.substring(0, clean.lastIndexOf('/')) || '/';
    const name = clean.substring(clean.lastIndexOf('/') + 1);
    const parentId = await this.resolveParentId(parentPath);
    const files = await this.client.getFiles(parentId);

    const found = files.find(f => f.FileName === name);
    if (!found || found.Type === 1) throw new Error(`Cannot get link for: ${clean}`);
    const url = await this.client.getDownloadUrl(found);
    return { url, header: { Referer: 'https://yun.123pan.com/' } };
  }

  async mkdir(_path: string): Promise<void> { throw new Error('123Share is read-only'); }
  async rename(_path: string, _newName: string): Promise<void> { throw new Error('123Share is read-only'); }
  async copy(_src: string, _dst: string): Promise<void> { throw new Error('123Share is read-only'); }
  async move(_src: string, _dst: string): Promise<void> { throw new Error('123Share is read-only'); }
  async remove(_path: string): Promise<void> { throw new Error('123Share is read-only'); }
  async put(_path: string, _file: ArrayBuffer, _contentType: string): Promise<void> {
    throw new Error('123Share is read-only');
  }
}

registerDriver(Pan123ShareDriver, pan123ShareConfig, pan123ShareAdditional);
