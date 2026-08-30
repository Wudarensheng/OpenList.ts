/**
 * 百度网盘 (Baidu Netdisk) Driver
 * Referenced from OpenList's official drivers/baidu_netdisk:
 * - Refresh-token auth (online API or local OAuth)
 * - Path-based list via /rest/2.0/xpan/file
 * - Official download link via filemetas + HEAD redirect
 * - mkdir / rename / move / copy / delete via filemanager
 * - Upload (rapid + sliced) is not ported
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const baiduNetdiskConfig: DriverConfig = {
  name: 'BaiduNetdisk',
  label: '百度网盘',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: true,
  default_root: '/',
};

export const baiduNetdiskAdditional: DriverItem[] = [
  { name: 'refresh_token', type: 'string', default: '', options: '', required: true, help: 'Refresh token' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,time,size', required: false, help: 'Sort field' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: 'Sort direction' },
  { name: 'use_online_api', type: 'bool', default: 'true', options: '', required: false, help: 'Use online API to refresh token' },
  { name: 'api_url_address', type: 'string', default: 'https://api.oplist.org/baiduyun/renewapi', options: '', required: false, help: 'Online token refresh API address' },
  { name: 'client_id', type: 'string', default: '', options: '', required: false, help: 'OAuth client ID (when online API is disabled)' },
  { name: 'client_secret', type: 'string', default: '', options: '', required: false, help: 'OAuth client secret' },
];

const API = 'https://pan.baidu.com/rest/2.0';

interface BaiduFile {
  fs_id: number;
  path: string;
  server_filename: string;
  size: number;
  isdir: number;
  category: number;
  server_mtime: number;
  server_ctime: number;
  thumbs?: { url3?: string };
}

/**
 * 百度网盘 Driver Implementation
 */
export class BaiduNetdiskDriver implements Driver {
  private accessToken = '';
  private refreshTokenValue = '';
  private cfg: Record<string, any> = {};

  config(): DriverConfig {
    return baiduNetdiskConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.refreshTokenValue = cfg.refresh_token || '';
    await this.refreshToken();
  }

  private async refreshToken(): Promise<void> {
    const useOnline = this.cfg.use_online_api !== 'false';
    if (useOnline && this.cfg.api_url_address) {
      const params = new URLSearchParams({
        refresh_ui: this.refreshTokenValue,
        server_use: 'true',
        driver_txt: 'baiduyun_go',
      });
      const resp = await fetch(`${this.cfg.api_url_address}?${params.toString()}`);
      const body: any = await resp.json().catch(() => ({}));
      if (!body.refresh_token || !body.access_token) {
        throw new Error(body.text || 'empty token returned from official API, a wrong refresh token may have been used');
      }
      this.accessToken = body.access_token;
      this.refreshTokenValue = body.refresh_token;
      return;
    }
    if (!this.cfg.client_id || !this.cfg.client_secret) {
      throw new Error('empty ClientID or ClientSecret');
    }
    const q = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshTokenValue,
      client_id: this.cfg.client_id,
      client_secret: this.cfg.client_secret,
    });
    const resp = await fetch(`https://openapi.baidu.com/oauth/2.0/token?${q.toString()}`);
    const body: any = await resp.json().catch(() => ({}));
    if (body.error) {
      throw new Error(`${body.error}: ${body.error_description || ''}`.trim());
    }
    this.accessToken = body.access_token;
    if (body.refresh_token) this.refreshTokenValue = body.refresh_token;
  }

  private async request(
    pathname: string,
    method: string,
    opts: { params?: Record<string, string>; form?: Record<string, string> } = {},
    retried = false
  ): Promise<any> {
    const u = new URL(API + pathname);
    u.searchParams.set('access_token', this.accessToken);
    for (const [k, v] of Object.entries(opts.params || {})) u.searchParams.set(k, v);
    const init: RequestInit = { method, headers: {} };
    if (opts.form) {
      init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      init.body = new URLSearchParams(opts.form).toString();
    }
    const resp = await fetch(u.toString(), init);
    const data: any = await resp.json().catch(() => ({}));
    if (data.errno !== 0) {
      if ((data.errno === 111 || data.errno === -6) && !retried) {
        await this.refreshToken();
        return this.request(pathname, method, opts, true);
      }
      throw new Error(`baidu: errno ${data.errno}`);
    }
    return data;
  }

  private async getFiles(dir: string): Promise<BaiduFile[]> {
    const files: BaiduFile[] = [];
    let start = 0;
    const limit = 1000;
    for (;;) {
      const params: Record<string, string> = { method: 'list', dir, web: 'web', start: String(start), limit: String(limit) };
      if (this.cfg.order_by) {
        params.order = this.cfg.order_by;
        if (this.cfg.order_direction === 'desc') params.desc = '1';
      }
      const resp = await this.request('/xpan/file', 'GET', { params });
      const list: BaiduFile[] = resp.list || [];
      files.push(...list.filter(f => !this.cfg.only_list_video_file || f.isdir === 1 || f.category === 1));
      if (list.length < limit) break;
      start += limit;
    }
    return files;
  }

  private fileToObj(f: BaiduFile): Obj {
    const name = f.server_filename || (f.path.split('/').pop() || '');
    const common = {
      name,
      size: f.size || 0,
      modified: f.server_mtime ? new Date(f.server_mtime * 1000).toISOString() : new Date().toISOString(),
      created: f.server_ctime ? new Date(f.server_ctime * 1000).toISOString() : undefined,
      thumb: f.thumbs?.url3 || undefined,
      id: String(f.fs_id),
      path: f.path,
    };
    return f.isdir === 1 ? createDirObj(common) : createFileObj(common);
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const files = await this.getFiles(path);
    const content = files.map(f => this.fileToObj(f));
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').pop() || path;
    const files = await this.getFiles(parent);
    const found = files.find(f => (f.server_filename || f.path.split('/').pop()) === name);
    if (found) return this.fileToObj(found);
    return createFileObj({ name, modified: new Date().toISOString() });
  }

  // Resolve the fs_id of a file at `path` by listing its parent.
  private async resolveFile(path: string): Promise<BaiduFile> {
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').pop() || '';
    const files = await this.getFiles(parent);
    const found = files.find(f => (f.server_filename || f.path.split('/').pop()) === name);
    if (!found) throw new Error(`baidu: path not found: ${path}`);
    return found;
  }

  // Official download link: filemetas -> dlink -> follow 302 via HEAD.
  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const file = await this.resolveFile(path);
    const resp = await this.request('/xpan/multimedia', 'GET', {
      params: { method: 'filemetas', fsids: `[${file.fs_id}]`, dlink: '1' },
    });
    const dlink: string = resp.list?.[0]?.dlink || '';
    if (!dlink) throw new Error('baidu: failed to get dlink');
    const u = `${dlink}&access_token=${this.accessToken}`;
    const head = await fetch(u, { method: 'HEAD', headers: { 'User-Agent': 'pan.baidu.com' }, redirect: 'manual' });
    const finalUrl = head.headers.get('location') || u;
    return { url: finalUrl, header: { 'User-Agent': 'pan.baidu.com' } };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    await this.request('/xpan/file', 'POST', {
      params: { method: 'create' },
      form: { path, size: '0', isdir: '1', rtype: '3' },
    });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    await this.request('/xpan/file', 'POST', {
      params: { method: 'filemanager', opera: 'rename' },
      form: { async: '0', ondup: 'fail', filelist: JSON.stringify([{ path, newname: newName }]) },
    });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const name = src.split('/').pop() || '';
    await this.request('/xpan/file', 'POST', {
      params: { method: 'filemanager', opera: 'move' },
      form: { async: '0', ondup: 'fail', filelist: JSON.stringify([{ path: src, dest: dst, newname: name }]) },
    });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const name = src.split('/').pop() || '';
    await this.request('/xpan/file', 'POST', {
      params: { method: 'filemanager', opera: 'copy' },
      form: { async: '0', ondup: 'fail', filelist: JSON.stringify([{ path: src, dest: dst, newname: name }]) },
    });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    await this.request('/xpan/file', 'POST', {
      params: { method: 'filemanager', opera: 'delete' },
      form: { async: '0', ondup: 'fail', filelist: JSON.stringify([path]) },
    });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('baidu: upload not supported (rapid/sliced upload not ported)');
  }
}

registerDriver(BaiduNetdiskDriver, baiduNetdiskConfig, baiduNetdiskAdditional);
