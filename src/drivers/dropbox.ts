import { Driver, DriverConfig, DriverInfo, FileObject, ListResult, LinkResult } from './types';

const API_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_API = 'https://content.dropboxapi.com/2';

export const dropboxConfig: DriverInfo = {
  config: {
    name: 'Dropbox',
    label: 'Dropbox',
    local_sort: false,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false,
    need_ms: false,
    default_root: '/',
  },
  additional: [
    { name: 'refresh_token', type: 'string', default: '', options: '', required: true, help: 'Refresh token (from Dropbox OAuth)' },
    { name: 'app_key', type: 'string', default: '', options: '', required: true, help: 'App key' },
    { name: 'app_secret', type: 'string', default: '', options: '', required: true, help: 'App secret' },
    { name: 'root_folder', type: 'string', default: '', options: '', required: false, help: 'Root folder path' },
    { name: 'custom_host', type: 'string', default: '', options: '', required: false, help: 'Custom download host' },
  ],
};

export class DropboxDriver implements Driver {
  private accessToken: string = '';
  private refreshToken: string = '';
  private appKey: string = '';
  private appSecret: string = '';

  async init(config: Record<string, any>): Promise<void> {
    this.refreshToken = config.refresh_token;
    this.appKey = config.app_key;
    this.appSecret = config.app_secret;
    await this.refreshAccessToken(config);
  }

  private async refreshAccessToken(config: Record<string, any>): Promise<void> {
    const resp = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(`${this.appKey}:${this.appSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      }).toString(),
    });

    if (!resp.ok) {
      throw new Error(`Failed to refresh token: ${resp.statusText}`);
    }

    const data = await resp.json();
    this.accessToken = data.access_token;
  }

  private async request(path: string, config: Record<string, any>, options: RequestInit = {}): Promise<any> {
    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    let resp = await fetch(`${API_BASE}${path}`, { ...options, headers });

    if (resp.status === 401) {
      await this.refreshAccessToken(config);
      headers['Authorization'] = `Bearer ${this.accessToken}`;
      resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
    }

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Dropbox API error: ${resp.status} ${err}`);
    }

    return resp.json();
  }

  private getRootPath(config: Record<string, any>): string {
    const root = config.root_folder || '';
    return root ? `/${root.replace(/^\//, '').replace(/\/$/, '')}` : '';
  }

  async list(path: string, config: Record<string, any>): Promise<ListResult> {
    const fullPath = this.getRootPath(config) + (path === '/' ? '' : path);
    
    const data = await this.request('/files/list_folder', config, {
      method: 'POST',
      body: JSON.stringify({
        path: fullPath || '',
        include_deleted: false,
      }),
    });

    const content: FileObject[] = (data.entries || []).map((item: any) => ({
      name: item.name,
      size: item.size || 0,
      is_dir: item['.tag'] === 'folder',
      modified: item.server_modified || new Date().toISOString(),
      created: item.client_modified,
    }));

    return { content, total: content.length };
  }

  async get(path: string, config: Record<string, any>): Promise<FileObject> {
    const fullPath = this.getRootPath(config) + path;
    
    const data = await this.request('/files/get_metadata', config, {
      method: 'POST',
      body: JSON.stringify({ path: fullPath }),
    });

    return {
      name: data.name,
      size: data.size || 0,
      is_dir: data['.tag'] === 'folder',
      modified: data.server_modified || new Date().toISOString(),
      created: data.client_modified,
    };
  }

  async link(path: string, config: Record<string, any>): Promise<LinkResult> {
    const fullPath = this.getRootPath(config) + path;
    const customHost = config.custom_host;
    
    if (customHost) {
      return { url: `${customHost}${path}` };
    }

    const data = await this.request('/files/get_temporary_link', config, {
      method: 'POST',
      body: JSON.stringify({ path: fullPath }),
    });

    return { url: data.link };
  }

  async mkdir(path: string, config: Record<string, any>): Promise<void> {
    const fullPath = this.getRootPath(config) + path;
    
    await this.request('/files/create_folder_v2', config, {
      method: 'POST',
      body: JSON.stringify({ path: fullPath }),
    });
  }

  async rename(path: string, newName: string, config: Record<string, any>): Promise<void> {
    const fullPath = this.getRootPath(config) + path;
    const parentPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
    const newPath = `${parentPath}/${newName}`;
    
    await this.request('/files/move_v2', config, {
      method: 'POST',
      body: JSON.stringify({
        from_path: fullPath,
        to_path: newPath,
      }),
    });
  }

  async copy(src: string, dst: string, config: Record<string, any>): Promise<void> {
    const fullSrc = this.getRootPath(config) + src;
    const fullDst = this.getRootPath(config) + dst;
    
    await this.request('/files/copy_v2', config, {
      method: 'POST',
      body: JSON.stringify({
        from_path: fullSrc,
        to_path: fullDst,
      }),
    });
  }

  async move(src: string, dst: string, config: Record<string, any>): Promise<void> {
    const fullSrc = this.getRootPath(config) + src;
    const fullDst = this.getRootPath(config) + dst;
    
    await this.request('/files/move_v2', config, {
      method: 'POST',
      body: JSON.stringify({
        from_path: fullSrc,
        to_path: fullDst,
      }),
    });
  }

  async remove(path: string, config: Record<string, any>): Promise<void> {
    const fullPath = this.getRootPath(config) + path;
    
    await this.request('/files/delete_v2', config, {
      method: 'POST',
      body: JSON.stringify({ path: fullPath }),
    });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, config: Record<string, any>): Promise<void> {
    const fullPath = this.getRootPath(config) + path;
    
    await fetch(`${CONTENT_API}/files/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: fullPath,
          mode: 'overwrite',
          autorename: false,
        }),
      },
      body: file,
    });
  }
}
