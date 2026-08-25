/**
 * OneDrive APP Driver
 * Completely rewritten to match OpenList's official drivers/onedrive_app:
 * - App-only authentication via client_credentials grant
 * - Region-aware Graph endpoints (global / cn / us / de)
 * - Access via user email: /v1.0/users/{email}/drive
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj, encodePath } from '../base';

// Per-region hosts, mirroring onedriveHostMap in OpenList's onedrive_app/util.go
const HOSTS: Record<string, { oauth: string; api: string }> = {
  global: { oauth: 'https://login.microsoftonline.com', api: 'https://graph.microsoft.com' },
  cn: { oauth: 'https://login.chinacloudapi.cn', api: 'https://microsoftgraph.chinacloudapi.cn' },
  us: { oauth: 'https://login.microsoftonline.us', api: 'https://graph.microsoft.us' },
  de: { oauth: 'https://login.microsoftonline.de', api: 'https://graph.microsoft.de' },
};

export const onedriveAppConfig: DriverConfig = {
  name: 'OnedriveAPP',
  label: 'OneDrive APP',
  local_sort: false,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

export const onedriveAppAdditional: DriverItem[] = [
  { name: 'region', type: 'select', default: 'global', options: 'global,cn,us,de', required: true, help: 'Region' },
  { name: 'client_id', type: 'string', default: '', options: '', required: true, help: 'Application (client) ID' },
  { name: 'client_secret', type: 'string', default: '', options: '', required: true, help: 'Client secret' },
  { name: 'tenant_id', type: 'string', default: '', options: '', required: false, help: 'Tenant ID' },
  { name: 'email', type: 'string', default: '', options: '', required: false, help: 'OneDrive account email' },
  { name: 'chunk_size', type: 'number', default: '5', options: '', required: false, help: 'Upload chunk size (MB)' },
  { name: 'custom_host', type: 'string', default: '', options: '', required: false, help: 'Custom host for download link' },
  { name: 'disable_disk_usage', type: 'bool', default: 'false', options: '', required: false, help: 'Disable remaining space display' },
  { name: 'enable_direct_upload', type: 'bool', default: 'false', options: '', required: false, help: 'Enable direct upload from client' },
];

interface TokenResponse {
  access_token: string;
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
 * OneDrive APP Driver Implementation (referencing OpenList drivers/onedrive_app)
 */
export class OnedriveAppDriver implements Driver {
  private accessToken = '';
  private chunkSize = 5;

  config(): DriverConfig {
    return onedriveAppConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    if ((cfg.chunk_size || 0) < 1) {
      this.chunkSize = 5;
    } else {
      this.chunkSize = cfg.chunk_size;
    }
    await this.accessTokenFlow(cfg);
  }

  private apiHost(cfg: Record<string, any>): string {
    const region = (cfg.region || 'global').trim() || 'global';
    return (HOSTS[region] || HOSTS.global).api;
  }

  private oauthHost(cfg: Record<string, any>): string {
    const region = (cfg.region || 'global').trim() || 'global';
    return (HOSTS[region] || HOSTS.global).oauth;
  }

  // Build the meta URL. Mirrors GetMetaUrl in OpenList's onedrive_app:
  // uses the user's email to address the drive.
  private getMetaUrl(cfg: Record<string, any>, path: string): string {
    const api = this.apiHost(cfg);
    const email = (cfg.email || '').trim();
    const p = encodePath(path);
    if (p === '/' || p === '\\') {
      return `${api}/v1.0/users/${email}/drive/root`;
    }
    return `${api}/v1.0/users/${email}/drive/root:${p}:`;
  }

  // Acquire an app-only access token using client_credentials grant.
  // Mirrors accessToken()/_accessToken() in OpenList's onedrive_app/util.go
  private async accessTokenFlow(cfg: Record<string, any>): Promise<void> {
    let err: Error | null = null;
    for (let i = 0; i < 3; i++) {
      try {
        await this._accessToken(cfg);
        err = null;
        break;
      } catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
      }
    }
    if (err) throw err;
  }

  private async _accessToken(cfg: Record<string, any>): Promise<void> {
    const api = this.apiHost(cfg);
    const tenantId = (cfg.tenant_id || 'common').trim() || 'common';
    const url = `${this.oauthHost(cfg)}/${tenantId}/oauth2/token`;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.client_id || '',
      client_secret: cfg.client_secret || '',
      resource: `${api}/`,
      scope: `${api}/.default`,
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
    if (!data.access_token) {
      throw new Error('empty access token');
    }
    this.accessToken = data.access_token;
  }

  private async request(url: string, cfg: Record<string, any>, options: RequestInit = {}, noRetry = false): Promise<any> {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${this.accessToken}`);
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let resp = await fetch(url, { ...options, headers });

    const parse = async (r: Response): Promise<any> => {
      const text = await r.text();
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    };

    let json = await parse(resp);

    if (!resp.ok) {
      const code = json?.error?.code || '';
      const message = json?.error?.message || (await resp.clone().text());
      if (code === 'InvalidAuthenticationToken' && !noRetry) {
        await this.accessTokenFlow(cfg);
        headers.set('Authorization', `Bearer ${this.accessToken}`);
        resp = await fetch(url, { ...options, headers });
        json = await parse(resp);
        if (!resp.ok) {
          throw new Error(json?.error?.message || (await resp.clone().text()));
        }
        return json;
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

  private async putSmall(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const url = `${this.getMetaUrl(cfg, path)}/content`;
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${this.accessToken}`);
    headers.set('Content-Type', contentType);
    let resp = await fetch(url, { method: 'PUT', headers, body: file });
    if (resp.status === 401) {
      await this.accessTokenFlow(cfg);
      headers.set('Authorization', `Bearer ${this.accessToken}`);
      resp = await fetch(url, { method: 'PUT', headers, body: file });
    }
    if (!resp.ok) {
      throw new Error(`onedrive_app: Failed to upload new file(path=${path}): ${resp.status}`);
    }
  }

  private async putLarge(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const url = `${this.getMetaUrl(cfg, path)}/createUploadSession`;
    const session = await this.request(url, cfg, {
      method: 'POST',
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
    });

    const uploadUrl = session?.uploadUrl;
    if (!uploadUrl) {
      throw new Error('onedrive_app: failed to get uploadUrl');
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
        const retry = await fetch(uploadUrl, {
          method: 'PUT',
          headers,
          body: chunk,
        });
        if (![200, 201, 202].includes(retry.status)) {
          throw new Error(`onedrive_app: upload chunk failed: ${retry.status}`);
        }
      } else if (![200, 201, 202].includes(resp.status)) {
        throw new Error(`onedrive_app: upload chunk failed: ${resp.status}`);
      }
      offset += chunkSize;
    }
  }
}

// Register this driver
registerDriver(OnedriveAppDriver, onedriveAppConfig, onedriveAppAdditional);
