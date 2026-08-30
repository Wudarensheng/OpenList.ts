/**
 * Seafile Driver
 * Referenced from OpenList's official drivers/seafile:
 * - Pure REST API with Token auth (or username/password login)
 * - Libraries (repos) at root, items listed via /api2/repos/{id}/dir/
 * - Download link via /file/?reuse=1, upload via upload-link
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const seafileConfig: DriverConfig = {
  name: 'Seafile',
  label: 'Seafile',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

export const seafileAdditional: DriverItem[] = [
  { name: 'address', type: 'string', default: '', options: '', required: true, help: 'Seafile server address' },
  { name: 'username', type: 'string', default: '', options: '', required: false, help: 'Username (for password login)' },
  { name: 'password', type: 'string', default: '', options: '', required: false, help: 'Password' },
  { name: 'token', type: 'string', default: '', options: '', required: false, help: 'Auth token (preferred over username/password)' },
  { name: 'repoId', type: 'string', default: '', options: '', required: false, help: 'Library (repo) id; empty = list all libraries' },
  { name: 'repoPwd', type: 'string', default: '', options: '', required: false, help: 'Encrypted library password' },
  { name: 'root_folder_path', type: 'string', default: '/', options: '', required: false, help: 'Root folder path, e.g. /mylib/sub' },
];

interface RepoItem {
  id: string;
  type: string; // repo, dir, file
  name: string;
  size: number;
  mtime: number;
  encrypted?: boolean;
}

interface Library {
  id: string;
  name: string;
  type: string;
  encrypted?: boolean;
}

interface UploadLinkResp {
  href: string;
}

/**
 * Seafile Driver Implementation
 */
export class SeafileDriver implements Driver {
  private authorization = '';
  private cfg: Record<string, any> = {};

  config(): DriverConfig {
    return seafileConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.cfg.address = (cfg.address || '').replace(/\/+$/, '');
    await this.getToken();
  }

  private async getToken(): Promise<void> {
    if (this.cfg.token) {
      this.authorization = `Token ${this.cfg.token}`;
      return;
    }
    const form = new URLSearchParams({
      username: this.cfg.username || '',
      password: this.cfg.password || '',
    });
    const resp = await fetch(`${this.cfg.address}/api2/auth-token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!resp.ok) {
      throw new Error(`seafile: get token failed: ${resp.status}`);
    }
    const data = await resp.json().catch(() => ({})) as { token?: string };
    if (!data.token) throw new Error('seafile: no token in auth response');
    this.authorization = `Token ${data.token}`;
  }

  // Unified request with token; refresh the token once on 401.
  private async request(
    pathname: string,
    method: string,
    opts: { params?: Record<string, string>; form?: Record<string, string>; body?: unknown; raw?: boolean } = {},
    retried = false
  ): Promise<any> {
    const url = pathname.startsWith('http') ? pathname : `${this.cfg.address}${pathname}`;
    const query = opts.params ? '?' + new URLSearchParams(opts.params).toString() : '';
    const init: RequestInit = {
      method,
      headers: { 'Authorization': this.authorization },
    };
    if (opts.form) {
      init.headers = { ...init.headers as Record<string, string>, 'Content-Type': 'application/x-www-form-urlencoded' };
      init.body = new URLSearchParams(opts.form).toString();
    } else if (opts.body !== undefined) {
      init.headers = { ...init.headers as Record<string, string>, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    const resp = await fetch(url + query, init);
    if (resp.status === 401 && !retried) {
      await this.getToken();
      return this.request(pathname, method, opts, true);
    }
    if (resp.status >= 400) {
      const text = await resp.text().catch(() => '');
      throw new Error(`seafile: request failed (${resp.status}): ${text.slice(0, 200)}`);
    }
    if (opts.raw) return resp.text();
    return resp.json().catch(() => ({}));
  }

  private joinPath(a: string, b: string): string {
    const pa = (a || '/').replace(/\/+$/, '');
    const pb = (b || '/').replace(/^\/+/, '');
    if (!pb) return pa || '/';
    return pa === '/' ? '/' + pb : pa + '/' + pb;
  }

  private async findLibrary(name: string): Promise<Library> {
    const repos = await this.request('/api2/repos/', 'GET') as Library[];
    const lib = repos.find(r => r.name === name);
    if (!lib) throw new Error(`seafile: library not found: ${name}`);
    return lib;
  }

  // Resolve a storage-relative path to { repoId, inner }.
  // With a configured repoId, everything maps into that library. Otherwise the
  // first path segment (or the root_folder_path prefix) is the library name.
  private async resolve(path: string): Promise<{ repoId: string | null; inner: string }> {
    const base = this.cfg.root_folder_path || '/';
    if (this.cfg.repoId) {
      return { repoId: this.cfg.repoId, inner: this.joinPath(base, path) };
    }
    const segments = [...(base === '/' ? [] : base.split('/').filter(Boolean)), ...path.split('/').filter(Boolean)];
    if (segments.length === 0) return { repoId: null, inner: '/' };
    const lib = await this.findLibrary(segments[0]);
    const inner = '/' + segments.slice(1).join('/');
    return { repoId: lib.id, inner: inner === '/' ? '/' : inner };
  }

  private itemToObj(it: RepoItem, inner: string): Obj {
    const common = {
      name: it.name,
      size: it.size || 0,
      modified: it.mtime ? new Date(it.mtime * 1000).toISOString() : new Date().toISOString(),
      id: it.id,
      path: inner,
    };
    return it.type === 'dir' ? createDirObj(common) : createFileObj(common);
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const { repoId, inner } = await this.resolve(path);
    if (!repoId) {
      // Root: list libraries.
      const repos = await this.request('/api2/repos/', 'GET') as Library[];
      const content = repos.map(r => createDirObj({
        name: r.name,
        modified: new Date().toISOString(),
        id: r.id,
      }));
      return { content, total: content.length };
    }
    const items = await this.request(`/api2/repos/${repoId}/dir/`, 'GET', {
      params: { p: inner },
    }) as RepoItem[];
    const content = items.map(it => {
      const childPath = this.joinPath(inner, it.name);
      return this.itemToObj(it, childPath);
    });
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const { repoId, inner } = await this.resolve(path);
    if (!repoId) throw new Error('seafile: invalid path');
    const parent = inner.substring(0, inner.lastIndexOf('/')) || '/';
    const name = inner.split('/').pop() || inner;
    const items = await this.request(`/api2/repos/${repoId}/dir/`, 'GET', { params: { p: parent } }) as RepoItem[];
    const found = items.find(it => it.name === name);
    if (found) return this.itemToObj(found, inner);
    return createFileObj({ name, modified: new Date().toISOString() });
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const { repoId, inner } = await this.resolve(path);
    if (!repoId) throw new Error('seafile: invalid path');
    const text = await this.request(`/api2/repos/${repoId}/file/`, 'GET', {
      params: { p: inner, reuse: '1' },
      raw: true,
    }) as string;
    const url = text.replace(/^"|"$/g, '').replace(/^\\"|\\"$/g, '');
    return { url };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').pop() || '';
    const { repoId, inner } = await this.resolve(parent);
    if (!repoId) throw new Error('seafile: invalid path');
    await this.request(`/api2/repos/${repoId}/dir/`, 'POST', {
      params: { p: this.joinPath(inner, name) },
      form: { operation: 'mkdir' },
    });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const { repoId, inner } = await this.resolve(path);
    if (!repoId) throw new Error('seafile: invalid path');
    await this.request(`/api2/repos/${repoId}/file/`, 'POST', {
      params: { p: inner },
      form: { operation: 'rename', newname: newName },
    });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const s = await this.resolve(src);
    const d = await this.resolve(dst);
    if (!s.repoId || !d.repoId) throw new Error('seafile: invalid path');
    await this.request(`/api2/repos/${s.repoId}/file/`, 'POST', {
      params: { p: s.inner },
      form: { operation: 'move', dst_repo: d.repoId, dst_dir: d.inner },
    });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const s = await this.resolve(src);
    const d = await this.resolve(dst);
    if (!s.repoId || !d.repoId) throw new Error('seafile: invalid path');
    await this.request(`/api2/repos/${s.repoId}/file/`, 'POST', {
      params: { p: s.inner },
      form: { operation: 'copy', dst_repo: d.repoId, dst_dir: d.inner },
    });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const { repoId, inner } = await this.resolve(path);
    if (!repoId) throw new Error('seafile: invalid path');
    await this.request(`/api2/repos/${repoId}/file/`, 'DELETE', {
      params: { p: inner },
    });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').pop() || '';
    const { repoId, inner } = await this.resolve(parent);
    if (!repoId) throw new Error('seafile: invalid path');
    const linkText = await this.request(`/api2/repos/${repoId}/upload-link/`, 'GET', {
      params: { p: inner },
      raw: true,
    }) as string;
    const uploadUrl = linkText.replace(/^"|"$/g, '');
    const form = new FormData();
    form.append('parent_dir', inner);
    form.append('file', new Blob([file], { type: contentType || 'application/octet-stream' }), name);
    const resp = await fetch(uploadUrl, { method: 'POST', body: form });
    if (!resp.ok) {
      throw new Error(`seafile: upload failed: HTTP ${resp.status}`);
    }
  }
}

registerDriver(SeafileDriver, seafileConfig, seafileAdditional);
