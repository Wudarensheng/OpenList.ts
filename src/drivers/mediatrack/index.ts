/**
 * MediaTrack (mediatrack.cn) Driver — writable
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/mediatrack (driver.ts + util.ts + types.ts).
 *
 * Token + project_id authenticated asset API. List/download resolve assets by
 * walking titles from the configured root folder id; move/copy/delete operate
 * on asset ids through the batch endpoints. Download URLs are obtained by
 * exchanging an asset id for a short-lived download token, then following the
 * redirect. Upload asks the storage service for a COS signed URL and PUTs the
 * file bytes to it, then registers the asset under the parent folder.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const mediatrackConfig: DriverConfig = {
  name: 'MediaTrack',
  label: 'MediaTrack',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '',
};

export const mediatrackAdditional: DriverItem[] = [
  { name: 'access_token', type: 'text', default: '', options: '', required: true, help: 'Access token' },
  { name: 'project_id', type: 'string', default: '', options: '', required: false, help: 'Project id' },
  { name: 'root_folder_id', type: 'string', default: '', options: '', required: false, help: 'Root folder id' },
  { name: 'order_by', type: 'select', default: 'title', options: 'updated_at,title,size', required: false, help: 'Sort field' },
  { name: 'order_desc', type: 'bool', default: 'false', options: '', required: false, help: 'Sort descending' },
];

// ---------------------------------------------------------------- types

interface MediatrackBaseResp {
  status: string;
  message?: string;
}

interface MediatrackFile {
  id: string;
  category?: number;
  created_at?: string;
  deleted_at?: string;
  description?: string;
  file?: {
    cover?: string;
    src?: string;
  };
  size?: string;
  title: string;
  updated_at?: string;
}

interface MediatrackChildrenResp {
  status: string;
  data?: {
    total: number;
    assets: MediatrackFile[];
  };
  message?: string;
}

interface MediatrackUploadResp {
  status: string;
  data?: {
    credentials: {
      TmpSecretId: string;
      TmpSecretKey: string;
      Token: string;
      ExpiredTime: number;
      Expiration: string;
      StartTime: number;
    };
    object: string;
    bucket: string;
    region: string;
    url: string;
    size: string;
  };
  message?: string;
}

// ---------------------------------------------------------------- helpers

class MediatrackApiClient {
  private cfg: Record<string, any>;

  constructor(cfg: Record<string, any>) {
    this.cfg = cfg;
  }

  async request<T = any>(
    url: string,
    options: { method?: string; params?: Record<string, string>; body?: any } = {},
  ): Promise<T> {
    const { method = 'GET', params, body } = options;

    let fullUrl = url;
    if (params && Object.keys(params).length > 0) {
      const q = new URLSearchParams(params).toString();
      fullUrl += (fullUrl.includes('?') ? '&' : '?') + q;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${String(this.cfg.access_token || '')}`,
      Accept: 'application/json',
    };
    if (body && typeof body === 'object' && !(body instanceof Uint8Array)) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(fullUrl, {
      method,
      headers,
      body:
        body && typeof body === 'object' && !(body instanceof Uint8Array)
          ? JSON.stringify(body)
          : body,
    });

    const text = await res.text();
    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (data && typeof data === 'object' && data.status && data.status !== 'SUCCESS') {
      throw new Error(`MediaTrack API Error: ${data.message || JSON.stringify(data)}`);
    }

    if (!res.ok) {
      throw new Error(`MediaTrack request failed (${res.status}): ${text}`);
    }

    return data as T;
  }

  async init(): Promise<void> {
    await this.request('https://kayle.api.mediatrack.cn/users', { method: 'GET' });
  }

  async getFiles(parentId: string): Promise<MediatrackFile[]> {
    const allFiles: MediatrackFile[] = [];
    let page = 1;

    let sort = '';
    const orderDesc = String(this.cfg.order_desc || '') === 'true';
    if (this.cfg.order_by) {
      sort = (orderDesc ? '-' : '') + this.cfg.order_by;
    }

    while (true) {
      const params: Record<string, string> = {
        page: String(page),
        size: '50',
      };
      if (sort) params.sort = sort;

      const resp: MediatrackChildrenResp = await this.request(
        `https://jayce.api.mediatrack.cn/v4/assets/${encodeURIComponent(parentId)}/children`,
        {
          method: 'GET',
          params,
        },
      );

      const assets = resp.data?.assets || [];
      if (assets.length === 0) break;

      allFiles.push(...assets);
      page++;
    }

    return allFiles;
  }

  async getDownloadUrl(assetId: string): Promise<string> {
    const projectId = String(this.cfg.project_id || '');
    const tokenUrl = `https://kayn.api.mediatrack.cn/v1/download_token/asset?asset_id=${encodeURIComponent(assetId)}&source_type=project&password=&source_id=${encodeURIComponent(projectId)}`;

    const tokenResp = await this.request<{ data: { token: string } }>(tokenUrl, {
      method: 'GET',
    });

    const token = tokenResp?.data?.token;
    if (!token) {
      throw new Error(`Failed to get download token for asset ${assetId}`);
    }

    const redirectUrl = `https://kayn.api.mediatrack.cn/v1/download/redirect?token=${encodeURIComponent(token)}`;
    const headRes = await fetch(redirectUrl, {
      method: 'GET',
      redirect: 'manual',
    });

    const location = headRes.headers.get('location');
    return location || redirectUrl;
  }
}

function sortItems(items: Obj[], orderBy?: string, orderDesc?: boolean): Obj[] {
  const asc = !orderDesc;
  const key = String(orderBy || 'name').toLowerCase();
  return [...items].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let cmp: number;
    if (key.includes('size')) {
      cmp = (a.size || 0) - (b.size || 0);
    } else if (key.includes('time') || key.includes('modified') || key.includes('created')) {
      cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
    } else {
      cmp = String(a.name).localeCompare(String(b.name));
    }
    return asc ? cmp : -cmp;
  });
}

// ---------------------------------------------------------------- driver

export class MediatrackDriver implements Driver {
  private cfg: Record<string, any> = {};
  private client: MediatrackApiClient = new MediatrackApiClient({});
  private rootId = '';
  private idCache: Map<string, string> = new Map();

  config(): DriverConfig {
    return mediatrackConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    if (!this.cfg.access_token) {
      throw new Error('MediaTrack access_token is required');
    }
    this.rootId = String(cfg.root_folder_id || '');
    this.idCache.clear();
    this.client = new MediatrackApiClient(cfg);
    await this.client.init();
  }

  private cleanPath(p: string): string {
    const s = '/' + (p || '').split('/').filter(Boolean).join('/');
    return s === '/' ? '' : s;
  }

  private async resolveParentId(physicalPath: string): Promise<string> {
    const clean = this.cleanPath(physicalPath);
    if (!clean) return this.rootId;

    if (this.idCache.has(clean)) {
      return this.idCache.get(clean)!;
    }

    const parts = clean.split('/').filter(Boolean);
    let currentId = this.rootId;
    let currentPath = '';

    for (const part of parts) {
      currentPath += '/' + part;
      if (this.idCache.has(currentPath)) {
        currentId = this.idCache.get(currentPath)!;
        continue;
      }

      const files = await this.client.getFiles(currentId);
      const found = files.find((f) => f.title === part);
      if (!found) {
        throw new Error(`Path not found: ${currentPath}`);
      }
      currentId = found.id;
      this.idCache.set(currentPath, currentId);
    }

    return currentId;
  }

  private fileToObj(f: MediatrackFile, fullPath: string): Obj {
    const isDir = !f.file;
    this.idCache.set(fullPath, f.id);

    let thumb: string | undefined;
    if (f.file && f.file.cover) {
      thumb = 'https://nano.mtres.cn/' + f.file.cover;
    }

    const common = {
      name: f.title,
      size: parseInt(f.size || '0', 10) || 0,
      created: f.created_at || undefined,
      modified: f.updated_at || new Date().toISOString(),
      thumb,
      id: f.id,
    };
    return isDir ? createDirObj(common) : createFileObj(common);
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const parentId = await this.resolveParentId(path);
    const files = await this.client.getFiles(parentId);
    const cleanParent = this.cleanPath(path);

    const items: Obj[] = files.map((f) => {
      const filePath = cleanParent ? `${cleanParent}/${f.title}` : `/${f.title}`;
      return this.fileToObj(f, filePath);
    });

    const orderDesc = String(this.cfg.order_desc || '') === 'true';
    const sorted = sortItems(items, this.cfg.order_by, orderDesc);
    return { content: sorted, total: sorted.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const clean = this.cleanPath(path);
    const name = clean.split('/').pop() || 'root';

    if (!clean) {
      return createDirObj({ name: 'root', modified: new Date().toISOString(), id: this.rootId });
    }

    const parentPath = clean.split('/').slice(0, -1).join('/');
    const parentId = await this.resolveParentId(parentPath);
    const files = await this.client.getFiles(parentId);
    const found = files.find((f) => f.title === name);

    if (!found) {
      return createFileObj({ name, size: 0, modified: new Date().toISOString() });
    }

    const fullPath = clean;
    return this.fileToObj(found, fullPath);
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const clean = this.cleanPath(path);
    const name = clean.split('/').filter(Boolean).pop() || '';
    const parentPath = clean.split('/').slice(0, -1).join('/');

    const parentId = await this.resolveParentId(parentPath);
    const files = await this.client.getFiles(parentId);
    const found = files.find((f) => f.title === name);

    if (!found || (found.file ? false : true)) {
      throw new Error(`Cannot get link for: ${path}`);
    }

    const url = await this.client.getDownloadUrl(found.id);
    return { url };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const clean = this.cleanPath(path);
    const parentPath = clean.split('/').slice(0, -1).join('/');
    const dirName = clean.split('/').pop() || '';
    const parentId = await this.resolveParentId(parentPath);

    await this.client.request(
      `https://jayce.api.mediatrack.cn/v3/assets/${encodeURIComponent(parentId)}/children`,
      {
        method: 'POST',
        body: {
          type: 1,
          title: dirName,
        },
      },
    );
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const clean = this.cleanPath(path);
    const assetId = await this.resolveParentId(clean);
    await this.client.request(
      `https://jayce.api.mediatrack.cn/v3/assets/${encodeURIComponent(assetId)}`,
      {
        method: 'PUT',
        body: {
          title: newName,
        },
      },
    );

    this.idCache.delete(clean);
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const clean = this.cleanPath(path);
    if (!clean) {
      throw new Error('cannot remove the root folder');
    }
    const parentPath = clean.split('/').slice(0, -1).join('/');
    const fileName = clean.split('/').pop() || '';

    const parentId = await this.resolveParentId(parentPath);
    const files = await this.client.getFiles(parentId);
    const match = files.find((f) => f.title === fileName);
    if (!match) return;

    await this.client.request('https://jayce.api.mediatrack.cn/v4/assets/batch/delete', {
      method: 'DELETE',
      body: {
        origin_id: parentId,
        ids: [match.id],
      },
    });

    this.idCache.delete(clean);
  }

  // move(src, dst): per-item move into the destination directory
  // (dirname(dst)), keeping the item name.
  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcClean = this.cleanPath(src);
    const srcParentPath = srcClean.split('/').slice(0, -1).join('/');
    const srcName = srcClean.split('/').pop() || '';
    const dstDir = this.cleanPath(dst.substring(0, dst.lastIndexOf('/')));

    const srcParentId = await this.resolveParentId(srcParentPath);
    const dstParentId = await this.resolveParentId(dstDir);
    const srcFiles = await this.client.getFiles(srcParentId);
    const match = srcFiles.find((f) => f.title === srcName);
    if (!match) return;

    await this.client.request('https://jayce.api.mediatrack.cn/v4/assets/batch/move', {
      method: 'POST',
      body: {
        parent_id: dstParentId,
        ids: [match.id],
      },
    });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcClean = this.cleanPath(src);
    const srcParentPath = srcClean.split('/').slice(0, -1).join('/');
    const srcName = srcClean.split('/').pop() || '';
    const dstDir = this.cleanPath(dst.substring(0, dst.lastIndexOf('/')));

    const srcParentId = await this.resolveParentId(srcParentPath);
    const dstParentId = await this.resolveParentId(dstDir);
    const srcFiles = await this.client.getFiles(srcParentId);
    const match = srcFiles.find((f) => f.title === srcName);
    if (!match) return;

    await this.client.request('https://jayce.api.mediatrack.cn/v4/assets/batch/clone', {
      method: 'POST',
      body: {
        parent_id: dstParentId,
        ids: [match.id],
      },
    });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const clean = this.cleanPath(path);
    const parentPath = clean.split('/').slice(0, -1).join('/');
    const fileName = clean.split('/').pop() || 'upload';
    const parentId = await this.resolveParentId(parentPath);

    const randomId = Math.random().toString(36).slice(2);
    const srcKey = `assets/${randomId}`;

    const tokenResp: MediatrackUploadResp = await this.client.request(
      'https://jayce.api.mediatrack.cn/v3/storage/tokens/asset',
      {
        method: 'GET',
        params: { src: srcKey },
      },
    );

    const cosUrl = tokenResp.data?.url;
    if (cosUrl) {
      await fetch(cosUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(file.byteLength),
        },
        body: new Uint8Array(file),
      });
    }

    await this.client.request(
      `https://jayce.api.mediatrack.cn/v3/assets/${encodeURIComponent(parentId)}/children`,
      {
        method: 'POST',
        body: {
          category: 0,
          description: fileName,
          mime: 'application/octet-stream',
          size: String(file.byteLength),
          src: srcKey,
          title: fileName,
          type: 0,
        },
      },
    );
  }
}

registerDriver(MediatrackDriver, mediatrackConfig, mediatrackAdditional);
