/**
 * Dropbox Driver
 * Supports Dropbox cloud storage
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { normalizePath, createFileObj, createDirObj, fetchWithRetry } from '../base';

const API_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_API = 'https://content.dropboxapi.com/2';

// Driver configuration
export const dropboxConfig: DriverConfig = {
  name: 'Dropbox',
  label: 'Dropbox',
  local_sort: false,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

// Additional configuration fields
export const dropboxAdditional: DriverItem[] = [
  { name: 'refresh_token', type: 'string', default: '', options: '', required: true, help: 'Refresh token' },
  { name: 'app_key', type: 'string', default: '', options: '', required: true, help: 'App key' },
  { name: 'app_secret', type: 'string', default: '', options: '', required: true, help: 'App secret' },
  { name: 'root_folder', type: 'string', default: '', options: '', required: false, help: 'Root folder' },
];

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface DropboxFile {
  '.tag': string;
  name: string;
  path_lower: string;
  path_display: string;
  id: string;
  size?: number;
  server_modified?: string;
  client_modified?: string;
  thumbnail?: string;
}

/**
 * Dropbox Driver Implementation
 */
export class DropboxDriver implements Driver {
  private accessToken: string = '';
  private refreshToken: string = '';
  private appKey: string = '';
  private appSecret: string = '';
  private rootFolder: string = '';

  config(): DriverConfig {
    return dropboxConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.refreshToken = cfg.refresh_token;
    this.appKey = cfg.app_key;
    this.appSecret = cfg.app_secret;
    this.rootFolder = cfg.root_folder || '';
    
    await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<void> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.appKey,
      client_secret: this.appSecret,
    });

    const resp = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
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

  private getFullPath(path: string): string {
    const normalized = normalizePath(path);
    if (this.rootFolder) {
      return this.rootFolder + (normalized === '/' ? '' : normalized);
    }
    return normalized;
  }

  private async request(path: string, body: any, isContent: boolean = false): Promise<any> {
    const baseUrl = isContent ? CONTENT_API : API_BASE;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };

    let resp = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (resp.status === 401) {
      await this.refreshAccessToken();
      headers['Authorization'] = `Bearer ${this.accessToken}`;
      resp = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    }

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Dropbox API error: ${resp.status} ${err}`);
    }

    return resp.json();
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const fullPath = this.getFullPath(path);
    
    const content: Obj[] = [];
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      let data;
      if (cursor) {
        data = await this.request('/files/list_folder/continue', { cursor });
      } else {
        data = await this.request('/files/list_folder', {
          path: fullPath || '',
          recursive: false,
          include_media_info: true,
          include_deleted: false,
          include_has_explicit_shared_members: false,
        });
      }

      for (const entry of (data.entries || [])) {
        if (entry['.tag'] === 'folder') {
          content.push(createDirObj({
            name: entry.name,
            modified: new Date().toISOString(),
            id: entry.id,
            path: entry.path_display,
          }));
        } else {
          content.push(createFileObj({
            name: entry.name,
            size: entry.size || 0,
            modified: entry.server_modified || new Date().toISOString(),
            created: entry.client_modified,
            id: entry.id,
            path: entry.path_display,
          }));
        }
      }

      hasMore = data.has_more || false;
      cursor = data.cursor;
    }

    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const fullPath = this.getFullPath(path);
    const data = await this.request('/files/get_metadata', { path: fullPath });

    if (data['.tag'] === 'folder') {
      return createDirObj({
        name: data.name,
        modified: new Date().toISOString(),
        id: data.id,
        path: data.path_display,
      });
    }

    return createFileObj({
      name: data.name,
      size: data.size || 0,
      modified: data.server_modified || new Date().toISOString(),
      created: data.client_modified,
      id: data.id,
      path: data.path_display,
    });
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const fullPath = this.getFullPath(path);
    const data = await this.request('/files/get_temporary_link', { path: fullPath });
    
    return { url: data.link };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const fullPath = this.getFullPath(path);
    
    await this.request('/files/create_folder_v2', { path: fullPath, autorename: false });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const fullPath = this.getFullPath(path);
    const parentPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
    const toPath = `${parentPath}/${newName}`;
    
    await this.request('/files/move_v2', {
      from_path: fullPath,
      to_path: toPath,
      autorename: false,
    });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcPath = this.getFullPath(src);
    const dstPath = this.getFullPath(dst);
    
    await this.request('/files/copy_v2', {
      from_path: srcPath,
      to_path: dstPath,
      autorename: false,
    });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcPath = this.getFullPath(src);
    const dstPath = this.getFullPath(dst);
    
    await this.request('/files/move_v2', {
      from_path: srcPath,
      to_path: dstPath,
      autorename: false,
    });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const fullPath = this.getFullPath(path);
    
    await this.request('/files/delete_v2', { path: fullPath });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const fullPath = this.getFullPath(path);
    
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: fullPath,
        mode: 'add',
        autorename: false,
        mute: false,
      }),
    };

    const resp = await fetch(`${CONTENT_API}/files/upload`, {
      method: 'POST',
      headers,
      body: file,
    });

    if (resp.status === 401) {
      await this.refreshAccessToken();
      headers['Authorization'] = `Bearer ${this.accessToken}`;
      
      await fetch(`${CONTENT_API}/files/upload`, {
        method: 'POST',
        headers,
        body: file,
      });
    } else if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Dropbox upload error: ${resp.status} ${err}`);
    }
  }
}

// Register this driver
registerDriver(DropboxDriver, dropboxConfig, dropboxAdditional);
