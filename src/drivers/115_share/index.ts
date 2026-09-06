/**
 * 115 网盘分享 (115 Share) Driver — read-only
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/115_share.
 *
 * Browse a share via https://webapi.115.com/share/snap (share_code +
 * receive_code) and obtain download links via
 * https://proapi.115.com/app/share/downurl.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const pan115ShareConfig: DriverConfig = {
  name: '115Share',
  label: '115 分享',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: true,
  default_root: '0',
};

export const pan115ShareAdditional: DriverItem[] = [
  { name: 'share_code', type: 'string', default: '', options: '', required: true, help: '分享码' },
  { name: 'receive_code', type: 'string', default: '', options: '', required: true, help: '接收码' },
  { name: 'cookie', type: 'string', default: '', options: '', required: false, help: 'Cookie (可选)' },
  { name: 'qrcode_token', type: 'string', default: '', options: '', required: false, help: '二维码 token (保留字段)' },
  { name: 'qrcode_source', type: 'string', default: '', options: '', required: false, help: '二维码来源 (保留字段)' },
  { name: 'page_size', type: 'number', default: '1000', options: '', required: false, help: '每页数量' },
  { name: 'root_folder_id', type: 'string', default: '0', options: '', required: false, help: '根文件夹 ID' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,size,modified', required: false, help: '排序字段' },
  { name: 'order_direction', type: 'select', default: '', options: 'ASC,DESC', required: false, help: '排序方向' },
];

const SNAP_API = 'https://webapi.115.com/share/snap';
const DOWN_API = 'https://proapi.115.com/app/share/downurl';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface Pan115ShareItem {
  file_id?: string;
  category_id?: string;
  file_name?: string;
  file_size?: number | string;
  sha1?: string;
  is_file?: number; // 0 = folder, 1 = file
  user_utime?: number | string;
  thumb_url?: string;
}

interface Pan115ShareSnapResp {
  state: boolean;
  msg?: string;
  data?: {
    count?: number;
    list?: Pan115ShareItem[];
  };
}

class Pan115ShareApiClient {
  private shareCode: string;
  private receiveCode: string;
  private cookie?: string;
  private pageSize: number;

  constructor(cfg: Record<string, any>) {
    this.shareCode = cfg.share_code || '';
    this.receiveCode = cfg.receive_code || '';
    this.cookie = cfg.cookie || undefined;
    this.pageSize = Number(cfg.page_size) || 1000;
  }

  async init(): Promise<void> {
    if (!this.shareCode || !this.receiveCode) {
      throw new Error('115Share: share_code and receive_code are required');
    }
  }

  async getFiles(cid = '0'): Promise<Pan115ShareItem[]> {
    const items: Pan115ShareItem[] = [];
    let offset = 0;
    let total = 0;

    do {
      const u = new URL(SNAP_API);
      u.searchParams.set('share_code', this.shareCode);
      u.searchParams.set('receive_code', this.receiveCode);
      u.searchParams.set('cid', cid || '0');
      u.searchParams.set('limit', String(this.pageSize));
      u.searchParams.set('offset', String(offset));

      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Referer: 'https://115.com/',
      };
      if (this.cookie) {
        headers['Cookie'] = this.cookie;
      }

      const res = await fetch(u.toString(), { headers });
      if (!res.ok) {
        throw new Error(`115Share API error: HTTP ${res.status}`);
      }

      const json = (await res.json()) as Pan115ShareSnapResp;
      if (!json.state) {
        throw new Error(`115Share API error: ${json.msg || 'failed'}`);
      }

      const list = json.data?.list || [];
      items.push(...list);
      total = json.data?.count || 0;
      offset += list.length;

      if (list.length === 0) break;
    } while (offset < total);

    return items;
  }

  async getDownloadUrl(fileId: string): Promise<string> {
    const body = new URLSearchParams({
      share_code: this.shareCode,
      receive_code: this.receiveCode,
      file_id: fileId,
    });

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (this.cookie) {
      headers['Cookie'] = this.cookie;
    }

    const res = await fetch(DOWN_API, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`115Share download error: HTTP ${res.status}`);
    }

    const json = (await res.json()) as any;
    const rawUrl = json.data?.url?.url || json.data?.url;
    if (!rawUrl) {
      throw new Error(json.msg || 'Empty download URL received from 115Share');
    }
    return rawUrl;
  }
}

export class Pan115ShareDriver implements Driver {
  private cfg: Record<string, any> = {};
  private client: Pan115ShareApiClient = new Pan115ShareApiClient({});

  config(): DriverConfig {
    return pan115ShareConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.client = new Pan115ShareApiClient(cfg);
    await this.client.init();
  }

  private cleanPath(p: string): string {
    const s = '/' + (p || '').split('/').filter(Boolean).join('/');
    return s === '/' ? '/' : s;
  }

  private async resolveCid(path: string): Promise<string> {
    const clean = this.cleanPath(path);
    if (clean === '/') {
      return this.cfg.root_folder_id || '0';
    }

    let currentCid = this.cfg.root_folder_id || '0';
    for (const part of clean.split('/').filter(Boolean)) {
      const files = await this.client.getFiles(currentCid);
      const folder = files.find(f => f.is_file === 0 && f.file_name === part);
      if (folder && folder.category_id) {
        currentCid = folder.category_id;
      } else {
        break;
      }
    }
    return currentCid;
  }

  private toObj(f: Pan115ShareItem, isDir: boolean): Obj {
    const sizeNum =
      typeof f.file_size === 'number' ? f.file_size : parseInt(String(f.file_size || '0'), 10);
    const timeNum =
      typeof f.user_utime === 'number' ? f.user_utime : parseInt(String(f.user_utime || '0'), 10);
    const common = {
      name: f.file_name || 'file',
      size: isDir ? 0 : isNaN(sizeNum) ? 0 : sizeNum,
      modified: timeNum > 0 ? new Date(timeNum * 1000).toISOString() : new Date().toISOString(),
      thumb: f.thumb_url,
      id: isDir ? f.category_id || '' : f.file_id || '',
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
    const cid = await this.resolveCid(path);
    const files = await this.client.getFiles(cid);
    const content = files.map(f => this.toObj(f, f.is_file === 0));
    return { content: this.sort(content), total: content.length };
  }

  async get(path: string): Promise<Obj> {
    const clean = this.cleanPath(path);
    const name = clean.split('/').filter(Boolean).pop() || 'root';

    if (clean === '/') {
      return createDirObj({ name: 'root', modified: new Date().toISOString(), id: this.cfg.root_folder_id || '0' });
    }

    const parentPath = clean.substring(0, clean.lastIndexOf('/')) || '/';
    const parentCid = await this.resolveCid(parentPath);
    const files = await this.client.getFiles(parentCid);

    const found = files.find(f => f.file_name === name);
    if (!found) throw new Error(`File not found: ${clean}`);
    return this.toObj(found, found.is_file === 0);
  }

  async link(path: string): Promise<LinkResult> {
    const clean = this.cleanPath(path);
    const parentPath = clean.substring(0, clean.lastIndexOf('/')) || '/';
    const name = clean.substring(clean.lastIndexOf('/') + 1);
    const parentCid = await this.resolveCid(parentPath);
    const files = await this.client.getFiles(parentCid);

    const found = files.find(f => f.file_name === name);
    if (!found || found.is_file !== 1) throw new Error(`Cannot get link for: ${clean}`);
    if (!found.file_id) throw new Error(`Cannot get link for: ${clean}`);
    const url = await this.client.getDownloadUrl(found.file_id);
    return { url, header: { Referer: 'https://115.com/' } };
  }

  async mkdir(_path: string): Promise<void> { throw new Error('115Share is read-only'); }
  async rename(_path: string, _newName: string): Promise<void> { throw new Error('115Share is read-only'); }
  async copy(_src: string, _dst: string): Promise<void> { throw new Error('115Share is read-only'); }
  async move(_src: string, _dst: string): Promise<void> { throw new Error('115Share is read-only'); }
  async remove(_path: string): Promise<void> { throw new Error('115Share is read-only'); }
  async put(_path: string, _file: ArrayBuffer, _contentType: string): Promise<void> {
    throw new Error('115Share is read-only');
  }
}

registerDriver(Pan115ShareDriver, pan115ShareConfig, pan115ShareAdditional);
