/**
 * 阿里云盘分享 (AliyunDrive Share) Driver — read-only
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/aliyundrive_share.
 *
 * Browse a share via the Alipan share API. A share token is obtained from
 * /v2/share_link/get_share_token using share_id (+ optional share_pwd) and
 * sent as x-share-token on list / download-URL requests.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const aliyundriveShareConfig: DriverConfig = {
  name: 'AliyunDriveShare',
  label: '阿里云盘分享',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: true,
  default_root: 'root',
};

export const aliyundriveShareAdditional: DriverItem[] = [
  { name: 'refresh_token', type: 'string', default: '', options: '', required: false, help: 'Refresh token (保留字段)' },
  { name: 'share_id', type: 'string', default: '', options: '', required: true, help: '分享 ID' },
  { name: 'share_pwd', type: 'string', default: '', options: '', required: false, help: '分享密码' },
  { name: 'root_folder_id', type: 'string', default: 'root', options: '', required: false, help: '根文件夹 ID' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,size,modified', required: false, help: '排序字段' },
  { name: 'order_direction', type: 'select', default: '', options: 'ASC,DESC', required: false, help: '排序方向' },
];

const TOKEN_API = 'https://api.alipan.com/v2/share_link/get_share_token';
const LIST_API = 'https://api.alipan.com/adrive/v3/file/list';
const DOWNLOAD_API = 'https://api.alipan.com/v2/file/get_share_link_download_url';

interface AliyundriveShareItem {
  drive_id?: string;
  file_id: string;
  parent_file_id?: string;
  name: string;
  size?: number;
  type: 'file' | 'folder' | string;
  created_at?: string;
  updated_at?: string;
  thumbnail?: string;
}

class AliyundriveShareApiClient {
  private shareId: string;
  private sharePwd?: string;
  private orderBy: string;
  private orderDirection: string;
  private shareToken = '';
  private driveId = '';

  constructor(cfg: Record<string, any>) {
    this.shareId = cfg.share_id || '';
    this.sharePwd = cfg.share_pwd || undefined;
    this.orderBy = cfg.order_by || 'name';
    this.orderDirection = cfg.order_direction || 'ASC';
  }

  async getShareToken(): Promise<string> {
    if (!this.shareId) {
      throw new Error('AliyunDriveShare: share_id is required');
    }

    const body: Record<string, string> = { share_id: this.shareId };
    if (this.sharePwd) {
      body['share_pwd'] = this.sharePwd;
    }

    const res = await fetch(TOKEN_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`AliyunDriveShare token error: HTTP ${res.status}`);
    }

    const json = (await res.json()) as any;
    if (json.code) {
      throw new Error(json.message || `AliyunDriveShare error: ${json.code}`);
    }

    this.shareToken = json.share_token || '';
    return this.shareToken;
  }

  async init(): Promise<void> {
    await this.getShareToken();
  }

  async getFiles(parentId = 'root'): Promise<AliyundriveShareItem[]> {
    if (!this.shareToken) {
      await this.getShareToken();
    }

    const items: AliyundriveShareItem[] = [];
    let marker = '';

    do {
      const body: Record<string, any> = {
        image_thumbnail_process: 'image/resize,w_160/format,jpeg',
        image_url_process: 'image/resize,w_1920/format,jpeg',
        limit: 200,
        order_by: this.orderBy,
        order_direction: this.orderDirection,
        parent_file_id: parentId || 'root',
        share_id: this.shareId,
        video_thumbnail_process: 'video/snapshot,t_1000,f_jpg,ar_auto,w_300',
      };
      if (marker) {
        body.marker = marker;
      }

      const res = await fetch(LIST_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': this.shareToken,
          'X-Canary': 'client=web,app=share,version=v2.3.1',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`AliyunDriveShare list error: HTTP ${res.status}`);
      }

      const json = (await res.json()) as any;
      if (json.code === 'ShareLinkTokenInvalid' || json.code === 'AccessTokenInvalid') {
        await this.getShareToken();
        return this.getFiles(parentId);
      }
      if (json.code) {
        throw new Error(json.message || `AliyunDriveShare list error (${json.code})`);
      }

      const list: AliyundriveShareItem[] = json.items || [];
      items.push(...list);
      marker = json.next_marker || '';

      if (list.length > 0 && !this.driveId && list[0].drive_id) {
        this.driveId = list[0].drive_id;
      }
    } while (marker);

    return items;
  }

  async getDownloadUrl(fileId: string): Promise<string> {
    if (!this.shareToken) {
      await this.getShareToken();
    }

    const body: Record<string, any> = {
      share_id: this.shareId,
      file_id: fileId,
      expire_sec: 14400,
    };
    if (this.driveId) {
      body.drive_id = this.driveId;
    }

    const res = await fetch(DOWNLOAD_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': this.shareToken,
        'X-Canary': 'client=web,app=share,version=v2.3.1',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`AliyunDriveShare download URL error: HTTP ${res.status}`);
    }

    const json = (await res.json()) as any;
    if (json.code === 'ShareLinkTokenInvalid') {
      await this.getShareToken();
      return this.getDownloadUrl(fileId);
    }

    const downloadUrl = json.download_url || json.url;
    if (!downloadUrl) {
      throw new Error('Failed to get download URL from AliyunDriveShare');
    }
    return downloadUrl;
  }
}

export class AliyundriveShareDriver implements Driver {
  private cfg: Record<string, any> = {};
  private client: AliyundriveShareApiClient = new AliyundriveShareApiClient({});

  config(): DriverConfig {
    return aliyundriveShareConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.client = new AliyundriveShareApiClient(cfg);
    await this.client.init();
  }

  private cleanPath(p: string): string {
    const s = '/' + (p || '').split('/').filter(Boolean).join('/');
    return s === '/' ? '/' : s;
  }

  private async resolveFileId(path: string): Promise<string> {
    const clean = this.cleanPath(path);
    if (clean === '/') {
      return this.cfg.root_folder_id || 'root';
    }

    let currentId = this.cfg.root_folder_id || 'root';
    for (const part of clean.split('/').filter(Boolean)) {
      const files = await this.client.getFiles(currentId);
      const folder = files.find(f => f.type === 'folder' && f.name === part);
      if (folder) {
        currentId = folder.file_id;
      } else {
        break;
      }
    }
    return currentId;
  }

  private toObj(f: AliyundriveShareItem, isDir: boolean): Obj {
    const common = {
      name: f.name,
      size: isDir ? 0 : f.size || 0,
      modified: f.updated_at || f.created_at || new Date().toISOString(),
      thumb: f.thumbnail,
      id: f.file_id,
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
    const parentId = await this.resolveFileId(path);
    const files = await this.client.getFiles(parentId);
    const content = files.map(f => this.toObj(f, f.type === 'folder'));
    return { content: this.sort(content), total: content.length };
  }

  async get(path: string): Promise<Obj> {
    const clean = this.cleanPath(path);
    const name = clean.split('/').filter(Boolean).pop() || 'root';

    if (clean === '/') {
      return createDirObj({ name: 'root', modified: new Date().toISOString(), id: this.cfg.root_folder_id || 'root' });
    }

    const parentPath = clean.substring(0, clean.lastIndexOf('/')) || '/';
    const parentId = await this.resolveFileId(parentPath);
    const files = await this.client.getFiles(parentId);

    const found = files.find(f => f.name === name);
    if (!found) throw new Error(`File not found: ${clean}`);
    return this.toObj(found, found.type === 'folder');
  }

  async link(path: string): Promise<LinkResult> {
    const clean = this.cleanPath(path);
    const parentPath = clean.substring(0, clean.lastIndexOf('/')) || '/';
    const name = clean.substring(clean.lastIndexOf('/') + 1);
    const parentId = await this.resolveFileId(parentPath);
    const files = await this.client.getFiles(parentId);

    const found = files.find(f => f.name === name);
    if (!found || found.type === 'folder') throw new Error(`Cannot get link for: ${clean}`);
    const url = await this.client.getDownloadUrl(found.file_id);
    return { url, header: { Referer: 'https://www.aliyundrive.com/' } };
  }

  async mkdir(_path: string): Promise<void> { throw new Error('AliyunDriveShare is read-only'); }
  async rename(_path: string, _newName: string): Promise<void> { throw new Error('AliyunDriveShare is read-only'); }
  async copy(_src: string, _dst: string): Promise<void> { throw new Error('AliyunDriveShare is read-only'); }
  async move(_src: string, _dst: string): Promise<void> { throw new Error('AliyunDriveShare is read-only'); }
  async remove(_path: string): Promise<void> { throw new Error('AliyunDriveShare is read-only'); }
  async put(_path: string, _file: ArrayBuffer, _contentType: string): Promise<void> {
    throw new Error('AliyunDriveShare is read-only');
  }
}

registerDriver(AliyundriveShareDriver, aliyundriveShareConfig, aliyundriveShareAdditional);
