/**
 * 123云盘 (regular web API) Driver
 * Referenced from OpenList's official drivers/123:
 * - Username/password login to get a Bearer token
 * - Every request URL is signed with a crc32-based signature
 * - List with `next` cursor pagination, download via download_info
 * - mkdir / rename / move / trash (copy not supported)
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const pan123Config: DriverConfig = {
  name: '123Pan',
  label: '123云盘',
  local_sort: true,
  only_proxy: true,
  no_cache: false,
  no_upload: false,
  default_root: '0',
};

export const pan123Additional: DriverItem[] = [
  { name: 'username', type: 'string', default: '', options: '', required: true, help: 'Username (phone number or email)' },
  { name: 'password', type: 'string', default: '', options: '', required: true, help: 'Password' },
  { name: 'root_folder_id', type: 'string', default: '0', options: '', required: false, help: 'Root folder id' },
  { name: 'platform', type: 'string', default: 'web', options: '', required: false, help: 'Platform header value' },
];

const MAIN_API = 'https://yun.123pan.com/b/api';
const LOGIN_API = 'https://login.123pan.com/api';
const SIGN_TABLE = ['a', 'd', 'e', 'f', 'g', 'h', 'l', 'm', 'y', 'i', 'j', 'n', 'o', 'p', 'k', 'q', 'r', 's', 't', 'u', 'b', 'c', 'v', 'w', 's', 'z'];

interface Pan123File {
  FileId: number;
  FileName: string;
  Size: number;
  Type: number; // 1 = dir, 2 = file
  Etag: string;
  S3KeyFlag: string;
  UpdateAt: string;
}

interface FilesResp {
  code: number;
  message: string;
  data: { InfoList: Pan123File[]; Next: string; Total: number };
}

// CRC32 (IEEE) — matches Go's crc32.ChecksumIEEE used by the URL signature.
function crc32(str: string): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function signPath(path: string): { k: string; v: string } {
  const random = String(Math.round(1e7 * Math.random()));
  const now = new Date(Date.now() + 8 * 3600 * 1000); // CST (UTC+8)
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const nowStr = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const mapped = nowStr.split('').map(c => SIGN_TABLE[Number(c)]).join('');
  const timeSign = String(crc32(mapped));
  const data = [timestamp, random, path, 'web', '3', timeSign].join('|');
  const dataSign = String(crc32(data));
  return { k: timeSign, v: [timestamp, random, dataSign].join('-') };
}

function getApi(rawUrl: string): string {
  const u = new URL(rawUrl);
  const { k, v } = signPath(u.pathname);
  u.searchParams.append(k, v);
  return u.toString();
}

/**
 * 123云盘 Driver Implementation
 */
export class Pan123Driver implements Driver {
  private accessToken = '';
  private cfg: Record<string, any> = {};

  config(): DriverConfig {
    return pan123Config;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    await this.login();
  }

  private async login(): Promise<void> {
    const body = this.cfg.username.includes('@')
      ? { mail: this.cfg.username, password: this.cfg.password, type: 2 }
      : { passport: this.cfg.username, password: this.cfg.password, remember: true };
    const resp = await fetch(`${LOGIN_API}/user/sign_in`, {
      method: 'POST',
      headers: {
        'origin': 'https://yun.123pan.com',
        'referer': 'https://yun.123pan.com/',
        'user-agent': 'Dart/2.19(dart:io)-openlist',
        'platform': 'web',
        'app-version': '3',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data: any = await resp.json().catch(() => ({}));
    if (data.code !== 200 || !data.data?.token) {
      throw new Error(data.message || '123: login failed');
    }
    this.accessToken = data.data.token;
  }

  private async request(path: string, method: string, opts: { params?: Record<string, string>; body?: unknown } = {}, retried = false): Promise<any> {
    const url = getApi(MAIN_API + path);
    const query = opts.params ? '&' + new URLSearchParams(opts.params).toString() : '';
    const init: RequestInit = {
      method,
      headers: {
        'origin': 'https://yun.123pan.com',
        'referer': 'https://yun.123pan.com/',
        'authorization': `Bearer ${this.accessToken}`,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) openlist-client',
        'platform': this.cfg.platform || 'web',
        'app-version': '3',
      },
    };
    if (opts.body !== undefined) {
      init.headers = { ...init.headers as Record<string, string>, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    const resp = await fetch(url + query, init);
    const data: any = await resp.json().catch(() => ({}));
    if (data.code !== 0) {
      if (data.code === 401 && !retried) {
        await this.login();
        return this.request(path, method, opts, true);
      }
      throw new Error(data.message || `123: API error ${data.code}`);
    }
    return data;
  }

  private async getFiles(parentId: string): Promise<Pan123File[]> {
    const files: Pan123File[] = [];
    let page = 1;
    for (;;) {
      const params: Record<string, string> = {
        driveId: '0',
        limit: '100',
        next: '0',
        orderBy: 'file_id',
        orderDirection: 'desc',
        parentFileId: parentId,
        trashed: 'false',
        SearchData: '',
        Page: String(page),
        OnlyLookAbnormalFile: '0',
        event: 'homeListFile',
        operateType: '4',
        inDirectSpace: 'false',
      };
      const resp = await this.request('/file/list/new', 'GET', { params }) as FilesResp;
      files.push(...(resp.data?.InfoList || []));
      page++;
      if (!resp.data?.InfoList?.length || resp.data?.Next === '-1') break;
    }
    return files;
  }

  // Resolve a path to a file id by walking each segment.
  private async getFileIdByPath(path: string): Promise<string> {
    const root = this.cfg.root_folder_id || '0';
    const parts = path.split('/').filter(p => p);
    let currentId = root;
    for (const part of parts) {
      const files = await this.getFiles(currentId);
      const found = files.find(f => f.FileName === part);
      if (!found) throw new Error(`123: path not found: ${path}`);
      currentId = String(found.FileId);
    }
    return currentId;
  }

  private fileToObj(f: Pan123File): Obj {
    const common = {
      name: f.FileName,
      size: f.Size || 0,
      modified: f.UpdateAt || new Date().toISOString(),
      id: String(f.FileId),
    };
    return f.Type === 1 ? createDirObj(common) : createFileObj(common);
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const parentId = await this.getFileIdByPath(path);
    const files = await this.getFiles(parentId);
    const content = files.map(f => this.fileToObj(f));
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const id = await this.getFileIdByPath(path);
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const files = await this.getFiles(await this.getFileIdByPath(parent));
    const found = files.find(f => String(f.FileId) === id);
    if (found) return this.fileToObj(found);
    const name = path.split('/').pop() || path;
    return createFileObj({ name, modified: new Date().toISOString(), id });
  }

  // Resolve the final download URL. Mirrors Link() in the Go driver: the API
  // returns a URL that may be base64-encoded in `params` and may 302 to a CDN.
  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const id = await this.getFileIdByPath(path);
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const files = await this.getFiles(await this.getFileIdByPath(parent));
    const f = files.find(x => String(x.FileId) === id);
    if (!f) throw new Error('123: file not found');
    const resp = await this.request('/file/download_info', 'POST', {
      body: { driveId: 0, etag: f.Etag, fileId: f.FileId, fileName: f.FileName, s3keyFlag: f.S3KeyFlag, size: f.Size, type: f.Type },
    });
    let url = String(resp?.data?.DownloadUrl || '');
    if (!url) throw new Error('123: failed to get download url');
    try {
      const u = new URL(url);
      const params = u.searchParams.get('params');
      if (params) {
        const decoded = atob(params);
        url = decoded;
      }
    } catch {
      // keep the original URL
    }
    // Resolve 302 / redirect_url (manual redirect, no following).
    const head = await fetch(url, { method: 'GET', headers: { 'Referer': 'https://yun.123pan.com/' }, redirect: 'manual' });
    if (head.status === 302) {
      url = head.headers.get('location') || url;
    } else if (head.status < 300) {
      try {
        const body: any = await head.json();
        if (body?.data?.redirect_url) url = body.data.redirect_url;
      } catch {
        // not json
      }
    }
    return { url, header: { 'Referer': 'https://yun.123pan.com/' } };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').pop() || '';
    const parentId = await this.getFileIdByPath(parent);
    await this.request('/file/upload_request', 'POST', {
      body: { driveId: 0, etag: '', fileName: name, parentFileId: Number(parentId), size: 0, type: 1 },
    });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const id = await this.getFileIdByPath(path);
    await this.request('/file/rename', 'POST', { body: { driveId: 0, fileId: Number(id), fileName: newName } });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcId = await this.getFileIdByPath(src);
    const dstId = await this.getFileIdByPath(dst);
    await this.request('/file/mod_pid', 'POST', {
      body: { fileIdList: [{ FileId: Number(srcId) }], parentFileId: Number(dstId) },
    });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('123: copy not supported');
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const id = await this.getFileIdByPath(path);
    await this.request('/file/trash', 'POST', { body: { driveId: 0, fileIdList: [Number(id)] } });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('123: upload not supported (chunked upload not ported)');
  }
}

registerDriver(Pan123Driver, pan123Config, pan123Additional);
