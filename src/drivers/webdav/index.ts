/**
 * WebDAV Driver (port of OpenList's drivers/webdav).
 * Mounts any WebDAV server (Nextcloud, Synology, rclone, ...) as a storage.
 *
 * The download link carries an Authorization header, so the worker's /d/ and
 * /p/ routes proxy the file through the worker (browsers cannot attach Basic
 * auth headers to cross-origin requests).
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const webdavConfig: DriverConfig = {
  name: 'WebDav',
  label: 'WebDAV',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

export const webdavAdditional: DriverItem[] = [
  { name: 'vendor', type: 'select', default: 'other', options: 'sharepoint,other', required: false, help: 'Vendor' },
  { name: 'address', type: 'string', default: '', options: '', required: true, help: 'Address (e.g. https://example.com/dav)' },
  { name: 'username', type: 'string', default: '', options: '', required: true, help: 'Username' },
  { name: 'password', type: 'string', default: '', options: '', required: true, help: 'Password' },
  { name: 'root_path', type: 'string', default: '/', options: '', required: false, help: 'Root path' },
];

export class WebDavDriver implements Driver {
  private address = '';
  private username = '';
  private password = '';
  private rootPath = '/';
  private vendor = 'other';

  config(): DriverConfig {
    return webdavConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    let address = (cfg.address || '').trim();
    if (address && !/^https?:\/\//i.test(address)) {
      address = 'https://' + address;
    }
    address = address.replace(/\/+$/, '');
    this.address = address;
    this.username = (cfg.username || '').toString();
    this.password = (cfg.password || '').toString();
    this.rootPath = (cfg.root_path || '/').replace(/\/+$/, '') || '/';
    this.vendor = (cfg.vendor || 'other').toString();
  }

  private authHeader(): string {
    return 'Basic ' + btoa(`${this.username}:${this.password}`);
  }

  // Join root_path + driver path into a WebDAV path (always starts with /).
  private getPath(path: string): string {
    const p = (path || '/').replace(/^\/+/, '');
    if (this.rootPath === '/') return '/' + p;
    return `${this.rootPath}/${p}`.replace(/\/+/g, '/') || '/';
  }

  private getUrl(davPath: string): string {
    const base = this.address + (davPath === '/' ? '/' : davPath);
    return base;
  }

  private async davFetch(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers || {});
    if (!headers.has('Authorization')) headers.set('Authorization', this.authHeader());
    return fetch(url, { ...init, headers });
  }

  // Parse a PROPFIND multistatus body into entries.
  private parseMultiStatus(xml: string, requestedPath: string): Array<{ name: string; href: string; is_dir: boolean; size: number; modified: string }> {
    const entries: Array<{ name: string; href: string; is_dir: boolean; size: number; modified: string }> = [];

    // Normalize tag prefixes: some servers emit <d:...>, others <D:...>, and
    // the worker itself emits <d:...> inside a <D:multistatus>. Unify to <D:>.
    const unify = (s: string) => s
      .replace(/<(?:D:|d:)([a-z]+)([\s>])/g, '<D:$1$2')
      .replace(/<\/(?:D:|d:)([a-z]+)>/g, '</D:$1>')
      .replace(/<(?:D:|d:)([a-z]+)\/>/g, '<D:$1/>');

    const responseRe = /<D:response>[\s\S]*?<\/D:response>/g;
    const hrefRe = /<D:href>([\s\S]*?)<\/D:href>/;
    const isCollectionRe = /<D:resourcetype>[\s\S]*?<D:collection\/>/;
    const sizeRe = /<D:getcontentlength>(\d+)<\/D:getcontentlength>/;
    const modRe = /<D:getlastmodified>([\s\S]*?)<\/D:getlastmodified>/;

    const normalized = unify(xml);

    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = responseRe.exec(normalized)) !== null && count < 10000) {
      count++;
      const block = match[0];
      const hrefMatch = block.match(hrefRe);
      if (!hrefMatch) continue;
      let href = hrefMatch[1].trim();
      href = href.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      try {
        href = decodeURIComponent(href);
      } catch {
        // keep as-is
      }
      const isDir = isCollectionRe.test(block);
      const sizeMatch = block.match(sizeRe);
      const modMatch = block.match(modRe);
      // The requested path itself appears first; skip it.
      const hrefPath = this.normalizeHref(href);
      if (hrefPath === this.normalizeHref(requestedPath) || hrefPath === this.normalizeHref(requestedPath) + '/') continue;
      const name = hrefPath.split('/').filter(Boolean).pop() || '';
      if (!name) continue;
      entries.push({
        name,
        href: hrefPath,
        is_dir: isDir,
        size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
        modified: modMatch ? this.parseHttpDate(modMatch[1].trim()) : new Date().toISOString(),
      });
    }
    return entries;
  }

  private normalizeHref(href: string): string {
    // Strip scheme+host if the server returned an absolute URL.
    try {
      const u = new URL(href);
      return decodeURIComponent(u.pathname) || '/';
    } catch {
      return href.startsWith('/') ? href : '/' + href;
    }
  }

  private parseHttpDate(s: string): string {
    // WebDAV getlastmodified is usually an RFC1123 date.
    const t = Date.parse(s);
    if (!isNaN(t)) return new Date(t).toISOString();
    return new Date().toISOString();
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const davPath = this.getPath(path);
    const url = this.getUrl(davPath.endsWith('/') ? davPath : davPath + '/');
    const resp = await this.davFetch(url, {
      method: 'PROPFIND',
      headers: { 'Depth': '1', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
    });
    if (!resp.ok) {
      throw new Error(`WebDAV list failed: ${resp.status} ${resp.statusText}`);
    }
    const xml = await resp.text();
    const entries = this.parseMultiStatus(xml, davPath);

    const content: Obj[] = entries.map(e => {
      if (e.is_dir) {
        return createDirObj({ name: e.name, modified: e.modified });
      }
      return createFileObj({ name: e.name, size: e.size, modified: e.modified });
    });
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const davPath = this.getPath(path);
    // Root is always a directory.
    if (davPath === '/' || davPath === '') {
      return createDirObj({ name: path === '/' ? '/' : path, modified: new Date().toISOString() });
    }
    const url = this.getUrl(davPath);
    const resp = await this.davFetch(url, {
      method: 'PROPFIND',
      headers: { 'Depth': '0', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
    });
    if (!resp.ok) {
      if (resp.status === 404) throw new Error('Not found');
      throw new Error(`WebDAV get failed: ${resp.status} ${resp.statusText}`);
    }
    const xml = await resp.text();
    const entries = this.parseMultiStatus(xml, davPath);
    const name = davPath.split('/').filter(Boolean).pop() || path.split('/').filter(Boolean).pop() || path;
    if (entries.length === 0) {
      // Fallback: a HEAD request can tell us if it exists; treat as a file.
      return createFileObj({ name, size: 0, modified: new Date().toISOString() });
    }
    const e = entries[0];
    if (e.is_dir) {
      return createDirObj({ name, modified: e.modified });
    }
    return createFileObj({ name, size: e.size, modified: e.modified });
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const davPath = this.getPath(path);
    const url = this.getUrl(davPath);
    // Basic auth cannot be embedded in a browser URL, so return it as a header
    // and let the worker proxy the file.
    return { url, header: { Authorization: this.authHeader() } };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const davPath = this.getPath(path);
    const url = this.getUrl(davPath);
    const resp = await this.davFetch(url, { method: 'MKCOL' });
    if (!resp.ok && resp.status !== 405) {
      throw new Error(`WebDAV mkdir failed: ${resp.status} ${resp.statusText}`);
    }
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const src = this.getPath(path);
    const parent = src.substring(0, src.lastIndexOf('/')) || '/';
    const dst = (parent === '/' ? '/' : parent) + '/' + newName;
    const resp = await this.davFetch(this.getUrl(src), {
      method: 'MOVE',
      headers: { 'Destination': this.getUrl(dst) },
    });
    if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
      throw new Error(`WebDAV rename failed: ${resp.status} ${resp.statusText}`);
    }
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const resp = await this.davFetch(this.getUrl(this.getPath(src)), {
      method: 'COPY',
      headers: { 'Destination': this.getUrl(this.getPath(dst)) },
    });
    if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
      throw new Error(`WebDAV copy failed: ${resp.status} ${resp.statusText}`);
    }
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const resp = await this.davFetch(this.getUrl(this.getPath(src)), {
      method: 'MOVE',
      headers: { 'Destination': this.getUrl(this.getPath(dst)) },
    });
    if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
      throw new Error(`WebDAV move failed: ${resp.status} ${resp.statusText}`);
    }
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const resp = await this.davFetch(this.getUrl(this.getPath(path)), { method: 'DELETE' });
    if (!resp.ok && resp.status !== 404 && resp.status !== 204) {
      throw new Error(`WebDAV delete failed: ${resp.status} ${resp.statusText}`);
    }
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const resp = await this.davFetch(this.getUrl(this.getPath(path)), {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(file),
    });
    if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
      throw new Error(`WebDAV put failed: ${resp.status} ${resp.statusText}`);
    }
  }
}

registerDriver(WebDavDriver, webdavConfig, webdavAdditional);
