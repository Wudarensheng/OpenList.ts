/**
 * OneDrive Driver
 * Completely rewritten to match OpenList's official drivers/onedrive:
 * - Region-aware Graph endpoints (global / cn / us / de)
 * - Supports SharePoint via site_id
 * - Online refresh API (use_online_api) or local client credentials
 * - List with thumbnails, downloadUrl in link()
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj, encodePath } from '../base';

// Per-region hosts, mirroring onedriveHostMap in OpenList's onedrive/util.go
const HOSTS: Record<string, { oauth: string; api: string }> = {
  global: { oauth: 'https://login.microsoftonline.com', api: 'https://graph.microsoft.com' },
  cn: { oauth: 'https://login.chinacloudapi.cn', api: 'https://microsoftgraph.chinacloudapi.cn' },
  us: { oauth: 'https://login.microsoftonline.us', api: 'https://graph.microsoft.us' },
  de: { oauth: 'https://login.microsoftonline.de', api: 'https://graph.microsoft.de' },
};

export const onedriveConfig: DriverConfig = {
  name: 'OneDrive',
  label: 'OneDrive',
  local_sort: false,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

export const onedriveAdditional: DriverItem[] = [
  { name: 'region', type: 'select', default: 'global', options: 'global,cn,us,de', required: true, help: 'Region' },
  { name: 'is_sharepoint', type: 'bool', default: 'false', options: '', required: false, help: 'Is SharePoint' },
  { name: 'use_online_api', type: 'bool', default: 'true', options: '', required: false, help: 'Use online refresh API (no ClientID/Secret needed)' },
  { name: 'api_url_address', type: 'string', default: 'https://api.oplist.org/onedrive/renewapi', options: '', required: false, help: 'Online refresh API address' },
  { name: 'client_id', type: 'string', default: '', options: '', required: false, help: 'Application (client) ID' },
  { name: 'client_secret', type: 'string', default: '', options: '', required: false, help: 'Client secret' },
  { name: 'redirect_uri', type: 'string', default: 'https://api.oplist.org/onedrive/callback', options: '', required: false, help: 'Redirect URI' },
  { name: 'refresh_token', type: 'string', default: '', options: '', required: true, help: 'Refresh token' },
  { name: 'site_id', type: 'string', default: '', options: '', required: false, help: 'SharePoint site ID' },
  { name: 'chunk_size', type: 'number', default: '5', options: '', required: false, help: 'Upload chunk size (MB)' },
  { name: 'custom_host', type: 'string', default: '', options: '', required: false, help: 'Custom host for download link' },
  { name: 'disable_disk_usage', type: 'bool', default: 'false', options: '', required: false, help: 'Disable remaining space display' },
  { name: 'enable_direct_upload', type: 'bool', default: 'false', options: '', required: false, help: 'Enable direct upload from client' },
];

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface TokenErr {
  error?: string;
  error_description?: string;
}

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  fileSystemInfo?: {
    createdDateTime?: string;
    lastModifiedDateTime?: string;
  };
  '@microsoft.graph.downloadUrl'?: string;
  file?: { mimeType?: string } | null;
  thumbnails?: Array<{ medium?: { url?: string }; small?: { url?: string } }>;
  folder?: unknown | null;
  parentReference?: { driveId?: string };
}

interface FilesResp {
  value: DriveItem[];
  '@odata.nextLink'?: string;
}

/**
 * OneDrive Driver Implementation (referencing OpenList drivers/onedrive)
 */
export class OneDriveDriver implements Driver {
  private accessToken = '';
  private refreshToken = '';
  private chunkSize = 5;

  config(): DriverConfig {
    return onedriveConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    if ((cfg.chunk_size || 0) < 1) {
      this.chunkSize = 5;
    } else {
      this.chunkSize = cfg.chunk_size;
    }
    this.refreshToken = cfg.refresh_token || '';
    await this.refreshTokenFlow(cfg);
  }

  // Get the OAuth host for token refresh
  private oauthHost(cfg: Record<string, any>): string {
    const region = (cfg.region || 'global').trim() || 'global';
    return (HOSTS[region] || HOSTS.global).oauth;
  }

  // Get the Graph API host
  private apiHost(cfg: Record<string, any>): string {
    const region = (cfg.region || 'global').trim() || 'global';
    return (HOSTS[region] || HOSTS.global).api;
  }

  // Build the meta URL for a path, mirroring GetMetaUrl in OpenList.
  // path here is the worker's absolute path (relative to root_folder_path).
  private getMetaUrl(cfg: Record<string, any>, path: string): string {
    const api = this.apiHost(cfg);
    const p = encodePath(path);
    const isSharepoint = !!cfg.is_sharepoint;
    const siteId = (cfg.site_id || '').trim();

    if (isSharepoint) {
      if (p === '/' || p === '\\') {
        return `${api}/v1.0/sites/${siteId}/drive/root`;
      }
      return `${api}/v1.0/sites/${siteId}/drive/root:${p}:`;
    }
    if (p === '/' || p === '\\') {
      return `${api}/v1.0/me/drive/root`;
    }
    return `${api}/v1.0/me/drive/root:${p}:`;
  }

  // Refresh the access token. Follows OpenList: use the online API when
  // use_online_api is set, otherwise local client_credentials flow.
  private async refreshTokenFlow(cfg: Record<string, any>): Promise<void> {
    let err: Error | null = null;
    for (let i = 0; i < 3; i++) {
      try {
        await this._refreshToken(cfg);
        err = null;
        break;
      } catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
      }
    }
    if (err) throw err;
  }

  private async _refreshToken(cfg: Record<string, any>): Promise<void> {
    // Use the online refresh API, no ClientID/Secret needed.
    if (cfg.use_online_api && (cfg.api_url_address || '').length > 0) {
      const u = cfg.api_url_address;
      const resp = await fetch(`${u}?refresh_ui=${encodeURIComponent(this.refreshToken)}&server_use=true&driver_txt=onedrive_pr`);
      if (!resp.ok) {
        throw new Error(`failed to refresh token via online API: ${resp.status}`);
      }
      const data = await resp.json() as { refresh_token?: string; access_token?: string; text?: string };
      if (!data.refresh_token || !data.access_token) {
        if (data.text) throw new Error(`failed to refresh token: ${data.text}`);
        throw new Error('empty token returned from official API, a wrong refresh token may have been used');
      }
      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token;
      return;
    }

    // Local client credentials flow
    if (!cfg.client_id || !cfg.client_secret) {
      throw new Error('empty ClientID or ClientSecret');
    }
    const url = `${this.oauthHost(cfg)}/common/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      redirect_uri: (cfg.redirect_uri || 'https://api.oplist.org/onedrive/callback').trim(),
      refresh_token: this.refreshToken,
    });
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await resp.json() as TokenResponse & TokenErr;
    if ((data as any).error) {
      throw new Error((data as any).error_description || (data as any).error);
    }
    if (!data.refresh_token) {
      throw new Error('empty refresh token');
    }
    this.refreshToken = data.refresh_token;
    this.accessToken = data.access_token;
  }

  // Send an authenticated request with automatic token refresh on 401.
  private async request(url: string, cfg: Record<string, any>, options: RequestInit = {}, noRetry = false): Promise<any> {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${this.accessToken}`);
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let resp = await fetch(url, { ...options, headers });

    if (resp.status === 401 && !noRetry) {
      await this.refreshTokenFlow(cfg);
      headers.set('Authorization', `Bearer ${this.accessToken}`);
      resp = await fetch(url, { ...options, headers });
    }

    const text = await resp.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!resp.ok) {
      const code = json?.error?.code || '';
      const message = json?.error?.message || text;
      if (code === 'InvalidAuthenticationToken' && !noRetry) {
        await this.refreshTokenFlow(cfg);
        headers.set('Authorization', `Bearer ${this.accessToken}`);
        resp = await fetch(url, { ...options, headers });
        const retryText = await resp.text();
        let retryJson: any = null;
        try {
          retryJson = retryText ? JSON.parse(retryText) : null;
        } catch {
          retryJson = null;
        }
        if (!resp.ok) {
          throw new Error(retryJson?.error?.message || retryText);
        }
        return retryJson;
      }
      throw new Error(message);
    }

    return json;
  }

  private driveItemToObj(item: DriveItem): Obj {
    const modified = item.fileSystemInfo?.lastModifiedDateTime || new Date().toISOString();
    const created = item.fileSystemInfo?.createdDateTime;
    const thumb = item.thumbnails?.[0]?.medium?.url || item.thumbnails?.[0]?.small?.url;
    if (item.file) {
      return createFileObj({
        name: item.name,
        size: item.size || 0,
        modified,
        created,
        thumb,
        id: item.id,
      });
    }
    return createDirObj({
      name: item.name,
      modified,
      created,
      id: item.id,
    });
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const metaUrl = this.getMetaUrl(cfg, path);
    const files: DriveItem[] = [];
    let nextLink = `${metaUrl}/children?$top=1000&$expand=thumbnails($select=medium)&$select=id,name,size,fileSystemInfo,content.downloadUrl,file,parentReference`;

    while (nextLink) {
      const data = await this.request(nextLink, cfg) as FilesResp;
      if (Array.isArray(data.value)) {
        files.push(...data.value);
      }
      nextLink = data['@odata.nextLink'] || '';
    }

    return {
      content: files.map(f => this.driveItemToObj(f)),
      total: files.length,
    };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const url = this.getMetaUrl(cfg, path);
    const data = await this.request(url, cfg) as DriveItem;
    return this.driveItemToObj(data);
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const url = this.getMetaUrl(cfg, path);
    const data = await this.request(url, cfg) as DriveItem;

    let u = data['@microsoft.graph.downloadUrl'] || '';
    const customHost = (cfg.custom_host || '').trim();
    if (customHost && u) {
      const parsed = new URL(u);
      parsed.host = customHost;
      u = parsed.toString();
    }
    return { url: u };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const dirName = path.substring(path.lastIndexOf('/') + 1);
    const url = `${this.getMetaUrl(cfg, parentPath)}/children`;
    await this.request(url, cfg, {
      method: 'POST',
      body: JSON.stringify({
        name: dirName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      }),
    });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const url = this.getMetaUrl(cfg, path);
    await this.request(url, cfg, {
      method: 'PATCH',
      body: JSON.stringify({ name: newName }),
    });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const dstDir = await this.get(dst, cfg);
    const url = `${this.getMetaUrl(cfg, src)}/copy`;
    await this.request(url, cfg, {
      method: 'POST',
      body: JSON.stringify({
        parentReference: {
          driveId: (dstDir as any).id ? '' : '',
          id: (dstDir as any).id || '',
        },
        name: src.split('/').pop() || '',
      }),
    });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const dstDir = await this.get(dst, cfg);
    const url = this.getMetaUrl(cfg, src);
    await this.request(url, cfg, {
      method: 'PATCH',
      body: JSON.stringify({
        parentReference: {
          id: (dstDir as any).id || 'root',
        },
        name: src.split('/').pop() || '',
      }),
    });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const url = this.getMetaUrl(cfg, path);
    await this.request(url, cfg, { method: 'DELETE' });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    if (file.byteLength <= 4 * 1024 * 1024) {
      await this.putSmall(path, file, contentType, cfg);
    } else {
      await this.putLarge(path, file, contentType, cfg);
    }
  }

  // Small file upload: PUT content then PATCH metadata (mirrors OpenList upSmall)
  private async putSmall(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const url = `${this.getMetaUrl(cfg, path)}/content`;
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${this.accessToken}`);
    headers.set('Content-Type', contentType);
    let resp = await fetch(url, { method: 'PUT', headers, body: file });
    if (resp.status === 401) {
      await this.refreshTokenFlow(cfg);
      headers.set('Authorization', `Bearer ${this.accessToken}`);
      resp = await fetch(url, { method: 'PUT', headers, body: file });
    }
    if (!resp.ok) {
      throw new Error(`onedrive: Failed to upload new file(path=${path}): ${resp.status}`);
    }
  }

  // Large file upload via upload session (mirrors OpenList upBig)
  private async putLarge(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const url = `${this.getMetaUrl(cfg, path)}/createUploadSession`;
    const session = await this.request(url, cfg, {
      method: 'POST',
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
    });

    const uploadUrl = session?.uploadUrl;
    if (!uploadUrl) {
      throw new Error('onedrive: failed to get uploadUrl');
    }

    const chunkSize = this.chunkSize * 1024 * 1024;
    const total = file.byteLength;
    let offset = 0;

    while (offset < total) {
      const chunk = file.slice(offset, Math.min(offset + chunkSize, total));
      const end = Math.min(offset + chunkSize - 1, total - 1);
      const headers = new Headers();
      headers.set('Content-Range', `bytes ${offset}-${end}/${total}`);
      headers.set('Content-Length', String(chunk.byteLength));
      const resp = await fetch(uploadUrl, {
        method: 'PUT',
        headers,
        body: chunk,
      });
      if (resp.status >= 500 && resp.status <= 504) {
        // retry once
        const retry = await fetch(uploadUrl, {
          method: 'PUT',
          headers,
          body: chunk,
        });
        if (![200, 201, 202].includes(retry.status)) {
          throw new Error(`onedrive: upload chunk failed: ${retry.status}`);
        }
      } else if (![200, 201, 202].includes(resp.status)) {
        throw new Error(`onedrive: upload chunk failed: ${resp.status}`);
      }
      offset += chunkSize;
    }
  }
}

// Register this driver
registerDriver(OneDriveDriver, onedriveConfig, onedriveAdditional);
