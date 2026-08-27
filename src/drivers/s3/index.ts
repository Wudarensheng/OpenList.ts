/**
 * S3 Compatible Storage Driver
 * Uses aws4fetch for correct AWS Signature V4 signing in Cloudflare Workers
 * Compatible with AWS S3, Cloudflare R2, Backblaze B2, MinIO, etc.
 */

import { AwsClient } from 'aws4fetch';

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const s3Config: DriverConfig = {
  name: 'S3',
  label: 'S3 Compatible Storage',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

export const s3Additional: DriverItem[] = [
  { name: 'bucket', type: 'string', default: '', options: '', required: true, help: 'Bucket name' },
  { name: 'endpoint', type: 'string', default: '', options: '', required: true, help: 'Endpoint URL' },
  { name: 'region', type: 'string', default: 'us-east-1', options: '', required: false, help: 'Region' },
  { name: 'access_key_id', type: 'string', default: '', options: '', required: true, help: 'Access key ID' },
  { name: 'access_key_secret', type: 'string', default: '', options: '', required: true, help: 'Secret access key' },
  { name: 'root_path', type: 'string', default: '', options: '', required: false, help: 'Root path prefix' },
  { name: 'custom_host', type: 'string', default: '', options: '', required: false, help: 'Custom host' },
  { name: 'sign_url_expire', type: 'number', default: '3600', options: '', required: false, help: 'Sign URL expire (seconds)' },
  { name: 'placeholder', type: 'string', default: 'placeholder', options: '', required: false, help: 'Placeholder file' },
  { name: 'enable_custom_host_presign', type: 'bool', default: 'false', options: '', required: false, help: 'Enable custom host presign' },
  { name: 'remove_bucket', type: 'bool', default: 'false', options: '', required: false, help: 'Remove bucket from path' },
  { name: 'list_object_version', type: 'select', default: 'v2', options: 'v1,v2', required: false, help: 'List object version' },
  { name: 'enable_direct_upload', type: 'bool', default: 'false', options: '', required: false, help: 'Enable direct upload' },
  { name: 'direct_upload_host', type: 'string', default: '', options: '', required: false, help: 'Direct upload host (optional)' },
];

export class S3Driver implements Driver {
  private bucket: string = '';
  private endpoint: string = '';
  private region: string = 'us-east-1';
  private accessKeyId: string = '';
  private secretAccessKey: string = '';
  private rootPath: string = '';
  private customHost: string = '';
  private signUrlExpire: number = 3600;
  private enableDirectUpload: boolean = false;
  private directUploadHost: string = '';
  private baseUrl: string = '';
  private client!: AwsClient;

  config(): DriverConfig {
    return s3Config;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.bucket = (cfg.bucket || '').trim();
    this.rootPath = (cfg.root_path || '').trim();
    this.customHost = (cfg.custom_host || '').trim();
    this.signUrlExpire = cfg.sign_url_expire || 3600;
    this.enableDirectUpload = cfg.enable_direct_upload === true || cfg.enable_direct_upload === 'true';
    this.directUploadHost = (cfg.direct_upload_host || '').trim();
    this.region = (cfg.region || 'us-east-1').trim();
    this.accessKeyId = (cfg.access_key_id || '').trim();
    this.secretAccessKey = (cfg.access_key_secret || '').trim();

    let endpoint = (cfg.endpoint || '').trim();
    if (endpoint && !endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
      endpoint = `https://${endpoint}`;
    }
    endpoint = endpoint.replace(/\/+$/, '');
    this.endpoint = endpoint;
    this.baseUrl = `${endpoint}/${this.bucket}`;

    // Auto-detect region from endpoint for B2
    if (this.region === 'auto' || !this.region) {
      const hostMatch = endpoint.match(/s3[.\-]([a-z0-9-]+)\.backblazeb2\.com/i);
      if (hostMatch) {
        this.region = hostMatch[1];
      } else {
        this.region = 'us-east-1';
      }
    }

    this.client = new AwsClient({
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
      service: 's3',
    });
  }

  private getKey(path: string): string {
    const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
    return this.rootPath ? `${this.rootPath}/${cleanPath}`.replace(/\/+/g, '/') : cleanPath;
  }

  // Percent-encode a key for use in a URL path, preserving path separators
  // (encodeURIComponent would also encode '/').
  private encodePath(key: string): string {
    return key.split('/').map(seg => encodeURIComponent(seg)).join('/');
  }

  private async s3Fetch(url: string, init: RequestInit): Promise<Response> {
    return this.client.fetch(url, init);
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const prefix = this.getKey(path);
    const normalizedPrefix = prefix ? (prefix.endsWith('/') ? prefix : prefix + '/') : '';

    const content: Obj[] = [];
    let continuationToken: string | undefined;

    do {
      const params = new URLSearchParams({
        'list-type': '2',
        'delimiter': '/',
      });
      if (normalizedPrefix) params.set('prefix', normalizedPrefix);
      if (continuationToken) params.set('continuation-token', continuationToken);

      const url = `${this.baseUrl}/?${params.toString()}`;
      const resp = await this.s3Fetch(url, { method: 'GET' });
      const xml = await resp.text();

      if (!resp.ok) {
        throw new Error(`S3 list failed: ${resp.status} ${xml}`);
      }

      // Parse XML manually (no DOMParser needed)
      const prefixes = xml.match(/<CommonPrefixes>[\s\S]*?<\/CommonPrefixes>/g) || [];
      for (const p of prefixes) {
        const nameMatch = p.match(/<Prefix>(.*?)<\/Prefix>/);
        if (nameMatch) {
          const name = nameMatch[1].replace(normalizedPrefix, '').replace(/\/$/, '');
          if (name) {
            content.push(createDirObj({ name, modified: new Date().toISOString() }));
          }
        }
      }

      const contents = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
      for (const c of contents) {
        const keyMatch = c.match(/<Key>(.*?)<\/Key>/);
        if (!keyMatch) continue;
        const key = keyMatch[1];
        if (key === normalizedPrefix) continue;
        const name = key.replace(normalizedPrefix, '');
        if (name && !name.includes('/')) {
          const sizeMatch = c.match(/<Size>(.*?)<\/Size>/);
          const modMatch = c.match(/<LastModified>(.*?)<\/LastModified>/);
          content.push(createFileObj({
            name,
            size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
            modified: modMatch ? modMatch[1] : new Date().toISOString(),
          }));
        }
      }

      const isTruncated = xml.includes('<IsTruncated>true</IsTruncated>');
      if (isTruncated) {
        const tokenMatch = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/);
        continuationToken = tokenMatch ? tokenMatch[1] : undefined;
      } else {
        continuationToken = undefined;
      }
    } while (continuationToken);

    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const key = this.getKey(path);

    // Root path (or empty key) is always a directory, never a file.
    // Otherwise HEAD on the bucket root returns 200 and we'd misreport it as a file.
    if (!key) {
      return createDirObj({ name: path === '/' ? '/' : path, modified: new Date().toISOString() });
    }

    const url = `${this.baseUrl}/${this.encodePath(key)}`;

    const resp = await this.s3Fetch(url, { method: 'HEAD' });

    if (resp.ok) {
      // Keys ending with '/' are folder markers
      if (key.endsWith('/')) {
        return createDirObj({
          name: path.split('/').pop() || path,
          modified: resp.headers.get('last-modified') || new Date().toISOString(),
        });
      }
      return createFileObj({
        name: path.split('/').pop() || path,
        size: parseInt(resp.headers.get('content-length') || '0'),
        modified: resp.headers.get('last-modified') || new Date().toISOString(),
      });
    }

    // HEAD may be rejected by some S3-compatible providers (e.g. Backblaze B2
    // returns 404/403 for HEAD on keys with non-ASCII characters even though
    // GET and list work fine). Fall back to a list-objects query.
    if (resp.status === 404 || resp.status === 403) {
      const obj = await this.getViaList(key, path);
      if (obj) return obj;
    }

    throw new Error(`S3 head failed: ${resp.status}`);
  }

  // Fallback for providers where HEAD is unreliable: probe via ListObjectsV2.
  // - Directory: any CommonPrefixes/Contents under `<key>/`
  // - File: an exact `<Key>` match equal to `key`
  private async getViaList(key: string, path: string): Promise<Obj | null> {
    const name = path.split('/').pop() || path;
    const dirPrefix = key.endsWith('/') ? key : key + '/';

    // 1) Directory check: children under `key/`
    const dirParams = new URLSearchParams({ 'list-type': '2', 'delimiter': '/' });
    dirParams.set('prefix', dirPrefix);
    const dirResp = await this.s3Fetch(`${this.baseUrl}/?${dirParams.toString()}`, { method: 'GET' });
    const dirXml = await dirResp.text();
    if (dirResp.ok && (dirXml.includes('<CommonPrefixes>') || dirXml.includes('<Contents>'))) {
      return createDirObj({ name, modified: new Date().toISOString() });
    }

    // 2) Exact file check: object whose key equals `key`
    const fileParams = new URLSearchParams({ 'list-type': '2' });
    fileParams.set('prefix', key);
    const fileUrl = `${this.baseUrl}/?${fileParams.toString()}`;
    const fileResp = await this.s3Fetch(fileUrl, { method: 'GET' });
    if (!fileResp.ok) return null;
    const fileXml = await fileResp.text();
    const contents = fileXml.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
    for (const c of contents) {
      const keyMatch = c.match(/<Key>(.*?)<\/Key>/);
      if (!keyMatch || keyMatch[1] !== key) continue;
      const sizeMatch = c.match(/<Size>(.*?)<\/Size>/);
      const modMatch = c.match(/<LastModified>(.*?)<\/LastModified>/);
      return createFileObj({
        name,
        size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
        modified: modMatch ? modMatch[1] : new Date().toISOString(),
      });
    }

    return null;
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const key = this.getKey(path);
    const url = `${this.baseUrl}/${key}`;

    // Generate presigned URL using aws4fetch.
    // X-Amz-Expires must be set as a QUERY parameter BEFORE signing:
    // if set as a request header, aws4fetch includes it in SignedHeaders,
    // and S3/B2 rejects the presigned URL (header not actually sent).
    const signUrl = new URL(url);
    signUrl.searchParams.set('X-Amz-Expires', String(this.signUrlExpire));
    const signed = await this.client.sign(new Request(signUrl.toString()), {
      aws: { signQuery: true },
    });

    let finalUrl = signed.url;
    if (this.customHost) {
      const urlObj = new URL(finalUrl);
      finalUrl = `${this.customHost}${urlObj.pathname}${urlObj.search}`;
    }

    return { url: finalUrl };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const key = this.getKey(path) + '/';
    const url = `${this.baseUrl}/${this.encodePath(key)}`;
    const resp = await this.s3Fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/x-directory' },
      body: new Uint8Array(0),
    });
    if (!resp.ok) {
      throw new Error(`S3 mkdir failed: ${resp.status} ${await resp.text()}`);
    }
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const oldKey = this.getKey(path);
    const parentPath = path.substring(0, path.lastIndexOf('/'));
    const newKey = this.getKey(`${parentPath}/${newName}`);
    await this.copyFile(oldKey, newKey);
    await this.deleteFile(oldKey);
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    await this.copyFile(this.getKey(src), this.getKey(dst));
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const srcKey = this.getKey(src);
    const dstKey = this.getKey(dst);
    await this.copyFile(srcKey, dstKey);
    await this.deleteFile(srcKey);
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    await this.deleteFile(this.getKey(path));
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const key = this.getKey(path);
    const url = `${this.baseUrl}/${this.encodePath(key)}`;
    const resp = await this.s3Fetch(url, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: new Uint8Array(file),
    });
    if (!resp.ok) {
      throw new Error(`S3 put failed: ${resp.status} ${await resp.text()}`);
    }
  }

  // Presign a direct upload URL (PUT) so the client can upload without going
  // through the worker. Enabled via the `enable_direct_upload` config.
  async getDirectUploadInfo(path: string, cfg: Record<string, any>): Promise<any> {
    if (!this.enableDirectUpload) {
      throw new Error('direct upload is not enabled for this storage');
    }
    const key = this.getKey(path);
    const url = `${this.baseUrl}/${this.encodePath(key)}`;

    const signUrl = new URL(url);
    signUrl.searchParams.set('X-Amz-Expires', String(this.signUrlExpire));
    const signed = await this.client.sign(new Request(signUrl.toString(), { method: 'PUT' }), {
      aws: { signQuery: true },
    });

    let uploadUrl = signed.url;
    if (this.directUploadHost) {
      const urlObj = new URL(uploadUrl);
      uploadUrl = `${this.directUploadHost}${urlObj.pathname}${urlObj.search}`;
    }

    return { upload_url: uploadUrl, chunk_size: 0, method: 'PUT' };
  }

  // /api/fs/other - expose the presigned upload URL when direct upload is on.
  async other(path: string, cfg: Record<string, any>): Promise<any> {
    if (this.enableDirectUpload && !(await this.exists(path, cfg))) {
      return { direct_upload_info: await this.getDirectUploadInfo(path, cfg) };
    }
    return {};
  }

  private async exists(path: string, cfg: Record<string, any>): Promise<boolean> {
    try {
      await this.get(path, cfg);
      return true;
    } catch {
      return false;
    }
  }

  private async copyFile(srcKey: string, dstKey: string): Promise<void> {    const url = `${this.baseUrl}/${this.encodePath(dstKey)}`;
    const resp = await this.s3Fetch(url, {
      method: 'PUT',
      headers: { 'x-amz-copy-source': `${this.bucket}/${this.encodePath(srcKey)}` },
    });
    if (!resp.ok) {
      throw new Error(`S3 copy failed: ${resp.status} ${await resp.text()}`);
    }
  }

  private async deleteFile(key: string): Promise<void> {
    const url = `${this.baseUrl}/${this.encodePath(key)}`;
    const resp = await this.s3Fetch(url, { method: 'DELETE' });
    if (!resp.ok && resp.status !== 404) {
      throw new Error(`S3 delete failed: ${resp.status} ${await resp.text()}`);
    }
  }
}

registerDriver(S3Driver, s3Config, s3Additional);
