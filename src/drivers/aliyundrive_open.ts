import { Driver, DriverConfig, DriverInfo, FileObject, ListResult, LinkResult } from './types';

const API_BASE = 'https://openapi.alipan.com';

export const aliyundriveOpenConfig: DriverInfo = {
  config: {
    name: 'AliyundriveOpen',
    label: 'Aliyun Drive (Open)',
    local_sort: false,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false,
    need_ms: false,
    default_root: 'root',
  },
  additional: [
    { name: 'refresh_token', type: 'string', default: '', options: '', required: true, help: 'Refresh token (from Aliyun OAuth)' },
    { name: 'client_id', type: 'string', default: '', options: '', required: false, help: 'Client ID (default: official)' },
    { name: 'client_secret', type: 'string', default: '', options: '', required: false, help: 'Client secret (default: official)' },
    { name: 'order_by', type: 'select', default: 'updated_at', options: 'updated_at,created_at,name,size', required: false, help: 'Order by' },
    { name: 'order_direction', type: 'select', default: 'ASC', options: 'ASC,DESC', required: false, help: 'Order direction' },
    { name: 'rapid_upload', type: 'bool', default: 'false', options: '', required: false, help: 'Enable rapid upload' },
    { name: 'chunk_size', type: 'number', default: '10', options: '', required: false, help: 'Upload chunk size (MB)' },
  ],
};

export class AliyundriveOpenDriver implements Driver {
  private accessToken: string = '';
  private refreshToken: string = '';
  private defaultClientId = 'paw0MoFSYob6QhRw';
  private defaultClientSecret = 'aOAlPqULuG5kQ2rO';

  async init(config: Record<string, any>): Promise<void> {
    this.refreshToken = config.refresh_token;
    await this.refreshAccessToken(config);
  }

  private async refreshAccessToken(config: Record<string, any>): Promise<void> {
    const clientId = config.client_id || this.defaultClientId;
    const clientSecret = config.client_secret || this.defaultClientSecret;

    const resp = await fetch('https://auth.aliyundrive.com/v2/account/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Failed to refresh token: ${resp.statusText}`);
    }

    const data = await resp.json();
    this.accessToken = data.access_token;
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }
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
      throw new Error(`Aliyun Drive API error: ${resp.status} ${err}`);
    }

    return resp.json();
  }

  async list(path: string, config: Record<string, any>): Promise<ListResult> {
    const fileId = path === '/' || path === 'root' ? 'root' : await this.getFileId(path, config);
    
    const data = await this.request('/adrive/v1.0/openFile/list', config, {
      method: 'POST',
      body: JSON.stringify({
        drive_id: await this.getDriveId(config),
        parent_file_id: fileId,
        order_by: config.order_by || 'updated_at',
        order_direction: config.order_direction || 'ASC',
        limit: 200,
      }),
    });

    const content: FileObject[] = (data.items || []).map((item: any) => ({
      name: item.name,
      size: item.size || 0,
      is_dir: item.type === 'folder',
      modified: item.updated_at || new Date().toISOString(),
      created: item.created_at,
      thumb: item.thumbnail,
    }));

    return { content, total: content.length };
  }

  async get(path: string, config: Record<string, any>): Promise<FileObject> {
    const fileId = await this.getFileId(path, config);
    const data = await this.request(`/adrive/v1.0/openFile/get`, config, {
      method: 'POST',
      body: JSON.stringify({
        drive_id: await this.getDriveId(config),
        file_id: fileId,
      }),
    });

    return {
      name: data.name,
      size: data.size || 0,
      is_dir: data.type === 'folder',
      modified: data.updated_at || new Date().toISOString(),
      created: data.created_at,
      thumb: data.thumbnail,
    };
  }

  async link(path: string, config: Record<string, any>): Promise<LinkResult> {
    const fileId = await this.getFileId(path, config);
    
    const data = await this.request(`/adrive/v1.0/openFile/getDownloadUrl`, config, {
      method: 'POST',
      body: JSON.stringify({
        drive_id: await this.getDriveId(config),
        file_id: fileId,
      }),
    });

    return {
      url: data.url,
      header: data.headers || {},
    };
  }

  async mkdir(path: string, config: Record<string, any>): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const dirName = path.substring(path.lastIndexOf('/') + 1);
    const parentFileId = parentPath === '/' || parentPath === 'root' ? 'root' : await this.getFileId(parentPath, config);

    await this.request('/adrive/v1.0/openFile/create', config, {
      method: 'POST',
      body: JSON.stringify({
        drive_id: await this.getDriveId(config),
        parent_file_id: parentFileId,
        name: dirName,
        type: 'folder',
      }),
    });
  }

  async rename(path: string, newName: string, config: Record<string, any>): Promise<void> {
    const fileId = await this.getFileId(path, config);
    
    await this.request('/adrive/v1.0/openFile/update', config, {
      method: 'POST',
      body: JSON.stringify({
        drive_id: await this.getDriveId(config),
        file_id: fileId,
        name: newName,
      }),
    });
  }

  async copy(src: string, dst: string, config: Record<string, any>): Promise<void> {
    const srcFileId = await this.getFileId(src, config);
    const dstParent = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstParentFileId = dstParent === '/' || dstParent === 'root' ? 'root' : await this.getFileId(dstParent, config);

    await this.request('/adrive/v1.0/openFile/copy', config, {
      method: 'POST',
      body: JSON.stringify({
        drive_id: await this.getDriveId(config),
        file_id: srcFileId,
        to_parent_file_id: dstParentFileId,
      }),
    });
  }

  async move(src: string, dst: string, config: Record<string, any>): Promise<void> {
    const srcFileId = await this.getFileId(src, config);
    const dstParent = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstParentFileId = dstParent === '/' || dstParent === 'root' ? 'root' : await this.getFileId(dstParent, config);

    await this.request('/adrive/v1.0/openFile/move', config, {
      method: 'POST',
      body: JSON.stringify({
        drive_id: await this.getDriveId(config),
        file_id: srcFileId,
        to_parent_file_id: dstParentFileId,
      }),
    });
  }

  async remove(path: string, config: Record<string, any>): Promise<void> {
    const fileId = await this.getFileId(path, config);
    
    await this.request('/adrive/v1.0/openFile/delete', config, {
      method: 'POST',
      body: JSON.stringify({
        drive_id: await this.getDriveId(config),
        file_id: fileId,
      }),
    });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, config: Record<string, any>): Promise<void> {
    const fileName = path.substring(path.lastIndexOf('/') + 1);
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const parentFileId = parentPath === '/' || parentPath === 'root' ? 'root' : await this.getFileId(parentPath, config);
    const driveId = await this.getDriveId(config);
    const chunkSize = (config.chunk_size || 10) * 1024 * 1024;

    // Create file
    const createData = await this.request('/adrive/v1.0/openFile/create', config, {
      method: 'POST',
      body: JSON.stringify({
        drive_id: driveId,
        parent_file_id: parentFileId,
        name: fileName,
        type: 'file',
        size: file.byteLength,
        check_name_mode: 'overwrite',
      }),
    });

    const fileId = createData.file_id;
    const uploadId = createData.upload_id;

    // Upload parts
    const parts: any[] = [];
    let offset = 0;
    let partNumber = 1;

    while (offset < file.byteLength) {
      const chunk = file.slice(offset, Math.min(offset + chunkSize, file.byteLength));
      
      const partData = await this.request('/adrive/v1.0/openFile/getUploadUrl', config, {
        method: 'POST',
        body: JSON.stringify({
          drive_id: driveId,
          file_id: fileId,
          upload_id: uploadId,
          part_number: partNumber,
          part_size: chunk.byteLength,
        }),
      });

      await fetch(partData.url, {
        method: 'PUT',
        body: chunk,
      });

      parts.push({ part_number: partNumber, etag: 'etag' });
      offset += chunkSize;
      partNumber++;
    }

    // Complete upload
    await this.request('/adrive/v1.0/openFile/complete', config, {
      method: 'POST',
      body: JSON.stringify({
        drive_id: driveId,
        file_id: fileId,
        upload_id: uploadId,
      }),
    });
  }

  private async getDriveId(config: Record<string, any>): Promise<string> {
    if (config._driveId) return config._driveId;
    
    const data = await this.request('/adrive/v1.0/user/getDriveInfo', config, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    
    config._driveId = data.default_drive_id;
    return data.default_drive_id;
  }

  private async getFileId(path: string, config: Record<string, any>): Promise<string> {
    if (path === '/' || path === 'root') return 'root';
    
    const driveId = await this.getDriveId(config);
    const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
    const parts = cleanPath.split('/');
    let currentId = 'root';

    for (const part of parts) {
      const data = await this.request('/adrive/v1.0/openFile/search', config, {
        method: 'POST',
        body: JSON.stringify({
          drive_id: driveId,
          query: `name = "${part}" and parent_file_id = "${currentId}"`,
        }),
      });

      if (!data.items || data.items.length === 0) {
        throw new Error(`Path not found: ${path}`);
      }
      currentId = data.items[0].file_id;
    }

    return currentId;
  }
}
