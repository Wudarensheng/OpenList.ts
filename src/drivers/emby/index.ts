/**
 * Emby / Jellyfin Driver (read-only)
 * Referenced from OpenList's official drivers/emby:
 * - Media server REST API, auth via api_key+user_id or username/password
 * - List items by parent id, link produces a stream / download URL
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const embyConfig: DriverConfig = {
  name: 'Emby',
  label: 'Emby / Jellyfin',
  local_sort: true,
  only_proxy: true,
  no_cache: false,
  no_upload: true,
  default_root: '1',
};

export const embyAdditional: DriverItem[] = [
  { name: 'url', type: 'string', default: '', options: '', required: true, help: 'Emby/Jellyfin server URL' },
  { name: 'api_key', type: 'string', default: '', options: '', required: false, help: 'API key (with user_id, preferred)' },
  { name: 'user_id', type: 'string', default: '', options: '', required: false, help: 'User id (required when api_key is set)' },
  { name: 'username', type: 'string', default: '', options: '', required: false, help: 'Username (for password login)' },
  { name: 'password', type: 'string', default: '', options: '', required: false, help: 'Password' },
  { name: 'link_method', type: 'select', default: 'stream', options: 'stream,download', required: false, help: 'Link method' },
  { name: 'root_folder_id', type: 'string', default: '1', options: '', required: false, help: 'Root folder id' },
];

interface EmbyItem {
  Name: string;
  Id: string;
  Type?: string;
  IsFolder?: boolean;
  Path?: string;
  Size?: number;
  DateCreated?: string;
  SeriesName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
}

interface ListResp {
  Items: EmbyItem[];
  TotalRecordCount: number;
}

interface MediaSource {
  Id: string;
  Container: string;
  SupportsDirectStream?: boolean;
}

interface ItemDetailResp {
  MediaSources: MediaSource[];
}

interface AuthResp {
  AccessToken: string;
  User: { Id: string };
}

const AUTH_HEADER = 'MediaBrowser Client="OpenList", Device="OpenList", DeviceId="openlist-emby", Version="1.0.0"';

/**
 * Emby / Jellyfin Driver Implementation
 */
export class EmbyDriver implements Driver {
  private token = '';
  private userId = '';
  private cfg: Record<string, any> = {};

  config(): DriverConfig {
    return embyConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.token = (cfg.api_key || '').trim();
    this.userId = (cfg.user_id || '').trim();
    if (this.token) {
      if (!this.userId) throw new Error('emby: user_id is required when api_key is set');
      return;
    }
    if (!cfg.username) {
      throw new Error('emby: please provide api_key+user_id or username(+password)');
    }
    await this.login();
  }

  private base(): string {
    return (this.cfg.url || '').replace(/\/+$/, '');
  }

  private async login(): Promise<void> {
    const resp = await fetch(`${this.base()}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': AUTH_HEADER },
      body: JSON.stringify({ Username: this.cfg.username, Pw: this.cfg.password || '' }),
    });
    if (!resp.ok) {
      throw new Error(`emby auth failed: status=${resp.status}`);
    }
    const data = await resp.json().catch(() => ({})) as AuthResp;
    if (!data.AccessToken || !data.User?.Id) {
      throw new Error('emby auth response missing access token or user id');
    }
    this.token = data.AccessToken;
    this.userId = data.User.Id;
  }

  private async getItems(parentId: string): Promise<EmbyItem[]> {
    const q = new URLSearchParams({
      ParentId: parentId,
      Recursive: 'false',
      Fields: 'Path,Size,DateCreated,SeriesName,IndexNumber,ParentIndexNumber',
      api_key: this.token,
    });
    const resp = await fetch(`${this.base()}/Users/${this.userId}/Items?${q.toString()}`);
    if (!resp.ok) {
      throw new Error(`emby list failed: status=${resp.status}`);
    }
    const data = await resp.json().catch(() => ({})) as ListResp;
    return data.Items || [];
  }

  // Resolve a path to an item id by walking each segment.
  private async resolvePathToId(path: string): Promise<string> {
    const root = this.cfg.root_folder_id || '1';
    const parts = path.split('/').filter(p => p);
    let currentId = root;
    for (const part of parts) {
      const items = await this.getItems(currentId);
      const found = items.find(it => it.Name === part);
      if (!found) {
        throw new Error(`emby: path not found: ${path}`);
      }
      currentId = found.Id;
    }
    return currentId;
  }

  private itemToObj(it: EmbyItem): Obj {
    const common = {
      name: it.Name || 'Untitled',
      modified: it.DateCreated ? new Date(it.DateCreated).toISOString() : new Date().toISOString(),
      id: it.Id,
      path: it.Path,
    };
    return it.IsFolder
      ? createDirObj(common)
      : createFileObj({ ...common, size: it.Size || 0 });
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const parentId = await this.resolvePathToId(path);
    const items = await this.getItems(parentId);
    const content = items.map(it => this.itemToObj(it));
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const id = await this.resolvePathToId(path);
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const name = path.split('/').pop() || path;
    const parentItems = await this.getItems(await this.resolvePathToId(parent));
    const found = parentItems.find(it => it.Id === id);
    if (found) return this.itemToObj(found);
    return createFileObj({ name, modified: new Date().toISOString(), id });
  }

  // Produce a stream or download URL. Mirrors Link() in the Go driver.
  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const fileId = await this.resolvePathToId(path);
    const base = this.base();
    const useDownload = (this.cfg.link_method || 'stream') === 'download';

    let url: string;
    if (useDownload) {
      url = `${base}/Items/${fileId}/Download?api_key=${this.token}`;
    } else {
      // Prefer the direct-stream media source (same as OpenList).
      let mediaSourceId = '';
      let container = '';
      try {
        const resp = await fetch(`${base}/Users/${this.userId}/Items/${fileId}?Fields=MediaSources&api_key=${this.token}`);
        if (resp.ok) {
          const detail = await resp.json().catch(() => null) as ItemDetailResp | null;
          const sources = detail?.MediaSources || [];
          const direct = sources.find(s => s.Id && s.SupportsDirectStream) || sources.find(s => s.Id);
          if (direct) {
            mediaSourceId = direct.Id;
            container = direct.Container;
          }
        }
      } catch {
        // ignore; fall back to the generic stream URL
      }
      const q = new URLSearchParams({ api_key: this.token, Static: 'true' });
      if (mediaSourceId) q.set('MediaSourceId', mediaSourceId);
      const suffix = container ? `stream.${container}` : 'stream';
      url = `${base}/Videos/${fileId}/${suffix}?${q.toString()}`;
    }
    return { url };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('emby: read-only driver');
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('emby: read-only driver');
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('emby: read-only driver');
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('emby: read-only driver');
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('emby: read-only driver');
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('emby: read-only driver');
  }
}

registerDriver(EmbyDriver, embyConfig, embyAdditional);
