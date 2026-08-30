/**
 * Yandex.Disk Driver
 * Referenced from OpenList's official drivers/yandex_disk:
 * - Path-based REST API (no folder ids needed)
 * - OAuth token refreshed via refresh_token (online API or local client)
 * - List / download / mkdir / rename / move / copy / remove / upload
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const yandexDiskConfig: DriverConfig = {
  name: 'YandexDisk',
  label: 'Yandex.Disk',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

export const yandexDiskAdditional: DriverItem[] = [
  { name: 'refresh_token', type: 'string', default: '', options: '', required: true, help: 'Refresh token' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,path,created,modified,size', required: false, help: 'Sort field' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: 'Sort direction' },
  { name: 'use_online_api', type: 'bool', default: 'true', options: '', required: false, help: 'Use online API to refresh token (no client id needed)' },
  { name: 'api_url_address', type: 'string', default: 'https://api.oplist.org/yandexui/renewapi', options: '', required: false, help: 'Online token refresh API address' },
  { name: 'client_id', type: 'string', default: '', options: '', required: false, help: 'OAuth client ID (when online API is disabled)' },
  { name: 'client_secret', type: 'string', default: '', options: '', required: false, help: 'OAuth client secret (when online API is disabled)' },
];

interface YandexFile {
  size: number;
  name: string;
  modified: string;
  file?: string;
  preview?: string;
  path?: string;
  type: string;
}

interface FilesResp {
  _embedded?: { items: YandexFile[]; total: number };
}

interface DownResp {
  href: string;
  method: string;
}

/**
 * Yandex.Disk Driver Implementation
 */
export class YandexDiskDriver implements Driver {
  private accessToken = '';
  private cfg: Record<string, any> = {};

  config(): DriverConfig {
    return yandexDiskConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.accessToken = '';
    await this.refreshToken();
  }

  // Refresh the OAuth token, either via the online API (no client secret) or
  // the standard Yandex OAuth endpoint. Mirrors refreshToken() in the Go driver.
  private async refreshToken(): Promise<void> {
    const useOnline = this.cfg.use_online_api !== 'false';
    if (useOnline && this.cfg.api_url_address) {
      const params = new URLSearchParams({
        refresh_ui: this.cfg.refresh_token,
        server_use: 'true',
        driver_txt: 'yandexui_go',
      });
      const resp = await fetch(`${this.cfg.api_url_address}?${params.toString()}`);
      const body: any = await resp.json().catch(() => ({}));
      if (!body.refresh_token || !body.access_token) {
        throw new Error(
          body.text
            ? `failed to refresh token: ${body.text}`
            : 'empty token returned from official API, a wrong refresh token may have been used'
        );
      }
      this.accessToken = body.access_token;
      this.cfg.refresh_token = body.refresh_token;
      return;
    }
    if (!this.cfg.client_id || !this.cfg.client_secret) {
      throw new Error('empty ClientID or ClientSecret');
    }
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.cfg.refresh_token,
      client_id: this.cfg.client_id,
      client_secret: this.cfg.client_secret,
    });
    const resp = await fetch('https://oauth.yandex.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const body: any = await resp.json().catch(() => ({}));
    if (body.error) {
      throw new Error(`${body.error}: ${body.error_description || ''}`.trim());
    }
    this.accessToken = body.access_token;
    if (body.refresh_token) this.cfg.refresh_token = body.refresh_token;
  }

  // Call the Yandex.Disk resources API. On 401 (UnauthorizedError) the token is
  // refreshed once and the request is retried.
  private async request(
    pathname: string,
    method: string,
    params?: Record<string, string>,
    retried = false
  ): Promise<any> {
    const url = 'https://cloud-api.yandex.net/v1/disk/resources' + pathname;
    const query = params ? '?' + new URLSearchParams(params).toString() : '';
    const resp = await fetch(url + query, {
      method,
      headers: { 'Authorization': 'OAuth ' + this.accessToken },
    });
    const body: any = await resp.json().catch(() => ({}));
    if (body.error) {
      if (body.error === 'UnauthorizedError' && !retried) {
        await this.refreshToken();
        return this.request(pathname, method, params, true);
      }
      throw new Error(body.description || body.error);
    }
    return body;
  }

  private async getFiles(path: string): Promise<YandexFile[]> {
    const limit = 100;
    const files: YandexFile[] = [];
    let offset = 0;
    for (;;) {
      const query: Record<string, string> = { path, limit: String(limit), offset: String(offset) };
      if (this.cfg.order_by) {
        query.sort = (this.cfg.order_direction === 'desc' ? '-' : '') + this.cfg.order_by;
      }
      const resp = await this.request('', 'GET', query) as FilesResp;
      const items = resp._embedded?.items || [];
      files.push(...items);
      if ((resp._embedded?.total || 0) <= offset + limit) break;
      offset += limit;
    }
    return files;
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const files = await this.getFiles(path);
    const content = files.map(f => {
      const common = {
        name: f.name,
        modified: f.modified ? new Date(f.modified).toISOString() : new Date().toISOString(),
        thumb: f.preview || undefined,
        id: f.path,
      };
      return f.type === 'dir'
        ? createDirObj(common)
        : createFileObj({ ...common, size: f.size || 0 });
    });
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const name = path.split('/').pop() || path;
    return createFileObj({ name, modified: new Date().toISOString() });
  }

  // Get the direct download href. Mirrors Link() in the Go driver.
  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const resp = await this.request('/download', 'GET', { path }) as DownResp;
    if (!resp.href) {
      throw new Error('yandex_disk: failed to get download url');
    }
    return { url: resp.href };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    await this.request('', 'PUT', { path });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf('/'));
    const target = parent ? `${parent}/${newName}` : `/${newName}`;
    await this.request('/move', 'POST', { from: path, path: target, overwrite: 'true' });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const name = src.split('/').pop() || '';
    const target = dst.endsWith('/') ? dst + name : `${dst}/${name}`;
    await this.request('/copy', 'POST', { from: src, path: target, overwrite: 'true' });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const name = src.split('/').pop() || '';
    const target = dst.endsWith('/') ? dst + name : `${dst}/${name}`;
    await this.request('/move', 'POST', { from: src, path: target, overwrite: 'true' });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    await this.request('', 'DELETE', { path });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const resp = await this.request('/upload', 'GET', { path, overwrite: 'true' }) as UploadResp;
    if (!resp.href) {
      throw new Error('yandex_disk: failed to get upload url');
    }
    const upResp = await fetch(resp.href, {
      method: resp.method || 'PUT',
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': String(file.byteLength),
      },
      body: file,
    });
    if (!upResp.ok) {
      throw new Error(`yandex_disk: upload failed: HTTP ${upResp.status}`);
    }
  }
}

interface UploadResp {
  href: string;
  method: string;
}

registerDriver(YandexDiskDriver, yandexDiskConfig, yandexDiskAdditional);
