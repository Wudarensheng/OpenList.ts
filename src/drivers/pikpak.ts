import { Driver, DriverConfig, DriverInfo, FileObject, ListResult, LinkResult } from './types';

const API_BASE = 'https://api-drive.mypikpak.com';

export const pikpakConfig: DriverInfo = {
  config: {
    name: 'PikPak',
    label: 'PikPak',
    local_sort: false,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false,
    need_ms: false,
    default_root: '/',
  },
  additional: [
    { name: 'username', type: 'string', default: '', options: '', required: true, help: 'Username or email' },
    { name: 'password', type: 'string', default: '', options: '', required: true, help: 'Password' },
    { name: 'captcha_token', type: 'string', default: '', options: '', required: false, help: 'Captcha token (if needed)' },
  ],
};

export class PikPakDriver implements Driver {
  private accessToken: string = '';
  private refreshToken: string = '';

  async init(config: Record<string, any>): Promise<void> {
    await this.login(config);
  }

  private async login(config: Record<string, any>): Promise<void> {
    const resp = await fetch(`${API_BASE}/v1/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'YNxT9w7GMdWvEOKa',
        client_secret: 'dbw2OtmVEeuUvIptb1Coygx',
        username: config.username,
        password: config.password,
        captcha_token: config.captcha_token || '',
      }),
    });

    if (!resp.ok) {
      throw new Error(`PikPak login failed: ${resp.statusText}`);
    }

    const data = await resp.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
  }

  private async refreshTokenIfNeeded(config: Record<string, any>): Promise<void> {
    const resp = await fetch(`${API_BASE}/v1/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'YNxT9w7GMdWvEOKa',
        client_secret: 'dbw2OtmVEeuUvIptb1Coygx',
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      }),
    });

    if (!resp.ok) {
      await this.login(config);
      return;
    }

    const data = await resp.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
  }

  private async request(path: string, config: Record<string, any>, options: RequestInit = {}): Promise<any> {
    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    let resp = await fetch(`${API_BASE}${path}`, { ...options, headers });

    if (resp.status === 401) {
      await this.refreshTokenIfNeeded(config);
      headers['Authorization'] = `Bearer ${this.accessToken}`;
      resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
    }

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`PikPak API error: ${resp.status} ${err}`);
    }

    return resp.json();
  }

  async list(path: string, config: Record<string, any>): Promise<ListResult> {
    const parentId = path === '/' ? '' : await this.getFileId(path, config);
    
    const data = await this.request(`/drive/v1/files?parent_id=${parentId}&thumbnail_size=SIZE_MEDIUM`, config);

    const content: FileObject[] = (data.files || []).map((item: any) => ({
      name: item.name,
      size: parseInt(item.size) || 0,
      is_dir: item.kind === 'drive#folder',
      modified: item.modified_time || new Date().toISOString(),
      created: item.created_time,
      thumb: item.thumbnail_link,
    }));

    return { content, total: content.length };
  }

  async get(path: string, config: Record<string, any>): Promise<FileObject> {
    const fileId = await this.getFileId(path, config);
    const data = await this.request(`/drive/v1/files/${fileId}`, config);

    return {
      name: data.name,
      size: parseInt(data.size) || 0,
      is_dir: data.kind === 'drive#folder',
      modified: data.modified_time || new Date().toISOString(),
      created: data.created_time,
      thumb: data.thumbnail_link,
    };
  }

  async link(path: string, config: Record<string, any>): Promise<LinkResult> {
    const fileId = await this.getFileId(path, config);
    
    const data = await this.request(`/drive/v1/files/${fileId}?action=SIGN_SPEED`, config, {
      method: 'POST',
    });

    return {
      url: data.web_content_link || data.medias?.[0]?.link?.url || '',
    };
  }

  async mkdir(path: string, config: Record<string, any>): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const dirName = path.substring(path.lastIndexOf('/') + 1);
    const parentId = parentPath === '/' ? '' : await this.getFileId(parentPath, config);

    await this.request('/drive/v1/files', config, {
      method: 'POST',
      body: JSON.stringify({
        parent_id: parentId,
        name: dirName,
        kind: 'drive#folder',
      }),
    });
  }

  async rename(path: string, newName: string, config: Record<string, any>): Promise<void> {
    const fileId = await this.getFileId(path, config);
    
    await this.request(`/drive/v1/files/${fileId}`, config, {
      method: 'PATCH',
      body: JSON.stringify({ name: newName }),
    });
  }

  async copy(src: string, dst: string, config: Record<string, any>): Promise<void> {
    const srcFileId = await this.getFileId(src, config);
    const dstParent = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstParentId = dstParent === '/' ? '' : await this.getFileId(dstParent, config);

    await this.request(`/drive/v1/files/${srcFileId}/copy`, config, {
      method: 'POST',
      body: JSON.stringify({ to: { parent_id: dstParentId } }),
    });
  }

  async move(src: string, dst: string, config: Record<string, any>): Promise<void> {
    const srcFileId = await this.getFileId(src, config);
    const dstParent = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstParentId = dstParent === '/' ? '' : await this.getFileId(dstParent, config);

    await this.request(`/drive/v1/files/${srcFileId}/move`, config, {
      method: 'POST',
      body: JSON.stringify({ to: { parent_id: dstParentId } }),
    });
  }

  async remove(path: string, config: Record<string, any>): Promise<void> {
    const fileId = await this.getFileId(path, config);
    
    await this.request(`/drive/v1/files/${fileId}/trash`, config, {
      method: 'POST',
    });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, config: Record<string, any>): Promise<void> {
    const fileName = path.substring(path.lastIndexOf('/') + 1);
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parentId = parentPath === '/' ? '' : await this.getFileId(parentPath, config);

    // Request upload
    const uploadData = await this.request('/drive/v1/files/upload', config, {
      method: 'POST',
      body: JSON.stringify({
        parent_id: parentId,
        name: fileName,
        size: file.byteLength,
        kind: 'drive#file',
      }),
    });

    // Upload file
    const uploadUrl = uploadData.upload_url;
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: file,
    });
  }

  private async getFileId(path: string, config: Record<string, any>): Promise<string> {
    if (path === '/') return '';
    
    const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
    const parts = cleanPath.split('/');
    let currentId = '';

    for (const part of parts) {
      const data = await this.request(`/drive/v1/files?parent_id=${currentId}&name=${encodeURIComponent(part)}`, config);
      
      if (!data.files || data.files.length === 0) {
        throw new Error(`Path not found: ${path}`);
      }
      currentId = data.files[0].id;
    }

    return currentId;
  }
}
