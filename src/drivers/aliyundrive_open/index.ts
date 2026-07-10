/**
 * Aliyundrive Open Driver
 * Supports Alibaba Cloud Drive (Aliyun Pan) via Open API
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { normalizePath, createFileObj, createDirObj, fetchWithRetry } from '../base';

const API_BASE = 'https://open.aliyundrive.com/adrive/v1.0';

// Driver configuration
export const aliyundriveOpenConfig: DriverConfig = {
  name: 'AliyundriveOpen',
  label: 'Aliyundrive Open',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

// Additional configuration fields
export const aliyundriveOpenAdditional: DriverItem[] = [
  { name: 'refresh_token', type: 'string', default: '', options: '', required: true, help: 'Refresh token' },
  { name: 'client_id', type: 'string', default: '', options: '', required: false, help: 'Client ID (optional)' },
  { name: 'client_secret', type: 'string', default: '', options: '', required: false, help: 'Client Secret (optional)' },
  { name: 'order_by', type: 'select', default: 'updated_at', options: 'name,size,updated_at,created_at', required: false, help: 'Order by' },
  { name: 'order_direction', type: 'select', default: 'DESC', options: 'ASC,DESC', required: false, help: 'Order direction' },
];

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface AliyunFile {
  file_id: string;
  name: string;
  type: string;
  size: number;
  created_at: string;
  updated_at: string;
  thumbnail?: string;
}

/**
 * Aliyundrive Open Driver Implementation
 */
export class AliyundriveOpenDriver implements Driver {
  private accessToken: string = '';
  private refreshToken: string = '';
  private driveId: string = '';
  private pathIdCache: Map<string, string> = new Map();

  config(): DriverConfig {
    return aliyundriveOpenConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.refreshToken = cfg.refresh_token;
    this.pathIdCache.clear();
    await this.refreshAccessToken(cfg);
    await this.getDriveId();
  }

  private async refreshAccessToken(cfg: Record<string, any>): Promise<void> {
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    };
    
    if (cfg.client_id) {
      body.client_id = cfg.client_id;
    }
    if (cfg.client_secret) {
      body.client_secret = cfg.client_secret;
    }

    const resp = await fetch('https://auth.aliyundrive.com/v2/account/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error(`Failed to refresh token: ${resp.statusText}`);
    }

    const data: TokenResponse = await resp.json();
    this.accessToken = data.access_token;
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }
  }

  private async getDriveId(): Promise<void> {
    const resp = await fetch(`${API_BASE}/user/get`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    if (!resp.ok) {
      throw new Error('Failed to get drive ID');
    }

    const data = await resp.json() as any;
    this.driveId = data.default_drive_id;
  }

  private async request(path: string, body: Record<string, any>, cfg: Record<string, any>): Promise<any> {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (resp.status === 401) {
      await this.refreshAccessToken(cfg);
      return this.request(path, body, cfg);
    }

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Aliyundrive API error: ${resp.status} ${err}`);
    }

    return resp.json();
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const parentFileId = await this.getFileIdByPath(path);

    const content: Obj[] = [];
    let marker: string | undefined;

    do {
      const body: Record<string, any> = {
        drive_id: this.driveId,
        parent_file_id: parentFileId,
        limit: 200,
        order_by: cfg.order_by || 'updated_at',
        order_direction: cfg.order_direction || 'DESC',
      };

      if (marker) {
        body.marker = marker;
      }

      const data = await this.request('/file/list', body, cfg);

      for (const item of (data.items || [])) {
        const itemPath = path === '/' ? `/${item.name}` : `${path}/${item.name}`;

        // Cache path->fileId mapping for future lookups
        this.pathIdCache.set(itemPath, item.file_id);

        if (item.type === 'folder') {
          content.push(createDirObj({
            name: item.name,
            modified: item.updated_at || new Date().toISOString(),
            created: item.created_at,
            id: item.file_id,
          }));
        } else {
          content.push(createFileObj({
            name: item.name,
            size: item.size || 0,
            modified: item.updated_at || new Date().toISOString(),
            created: item.created_at,
            thumb: item.thumbnail,
            id: item.file_id,
          }));
        }
      }

      marker = data.next_marker;
    } while (marker);

    return { content, total: content.length };
  }

  private async getFileIdByPath(path: string): Promise<string> {
    if (path === '/' || path === 'root') return 'root';

    // Check cache first
    const cached = this.pathIdCache.get(path);
    if (cached) return cached;

    const parts = path.split('/').filter(p => p);
    let currentId = 'root';
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`;

      // Check cache for this intermediate path
      const cachedId = this.pathIdCache.get(currentPath);
      if (cachedId) {
        currentId = cachedId;
        continue;
      }

      const data = await this.request('/file/search', {
        drive_id: this.driveId,
        query: `name = "${part}"`,
        parent_file_id: currentId,
        limit: 1,
      }, {});

      if (!data.items || data.items.length === 0) {
        throw new Error(`Path not found: ${path}`);
      }

      currentId = data.items[0].file_id;
      // Cache this path->id mapping
      this.pathIdCache.set(currentPath, currentId);
    }

    return currentId;
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const fileId = await this.getFileIdByPath(path);
    const data = await this.request('/file/get', {
      drive_id: this.driveId,
      file_id: fileId,
    }, cfg);

    if (data.type === 'folder') {
      return createDirObj({
        name: data.name,
        modified: data.updated_at || new Date().toISOString(),
        created: data.created_at,
        id: data.file_id,
      });
    }

    return createFileObj({
      name: data.name,
      size: data.size || 0,
      modified: data.updated_at || new Date().toISOString(),
      created: data.created_at,
      thumb: data.thumbnail,
      id: data.file_id,
    });
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const fileId = await this.getFileIdByPath(path);
    const data = await this.request('/file/get_download_url', {
      drive_id: this.driveId,
      file_id: fileId,
    }, cfg);

    return { url: data.url };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const dirName = path.substring(path.lastIndexOf('/') + 1);
    const parentFileId = await this.getFileIdByPath(parentPath);

    await this.request('/file/create', {
      drive_id: this.driveId,
      parent_file_id: parentFileId,
      name: dirName,
      type: 'folder',
      check_name_mode: 'auto_rename',
    }, cfg);
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const fileId = await this.getFileIdByPath(path);
    
    await this.request('/file/update', {
      drive_id: this.driveId,
      file_id: fileId,
      name: newName,
    }, cfg);
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcFileId = await this.getFileIdByPath(src);
    const dstParentPath = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstParentFileId = await this.getFileIdByPath(dstParentPath);

    await this.request('/file/copy', {
      drive_id: this.driveId,
      file_id: srcFileId,
      to_drive_id: this.driveId,
      to_parent_file_id: dstParentFileId,
      auto_rename: true,
    }, cfg);
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcFileId = await this.getFileIdByPath(src);
    const dstParentPath = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstParentFileId = await this.getFileIdByPath(dstParentPath);

    await this.request('/file/move', {
      drive_id: this.driveId,
      file_id: srcFileId,
      to_drive_id: this.driveId,
      to_parent_file_id: dstParentFileId,
      auto_rename: true,
    }, cfg);
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const fileId = await this.getFileIdByPath(path);
    
    await this.request('/file/delete', {
      drive_id: this.driveId,
      file_id: fileId,
    }, cfg);
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const fileName = path.substring(path.lastIndexOf('/') + 1);
    const parentFileId = await this.getFileIdByPath(parentPath);

    // Step 1: Create upload session
    const createData = await this.request('/file/create', {
      drive_id: this.driveId,
      parent_file_id: parentFileId,
      name: fileName,
      type: 'file',
      size: file.byteLength,
      check_name_mode: 'auto_rename',
    }, cfg);

    // Step 2: Upload parts
    const partSize = 4 * 1024 * 1024; // 4MB
    const parts: { part_number: number; part_size: number; etag: string }[] = [];
    
    for (let i = 0; i < file.byteLength; i += partSize) {
      const chunk = file.slice(i, Math.min(i + partSize, file.byteLength));
      const partNumber = Math.floor(i / partSize) + 1;
      
      const uploadUrl = createData.part_info_list[partNumber - 1].upload_url;
      const resp = await fetch(uploadUrl, {
        method: 'PUT',
        body: chunk,
      });
      
      parts.push({
        part_number: partNumber,
        part_size: chunk.byteLength,
        etag: resp.headers.get('etag') || '',
      });
    }

    // Step 3: Complete upload
    await this.request('/file/complete', {
      drive_id: this.driveId,
      file_id: createData.file_id,
      upload_id: createData.upload_id,
    }, cfg);
  }
}

// Register this driver
registerDriver(AliyundriveOpenDriver, aliyundriveOpenConfig, aliyundriveOpenAdditional);
