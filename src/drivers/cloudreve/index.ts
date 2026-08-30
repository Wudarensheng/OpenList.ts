/**
 * Cloudreve Driver
 * Referenced from OpenList's official drivers/cloudreve:
 * - REST API (api/v3) with cloudreve-session cookie
 * - Auth via cookie, or username/password when the site has no captcha
 * - List / download / mkdir / rename / move / copy / delete
 * - Upload is not ported (needs captcha/OCR + multi-strategy upload)
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const cloudreveConfig: DriverConfig = {
  name: 'Cloudreve',
  label: 'Cloudreve',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: true,
  default_root: '/',
};

export const cloudreveAdditional: DriverItem[] = [
  { name: 'address', type: 'string', default: '', options: '', required: true, help: 'Cloudreve server address' },
  { name: 'username', type: 'string', default: '', options: '', required: false, help: 'Username (for login; captcha must be off)' },
  { name: 'password', type: 'string', default: '', options: '', required: false, help: 'Password' },
  { name: 'cookie', type: 'string', default: '', options: '', required: false, help: 'cloudreve-session cookie value (preferred)' },
  { name: 'custom_ua', type: 'string', default: '', options: '', required: false, help: 'Custom User-Agent' },
  { name: 'root_folder_path', type: 'string', default: '/', options: '', required: false, help: 'Root folder path' },
];

interface CloudreveObject {
  id: string;
  name: string;
  path: string;
  pic: string;
  size: number;
  type: string; // file / dir
  date: string;
  create_date: string;
}

interface DirectoryResp {
  objects: CloudreveObject[];
}

interface ConfigResp {
  login_captcha?: boolean;
}

/**
 * Cloudreve Driver Implementation
 */
export class CloudreveDriver implements Driver {
  private cookie = '';
  private cfg: Record<string, any> = {};

  config(): DriverConfig {
    return cloudreveConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.cfg.address = (cfg.address || '').replace(/\/+$/, '');
    if (cfg.cookie) {
      this.cookie = cfg.cookie;
    } else if (cfg.username && cfg.password) {
      await this.login();
    } else {
      throw new Error('cloudreve: please provide cookie or username+password');
    }
  }

  private ua(): string {
    return this.cfg.custom_ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
  }

  private async login(): Promise<void> {
    const site = await this.request('/site/config', 'GET', {}, true) as ConfigResp;
    if (site.login_captcha) {
      throw new Error('cloudreve: captcha login is not supported, please provide a cookie');
    }
    await this.request('/user/session', 'POST', {
      username: this.cfg.username,
      Password: this.cfg.password,
      captchaCode: '',
    }, true);
    if (!this.cookie) {
      throw new Error('cloudreve: login failed (no session cookie returned)');
    }
  }

  private async request(
    path: string,
    method: string,
    body?: unknown,
    noRetry = false
  ): Promise<any> {
    const init: RequestInit = {
      method,
      headers: {
        'Cookie': `cloudreve-session=${this.cookie}`,
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': this.ua(),
      },
    };
    if (body !== undefined) {
      init.headers = { ...init.headers as Record<string, string>, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(`${this.cfg.address}/api/v3${path}`, init);
    const data: any = await resp.json().catch(() => ({}));
    // Capture a fresh session cookie if the server rotated it.
    const setCookie = resp.headers.get('set-cookie');
    if (setCookie) {
      const m = setCookie.match(/cloudreve-session=([^;]+)/);
      if (m) this.cookie = m[1];
    }
    if (data.code !== 0) {
      if (data.code === 401 && !noRetry && this.cfg.username && this.cfg.password) {
        await this.login();
        return this.request(path, method, body, true);
      }
      throw new Error(data.msg || `cloudreve: API error ${data.code}`);
    }
    return data.data;
  }

  // List the parent to resolve a path to its object id.
  private async resolveObject(path: string): Promise<CloudreveObject> {
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').pop() || '';
    const dir = await this.request(`/directory${parent}`, 'GET') as DirectoryResp;
    const obj = (dir.objects || []).find(o => o.name === name);
    if (!obj) throw new Error(`cloudreve: path not found: ${path}`);
    return obj;
  }

  private srcOf(o: CloudreveObject): Record<string, string[]> {
    return o.type === 'dir' ? { dirs: [o.id], items: [] } : { dirs: [], items: [o.id] };
  }

  private objToObj(o: CloudreveObject, parentPath: string): Obj {
    const common = {
      name: o.name,
      modified: o.date || new Date().toISOString(),
      created: o.create_date || undefined,
      id: o.id,
      thumb: o.pic || undefined,
      path: parentPath + '/' + o.name,
    };
    return o.type === 'dir' ? createDirObj(common) : createFileObj({ ...common, size: o.size || 0 });
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const dir = await this.request(`/directory${path}`, 'GET') as DirectoryResp;
    const content = (dir.objects || []).map(o => this.objToObj(o, path));
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const o = await this.resolveObject(path);
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    return this.objToObj(o, parent);
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const o = await this.resolveObject(path);
    const url = await this.request(`/file/download/${o.id}`, 'PUT') as string;
    return {
      url: String(url).startsWith('/api') ? this.cfg.address + String(url) : String(url),
      header: { 'Referer': this.cfg.address, 'User-Agent': this.ua() },
    };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    await this.request('/directory', 'PUT', { path });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const o = await this.resolveObject(path);
    await this.request('/object/rename', 'PATCH', { action: 'rename', new_name: newName, src: this.srcOf(o) });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const o = await this.resolveObject(src);
    await this.request('/object', 'PATCH', {
      action: 'move',
      src_dir: src.substring(0, src.lastIndexOf('/')) || '/',
      dst,
      src: this.srcOf(o),
    });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const o = await this.resolveObject(src);
    await this.request('/object/copy', 'POST', {
      src_dir: src.substring(0, src.lastIndexOf('/')) || '/',
      dst,
      src: this.srcOf(o),
    });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const o = await this.resolveObject(path);
    await this.request('/object', 'DELETE', this.srcOf(o));
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('cloudreve: upload not supported (captcha/upload strategies not ported)');
  }
}

registerDriver(CloudreveDriver, cloudreveConfig, cloudreveAdditional);
