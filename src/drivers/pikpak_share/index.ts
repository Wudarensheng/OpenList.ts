/**
 * PikPak 分享 (PikPak Share) Driver — read-only
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/pikpak_share.
 *
 * Browse a share via https://api-drive.mypikpak.com/drive/v1/share using a
 * share_id (+ optional pass_code). Download URLs come from the item's
 * web_content_link or the first media link.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const pikpakShareConfig: DriverConfig = {
  name: 'PikPakShare',
  label: 'PikPak 分享',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: true,
  default_root: '',
};

export const pikpakShareAdditional: DriverItem[] = [
  { name: 'share_id', type: 'string', default: '', options: '', required: true, help: '分享 ID' },
  { name: 'share_pwd', type: 'string', default: '', options: '', required: false, help: '分享密码' },
  { name: 'platform', type: 'select', default: 'web', options: 'web,android,pc', required: false, help: '平台' },
  { name: 'device_id', type: 'string', default: '', options: '', required: false, help: '设备 ID (可选)' },
  { name: 'use_transcoding_address', type: 'bool', default: 'false', options: '', required: false, help: '使用转码地址 (保留字段)' },
  { name: 'root_folder_id', type: 'string', default: '', options: '', required: false, help: '根文件夹 ID' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,size,modified', required: false, help: '排序字段' },
  { name: 'order_direction', type: 'select', default: '', options: 'ASC,DESC', required: false, help: '排序方向' },
];

const SHARE_API = 'https://api-drive.mypikpak.com/drive/v1/share';

interface PikPakShareFileItem {
  id: string;
  share_id: string;
  kind: string; // "drive#folder" | "drive#file"
  name: string;
  modified_time?: string;
  size?: string | number;
  thumbnail_link?: string;
  web_content_link?: string;
  medias?: Array<{
    link?: {
      url?: string;
      expire?: string;
    };
  }>;
}

interface PikPakShareResp {
  share_status?: string;
  share_status_text?: string;
  file_info?: PikPakShareFileItem;
  files?: PikPakShareFileItem[];
  next_page_token?: string;
  pass_code_token?: string;
}

class PikPakShareApiClient {
  private shareId: string;
  private sharePwd?: string;
  private passCodeToken = '';
  private deviceId = '';

  constructor(cfg: Record<string, any>) {
    this.shareId = cfg.share_id || '';
    this.sharePwd = cfg.share_pwd || undefined;
    this.deviceId = cfg.device_id || this.generateDeviceId();
  }

  private generateDeviceId(): string {
    return 'web_' + Math.random().toString(36).substring(2, 15);
  }

  async init(): Promise<void> {
    if (!this.shareId) {
      throw new Error('PikPakShare: share_id is required');
    }
  }

  async getFiles(parentId = ''): Promise<PikPakShareFileItem[]> {
    const items: PikPakShareFileItem[] = [];
    let pageToken = '';

    do {
      const u = new URL(SHARE_API);
      u.searchParams.set('share_id', this.shareId);
      if (this.sharePwd) {
        u.searchParams.set('pass_code', this.sharePwd);
      }
      if (parentId) {
        u.searchParams.set('parent_id', parentId);
      }
      if (pageToken) {
        u.searchParams.set('page_token', pageToken);
      }
      u.searchParams.set('thumbnail_size', 'SIZE_LARGE');

      const headers: Record<string, string> = {
        'X-Client-ID': 'YUMx5nI8ZU8Ap8pm',
        'X-Device-ID': this.deviceId,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      };
      if (this.passCodeToken) {
        headers['X-Share-Token'] = this.passCodeToken;
      }

      const res = await fetch(u.toString(), { headers });
      if (!res.ok) {
        throw new Error(`PikPakShare API error: HTTP ${res.status}`);
      }

      const json = (await res.json()) as PikPakShareResp;
      if (json.pass_code_token) {
        this.passCodeToken = json.pass_code_token;
      }

      const list = json.files || [];
      items.push(...list);
      pageToken = json.next_page_token || '';

      if (list.length === 0) break;
    } while (pageToken);

    return items;
  }

  async getDownloadUrl(file: PikPakShareFileItem): Promise<string> {
    if (file.web_content_link) {
      return file.web_content_link;
    }
    if (file.medias && file.medias.length > 0 && file.medias[0].link?.url) {
      return file.medias[0].link.url;
    }
    throw new Error('Download URL not found in PikPakShare item');
  }
}

export class PikPakShareDriver implements Driver {
  private cfg: Record<string, any> = {};
  private client: PikPakShareApiClient = new PikPakShareApiClient({});

  config(): DriverConfig {
    return pikpakShareConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.client = new PikPakShareApiClient(cfg);
    await this.client.init();
  }

  private cleanPath(p: string): string {
    const s = '/' + (p || '').split('/').filter(Boolean).join('/');
    return s === '/' ? '/' : s;
  }

  private async resolveParentId(path: string): Promise<string> {
    const clean = this.cleanPath(path);
    if (clean === '/') {
      return this.cfg.root_folder_id || '';
    }

    let currentId = this.cfg.root_folder_id || '';
    for (const part of clean.split('/').filter(Boolean)) {
      const files = await this.client.getFiles(currentId);
      const folder = files.find(f => f.kind === 'drive#folder' && f.name === part);
      if (folder) {
        currentId = folder.id;
      } else {
        break;
      }
    }
    return currentId;
  }

  private toObj(f: PikPakShareFileItem, isDir: boolean): Obj {
    const sizeNum =
      typeof f.size === 'number' ? f.size : parseInt(String(f.size || '0'), 10);
    const common = {
      name: f.name,
      size: isDir ? 0 : isNaN(sizeNum) ? 0 : sizeNum,
      modified: f.modified_time || new Date().toISOString(),
      thumb: f.thumbnail_link,
      id: f.id,
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
    const content = files.map(f => this.toObj(f, f.kind === 'drive#folder'));
    return { content: this.sort(content), total: content.length };
  }

  async get(path: string): Promise<Obj> {
    const clean = this.cleanPath(path);
    const name = clean.split('/').filter(Boolean).pop() || 'root';

    if (clean === '/') {
      return createDirObj({ name: 'root', modified: new Date().toISOString(), id: this.cfg.root_folder_id || '' });
    }

    const parentPath = clean.substring(0, clean.lastIndexOf('/')) || '/';
    const parentId = await this.resolveParentId(parentPath);
    const files = await this.client.getFiles(parentId);

    const found = files.find(f => f.name === name);
    if (!found) throw new Error(`File not found: ${clean}`);
    return this.toObj(found, found.kind === 'drive#folder');
  }

  async link(path: string): Promise<LinkResult> {
    const clean = this.cleanPath(path);
    const parentPath = clean.substring(0, clean.lastIndexOf('/')) || '/';
    const name = clean.substring(clean.lastIndexOf('/') + 1);
    const parentId = await this.resolveParentId(parentPath);
    const files = await this.client.getFiles(parentId);

    const found = files.find(f => f.name === name);
    if (!found || found.kind === 'drive#folder') throw new Error(`Cannot get link for: ${clean}`);
    const url = await this.client.getDownloadUrl(found);
    return { url };
  }

  async mkdir(_path: string): Promise<void> { throw new Error('PikPakShare is read-only'); }
  async rename(_path: string, _newName: string): Promise<void> { throw new Error('PikPakShare is read-only'); }
  async copy(_src: string, _dst: string): Promise<void> { throw new Error('PikPakShare is read-only'); }
  async move(_src: string, _dst: string): Promise<void> { throw new Error('PikPakShare is read-only'); }
  async remove(_path: string): Promise<void> { throw new Error('PikPakShare is read-only'); }
  async put(_path: string, _file: ArrayBuffer, _contentType: string): Promise<void> {
    throw new Error('PikPakShare is read-only');
  }
}

registerDriver(PikPakShareDriver, pikpakShareConfig, pikpakShareAdditional);
