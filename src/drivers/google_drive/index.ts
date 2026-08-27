/**
 * Google Drive Driver (port of OpenList's drivers/google_drive).
 * Uses the Google Drive API v3 with a refresh token (OAuth2).
 *
 * Because the Worker is stateless, paths are resolved to file IDs by walking
 * the tree segment-by-segment on demand.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

const API_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const LIST_FIELDS = 'files(id,name,mimeType,size,modifiedTime,thumbnailLink),nextPageToken';

export const googleDriveConfig: DriverConfig = {
  name: 'GoogleDrive',
  label: 'Google Drive',
  local_sort: true,
  only_proxy: true,
  no_cache: false,
  no_upload: false,
  default_root: 'root',
};

export const googleDriveAdditional: DriverItem[] = [
  { name: 'refresh_token', type: 'string', default: '', options: '', required: true, help: 'Refresh token' },
  { name: 'client_id', type: 'string', default: '', options: '', required: false, help: 'OAuth client ID' },
  { name: 'client_secret', type: 'string', default: '', options: '', required: false, help: 'OAuth client secret' },
  { name: 'root_folder_id', type: 'string', default: 'root', options: '', required: false, help: 'Root folder ID (default: root)' },
  { name: 'order_by', type: 'string', default: 'folder,name,modifiedTime', options: '', required: false, help: 'Order by (folder,name,modifiedTime,createdTime,size)' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: 'Order direction' },
];

interface GDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  thumbnailLink?: string;
}

export class GoogleDriveDriver implements Driver {
  private refreshToken = '';
  private clientId = '';
  private clientSecret = '';
  private rootId = 'root';
  private orderBy = 'folder,name,modifiedTime';
  private orderDirection = 'asc';
  private accessToken = '';

  config(): DriverConfig {
    return googleDriveConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.refreshToken = (cfg.refresh_token || '').toString();
    this.clientId = (cfg.client_id || '').toString();
    this.clientSecret = (cfg.client_secret || '').toString();
    this.rootId = (cfg.root_folder_id || cfg.root_id || 'root').toString();
    this.orderBy = (cfg.order_by || 'folder,name,modifiedTime').toString();
    this.orderDirection = (cfg.order_direction || 'asc').toString();
  }

  private async refreshAccessToken(): Promise<string> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('GoogleDrive requires client_id and client_secret to refresh the token');
    }
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }).toString(),
    });
    if (!resp.ok) {
      throw new Error(`Google Drive token refresh failed: ${resp.status} ${await resp.text()}`);
    }
    const data: any = await resp.json();
    if (!data.access_token) {
      throw new Error('Google Drive token refresh returned no access_token');
    }
    this.accessToken = data.access_token;
    return this.accessToken;
  }

  private async apiRequest(method: string, url: string, body?: any): Promise<any> {
    const token = this.accessToken || await this.refreshAccessToken();
    const resp = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 401) {
      // Token expired: refresh once and retry.
      await this.refreshAccessToken();
      const retry = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return this.parseApiResponse(retry);
    }
    return this.parseApiResponse(resp);
  }

  private async parseApiResponse(resp: Response): Promise<any> {
    const text = await resp.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // ignore
    }
    if (!resp.ok) {
      const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
      throw new Error(`Google Drive API error: ${msg}`);
    }
    return data;
  }

  // Resolve a path (relative to root) to a file id by walking the tree.
  private async resolveId(path: string): Promise<string> {
    const segments = (path || '/').split('/').filter(Boolean);
    let parentId = this.rootId;
    for (const seg of segments) {
      const files = await this.listChildren(parentId);
      const match = files.find(f => f.name === seg);
      if (!match) {
        throw new Error('Not found');
      }
      parentId = match.id;
    }
    return parentId;
  }

  private async listChildren(parentId: string): Promise<GDriveFile[]> {
    const q = `'${parentId}' in parents and trashed=false`;
    const dir = this.orderDirection === 'desc' ? 'desc' : 'asc';
    // orderBy expects a single field; use folder,name for stable dir-first order.
    let orderBy = 'folder,name';
    if (this.orderBy && this.orderBy !== 'folder,name,modifiedTime') {
      orderBy = this.orderBy;
    }
    const url = `${API_BASE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(LIST_FIELDS)}&orderBy=${encodeURIComponent(`${orderBy} ${dir}`)}&pageSize=1000`;
    const data = await this.apiRequest('GET', url);
    return (data.files || []) as GDriveFile[];
  }

  private fileToObj(f: GDriveFile, nameFallback: string): Obj {
    const isDir = f.mimeType === FOLDER_MIME;
    if (isDir) {
      return createDirObj({ name: f.name || nameFallback, id: f.id, modified: f.modifiedTime || new Date().toISOString() });
    }
    return createFileObj({
      name: f.name || nameFallback,
      size: parseInt(f.size || '0', 10),
      modified: f.modifiedTime || new Date().toISOString(),
      thumb: f.thumbnailLink || undefined,
      id: f.id,
    });
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const id = path === '/' || !path ? this.rootId : await this.resolveId(path);
    const files = await this.listChildren(id);
    const content = files.map(f => this.fileToObj(f, ''));
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    if (path === '/' || !path) {
      return createDirObj({ name: '/', modified: new Date().toISOString(), id: this.rootId });
    }
    const id = await this.resolveId(path);
    const data = await this.apiRequest('GET', `${API_BASE}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent('id,name,mimeType,size,modifiedTime,thumbnailLink')}`);
    const name = path.split('/').filter(Boolean).pop() || path;
    return this.fileToObj({ id: data.id, name: data.name, mimeType: data.mimeType, size: data.size, modifiedTime: data.modifiedTime, thumbnailLink: data.thumbnailLink }, name);
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const id = await this.resolveId(path);
    const token = this.accessToken || await this.refreshAccessToken();
    // Direct media download requires the Bearer header, so the worker proxies.
    return {
      url: `${API_BASE}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      header: { Authorization: `Bearer ${token}` },
    };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').filter(Boolean).pop() || '';
    if (!name) return;
    const parentId = parent === '/' || !parent ? this.rootId : await this.resolveId(parent);
    const data = await this.apiRequest('POST', `${API_BASE}/files?fields=id`, {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    });
    void data;
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const id = await this.resolveId(path);
    await this.apiRequest('PATCH', `${API_BASE}/files/${encodeURIComponent(id)}?fields=id`, { name: newName });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcId = await this.resolveId(src);
    const dstParent = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstName = dst.split('/').filter(Boolean).pop() || '';
    const parentId = dstParent === '/' || !dstParent ? this.rootId : await this.resolveId(dstParent);
    await this.apiRequest('POST', `${API_BASE}/files/${encodeURIComponent(srcId)}/copy?fields=id`, {
      name: dstName,
      parents: [parentId],
    });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcId = await this.resolveId(src);
    const dstParent = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstName = dst.split('/').filter(Boolean).pop() || '';
    const parentId = dstParent === '/' || !dstParent ? this.rootId : await this.resolveId(dstParent);
    const file = await this.apiRequest('GET', `${API_BASE}/files/${encodeURIComponent(srcId)}?fields=parents`);
    const removeParents = (file.parents || []).join(',');
    await this.apiRequest('PATCH', `${API_BASE}/files/${encodeURIComponent(srcId)}?fields=id&addParents=${encodeURIComponent(parentId)}&removeParents=${encodeURIComponent(removeParents)}`, {
      name: dstName,
    });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const id = await this.resolveId(path);
    await this.apiRequest('DELETE', `${API_BASE}/files/${encodeURIComponent(id)}`);
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').filter(Boolean).pop() || '';
    if (!name) return;
    const parentId = parent === '/' || !parent ? this.rootId : await this.resolveId(parent);

    // Simple resumable upload (single request).
    const token = this.accessToken || await this.refreshAccessToken();
    const init = await fetch(`${UPLOAD_BASE}/files?uploadType=resumable&supportsAllDrives=true`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(file.byteLength),
      },
      body: JSON.stringify({ name, parents: [parentId] }),
    });
    if (!init.ok) {
      const text = await init.text();
      throw new Error(`Google Drive upload init failed: ${init.status} ${text}`);
    }
    const uploadUrl = init.headers.get('location');
    if (!uploadUrl) throw new Error('Google Drive upload: no upload URL returned');
    const up = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(file),
    });
    if (!up.ok) {
      const text = await up.text();
      throw new Error(`Google Drive upload failed: ${up.status} ${text}`);
    }
  }
}

registerDriver(GoogleDriveDriver, googleDriveConfig, googleDriveAdditional);
