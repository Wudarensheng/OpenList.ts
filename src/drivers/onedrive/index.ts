/**
 * OneDrive Driver
 * Supports Microsoft OneDrive (Global, CN, DE, US)
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { normalizePath, createFileObj, createDirObj, fetchWithRetry } from '../base';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';

// Driver configuration
export const onedriveConfig: DriverConfig = {
  name: 'OneDrive',
  label: 'OneDrive',
  local_sort: false,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

// Additional configuration fields
export const onedriveAdditional: DriverItem[] = [
  { name: 'client_id', type: 'string', default: '', options: '', required: true, help: 'Application (client) ID' },
  { name: 'client_secret', type: 'string', default: '', options: '', required: true, help: 'Client secret' },
  { name: 'refresh_token', type: 'string', default: '', options: '', required: true, help: 'Refresh token' },
  { name: 'redirect_uri', type: 'string', default: 'http://localhost', options: '', required: false, help: 'Redirect URI' },
  { name: 'chunk_size', type: 'number', default: '10', options: '', required: false, help: 'Upload chunk size (MB)' },
  { name: 'custom_host', type: 'string', default: '', options: '', required: false, help: 'Custom download host' },
];

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * OneDrive Driver Implementation
 */
export class OneDriveDriver implements Driver {
  private accessToken: string = '';
  private refreshToken: string = '';
  private clientId: string = '';
  private clientSecret: string = '';
  private redirectUri: string = 'http://localhost';

  config(): DriverConfig {
    return onedriveConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.clientId = cfg.client_id;
    this.clientSecret = cfg.client_secret;
    this.refreshToken = cfg.refresh_token;
    this.redirectUri = cfg.redirect_uri || 'http://localhost';
    
    await this.refreshAccessToken(cfg);
  }

  private async refreshAccessToken(cfg: Record<string, any>): Promise<void> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
      redirect_uri: this.redirectUri,
    });

    const resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
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

  private async request(path: string, cfg: Record<string, any>, options: RequestInit = {}): Promise<any> {
    const url = `${GRAPH_API}${path}`;
    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    let resp = await fetch(url, { ...options, headers });

    if (resp.status === 401) {
      await this.refreshAccessToken(cfg);
      headers['Authorization'] = `Bearer ${this.accessToken}`;
      resp = await fetch(url, { ...options, headers });
    }

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OneDrive API error: ${resp.status} ${err}`);
    }

    return resp.json();
  }

  private async requestUrl(url: string, cfg: Record<string, any>): Promise<any> {
    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };

    let resp = await fetch(url, { headers });

    if (resp.status === 401) {
      await this.refreshAccessToken(cfg);
      headers['Authorization'] = `Bearer ${this.accessToken}`;
      resp = await fetch(url, { headers });
    }

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OneDrive API error: ${resp.status} ${err}`);
    }

    return resp.json();
  }

  private encodePath(path: string): string {
    if (path === '/') return '/root';
    const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
    return `/root:/${cleanPath}`;
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const apiPath = `${this.encodePath(path)}:/children`;
    const content: Obj[] = [];

    let data = await this.request(apiPath, cfg);

    while (data) {
      for (const item of (data.value || [])) {
        if (item.folder) {
          content.push(createDirObj({
            name: item.name,
            modified: item.lastModifiedDateTime || new Date().toISOString(),
            created: item.createdDateTime,
          }));
        } else {
          content.push(createFileObj({
            name: item.name,
            size: item.size || 0,
            modified: item.lastModifiedDateTime || new Date().toISOString(),
            created: item.createdDateTime,
            thumb: item.thumbnails?.[0]?.small?.url,
          }));
        }
      }

      if (data['@odata.nextLink']) {
        data = await this.requestUrl(data['@odata.nextLink'], cfg);
      } else {
        break;
      }
    }

    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const data = await this.request(this.encodePath(path), cfg);
    
    if (data.folder) {
      return createDirObj({
        name: data.name,
        modified: data.lastModifiedDateTime || new Date().toISOString(),
        created: data.createdDateTime,
      });
    }
    
    return createFileObj({
      name: data.name,
      size: data.size || 0,
      modified: data.lastModifiedDateTime || new Date().toISOString(),
      created: data.createdDateTime,
      thumb: data.thumbnails?.[0]?.small?.url,
    });
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const customHost = cfg.custom_host;
    
    if (customHost) {
      return { url: `${customHost}${path}` };
    }

    const data = await this.request(`${this.encodePath(path)}`, cfg);
    
    if (data['@microsoft.graph.downloadUrl']) {
      return { url: data['@microsoft.graph.downloadUrl'] };
    }

    const shareData = await this.request(`${this.encodePath(path)}/createLink`, cfg, {
      method: 'POST',
      body: JSON.stringify({ type: 'view', scope: 'anonymous' }),
    });

    return { url: shareData.link?.webUrl || '' };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const dirName = path.substring(path.lastIndexOf('/') + 1);
    
    await this.request(`${this.encodePath(parentPath)}:/children`, cfg, {
      method: 'POST',
      body: JSON.stringify({
        name: dirName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      }),
    });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    await this.request(this.encodePath(path), cfg, {
      method: 'PATCH',
      body: JSON.stringify({ name: newName }),
    });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const dstParent = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstName = dst.substring(dst.lastIndexOf('/') + 1);
    
    await this.request(`${this.encodePath(src)}/copy`, cfg, {
      method: 'POST',
      body: JSON.stringify({
        parentReference: { path: dstParent },
        name: dstName,
      }),
    });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const dstParent = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstName = dst.substring(dst.lastIndexOf('/') + 1);
    
    await this.request(this.encodePath(src), cfg, {
      method: 'PATCH',
      body: JSON.stringify({
        parentReference: { path: dstParent },
        name: dstName,
      }),
    });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    await this.request(this.encodePath(path), cfg, { method: 'DELETE' });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const chunkSize = (cfg.chunk_size || 10) * 1024 * 1024;
    
    if (file.byteLength <= chunkSize) {
      const url = `${GRAPH_API}${this.encodePath(path)}:/content`;
      await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': contentType,
        },
        body: file,
      });
    } else {
      await this.uploadLarge(path, file, contentType, chunkSize, cfg);
    }
  }

  private async uploadLarge(path: string, file: ArrayBuffer, contentType: string, chunkSize: number, cfg: Record<string, any>): Promise<void> {
    const sessionData = await this.request(`${this.encodePath(path)}:/createUploadSession`, cfg, {
      method: 'POST',
      body: JSON.stringify({
        item: {
          '@microsoft.graph.conflictBehavior': 'replace',
          name: path.substring(path.lastIndexOf('/') + 1),
        },
      }),
    });

    const uploadUrl = sessionData.uploadUrl;
    const totalSize = file.byteLength;
    let offset = 0;

    while (offset < totalSize) {
      const chunk = file.slice(offset, Math.min(offset + chunkSize, totalSize));
      const end = Math.min(offset + chunkSize - 1, totalSize - 1);
      
      await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${offset}-${end}/${totalSize}`,
          'Content-Length': String(chunk.byteLength),
        },
        body: chunk,
      });

      offset += chunkSize;
    }
  }
}

// Register this driver
registerDriver(OneDriveDriver, onedriveConfig, onedriveAdditional);
