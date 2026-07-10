/**
 * PikPak Driver
 * Supports PikPak cloud storage
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { normalizePath, createFileObj, createDirObj, fetchWithRetry } from '../base';

const API_BASE = 'https://api-drive.mypikpak.com';

// Driver configuration
export const pikpakConfig: DriverConfig = {
  name: 'PikPak',
  label: 'PikPak',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

// Additional configuration fields
export const pikpakAdditional: DriverItem[] = [
  { name: 'username', type: 'string', default: '', options: '', required: true, help: 'Username' },
  { name: 'password', type: 'string', default: '', options: '', required: true, help: 'Password' },
];

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  sub: string;
}

interface PikPakFile {
  id: string;
  name: string;
  type: string;
  size: string;
  created_at: string;
  modified_at: string;
  thumbnail_link?: string;
  web_content_link?: string;
  parent_id: string;
}

/**
 * PikPak Driver Implementation
 */
export class PikPakDriver implements Driver {
  private accessToken: string = '';
  private refreshToken: string = '';
  private userId: string = '';

  config(): DriverConfig {
    return pikpakConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    await this.login(cfg.username, cfg.password);
  }

  private async login(username: string, password: string): Promise<void> {
    const resp = await fetch(`${API_BASE}/v1/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'YNxT9w7GMdWvEOKa',
        client_secret: 'dbw2OtmVEeuUvIptb1Coygx',
        username,
        password,
      }),
    });

    if (!resp.ok) {
      throw new Error(`PikPak login failed: ${resp.statusText}`);
    }

    const data: TokenResponse = await resp.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.userId = data.sub;
  }

  private async refreshAccessToken(): Promise<void> {
    const resp = await fetch(`${API_BASE}/v1/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'YNxT9w7GMdWvEOKa',
        client_secret: 'dbw2OtmVEeuUvIptb1Coygx',
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      }),
    });

    if (!resp.ok) {
      throw new Error('Failed to refresh token');
    }

    const data: TokenResponse = await resp.json();
    this.accessToken = data.access_token;
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }
  }

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    let resp = await fetch(`${API_BASE}${path}`, { ...options, headers });

    if (resp.status === 401) {
      await this.refreshAccessToken();
      headers['Authorization'] = `Bearer ${this.accessToken}`;
      resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
    }

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`PikPak API error: ${resp.status} ${err}`);
    }

    return resp.json();
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const parentId = await this.getFileIdByPath(path);
    
    const content: Obj[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        parent_id: parentId,
        limit: '100',
        with_audit: 'false',
        filters: '{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}',
      });
      
      if (pageToken) {
        params.set('page_token', pageToken);
      }

      const data = await this.request(`/drive/v1/files?${params.toString()}`);
      
      for (const item of (data.files || [])) {
        if (item.kind === 'drive#folder') {
          content.push(createDirObj({
            name: item.name,
            modified: item.modified_time || new Date().toISOString(),
            created: item.created_time,
            id: item.id,
          }));
        } else {
          content.push(createFileObj({
            name: item.name,
            size: parseInt(item.size || '0'),
            modified: item.modified_time || new Date().toISOString(),
            created: item.created_time,
            thumb: item.thumbnail_link,
            id: item.id,
          }));
        }
      }
      
      pageToken = data.next_page_token;
    } while (pageToken);

    return { content, total: content.length };
  }

  private async getFileIdByPath(path: string): Promise<string> {
    if (path === '/') return '';
    
    const parts = path.split('/').filter(p => p);
    let currentId = '';
    
    for (const part of parts) {
      const params = new URLSearchParams({
        parent_id: currentId,
        limit: '100',
        with_audit: 'false',
        filters: '{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}',
      });

      const data = await this.request(`/drive/v1/files?${params.toString()}`);
      const found = data.files?.find((f: PikPakFile) => f.name === part);
      
      if (!found) {
        throw new Error(`Path not found: ${path}`);
      }
      
      currentId = found.id;
    }
    
    return currentId;
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const fileId = await this.getFileIdByPath(path);
    const data = await this.request(`/drive/v1/files/${fileId}`);

    if (data.kind === 'drive#folder') {
      return createDirObj({
        name: data.name,
        modified: data.modified_time || new Date().toISOString(),
        created: data.created_time,
        id: data.id,
      });
    }

    return createFileObj({
      name: data.name,
      size: parseInt(data.size || '0'),
      modified: data.modified_time || new Date().toISOString(),
      created: data.created_time,
      thumb: data.thumbnail_link,
      id: data.id,
    });
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const fileId = await this.getFileIdByPath(path);
    const data = await this.request(`/drive/v1/files/${fileId}?extra=true`);
    
    return { url: data.web_content_link || data.medias?.[0]?.link?.url || '' };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const dirName = path.substring(path.lastIndexOf('/') + 1);
    const parentId = await this.getFileIdByPath(parentPath);

    await this.request('/drive/v1/files', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'drive#folder',
        parent_id: parentId,
        name: dirName,
      }),
    });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const fileId = await this.getFileIdByPath(path);
    
    await this.request(`/drive/v1/files/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: newName }),
    });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcFileId = await this.getFileIdByPath(src);
    const dstParentPath = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstParentId = await this.getFileIdByPath(dstParentPath);

    await this.request('/drive/v1/files:batchCopy', {
      method: 'POST',
      body: JSON.stringify({
        ids: [srcFileId],
        to: { parent_id: dstParentId },
      }),
    });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcFileId = await this.getFileIdByPath(src);
    const dstParentPath = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstParentId = await this.getFileIdByPath(dstParentPath);

    await this.request('/drive/v1/files:batchMove', {
      method: 'POST',
      body: JSON.stringify({
        ids: [srcFileId],
        to: { parent_id: dstParentId },
      }),
    });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const fileId = await this.getFileIdByPath(path);
    
    await this.request('/drive/v1/files:batchTrash', {
      method: 'POST',
      body: JSON.stringify({ ids: [fileId] }),
    });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const fileName = path.substring(path.lastIndexOf('/') + 1);
    const parentId = await this.getFileIdByPath(parentPath);

    // Step 1: Create upload session
    const createData = await this.request('/drive/v1/files', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'drive#file',
        parent_id: parentId,
        name: fileName,
        size: file.byteLength.toString(),
        upload_type: 'UPLOAD_TYPE_RESUMABLE',
      }),
    });

    // Step 2: Upload file
    const uploadUrl = createData.resumable?.upload_url;
    if (!uploadUrl) {
      throw new Error('No upload URL returned');
    }

    await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: file,
    });
  }
}

// Register this driver
registerDriver(PikPakDriver, pikpakConfig, pikpakAdditional);
