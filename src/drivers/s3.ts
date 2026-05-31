import { S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Driver, DriverInfo, FileObject, ListResult, LinkResult } from './types';

export const s3Config: DriverInfo = {
  config: {
    name: 'S3',
    label: 'S3 Compatible Storage',
    local_sort: false,
    only_local: false,
    only_proxy: false,
    no_cache: false,
    no_upload: false,
    need_ms: false,
    default_root: '/',
  },
  additional: [
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
  ],
};

export class S3Driver implements Driver {
  private client!: S3Client;
  private bucket: string = '';
  private rootPath: string = '';
  private customHost: string = '';
  private signUrlExpire: number = 3600;
  private removeBucket: boolean = false;
  private listObjectVersion: string = 'v2';

  async init(config: Record<string, any>): Promise<void> {
    this.bucket = config.bucket;
    this.rootPath = config.root_path || '';
    this.customHost = config.custom_host || '';
    this.signUrlExpire = config.sign_url_expire || 3600;
    this.removeBucket = config.remove_bucket || false;
    this.listObjectVersion = config.list_object_version || 'v2';

    this.client = new S3Client({
      region: config.region || 'us-east-1',
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.access_key_id,
        secretAccessKey: config.access_key_secret,
      },
      forcePathStyle: true,
    });
  }

  private getKey(path: string): string {
    const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
    return this.rootPath ? `${this.rootPath}/${cleanPath}`.replace(/\/+/g, '/') : cleanPath;
  }

  async list(path: string, config: Record<string, any>): Promise<ListResult> {
    const prefix = this.getKey(path);
    const normalizedPrefix = prefix ? (prefix.endsWith('/') ? prefix : prefix + '/') : '';

    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: normalizedPrefix,
      Delimiter: '/',
    });

    const response = await this.client.send(command);
    const content: FileObject[] = [];

    if (response.CommonPrefixes) {
      for (const cp of response.CommonPrefixes) {
        const name = cp.Prefix?.replace(normalizedPrefix, '').replace(/\/$/, '') || '';
        if (name) {
          content.push({
            name,
            size: 0,
            is_dir: true,
            modified: new Date().toISOString(),
          });
        }
      }
    }

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key === normalizedPrefix) continue;
        const name = obj.Key?.replace(normalizedPrefix, '') || '';
        if (name && !name.includes('/')) {
          content.push({
            name,
            size: obj.Size || 0,
            is_dir: false,
            modified: obj.LastModified?.toISOString() || new Date().toISOString(),
          });
        }
      }
    }

    return { content, total: content.length };
  }

  async get(path: string, config: Record<string, any>): Promise<FileObject> {
    const key = this.getKey(path);
    const command = new HeadObjectCommand({ Bucket: this.bucket, Key: key });
    const response = await this.client.send(command);

    return {
      name: path.split('/').pop() || path,
      size: response.ContentLength || 0,
      is_dir: false,
      modified: response.LastModified?.toISOString() || new Date().toISOString(),
    };
  }

  async link(path: string, config: Record<string, any>): Promise<LinkResult> {
    const key = this.getKey(path);
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const url = await getSignedUrl(this.client, command, { expiresIn: this.signUrlExpire });

    if (this.customHost) {
      const urlObj = new URL(url);
      return { url: `${this.customHost}${urlObj.pathname}${urlObj.search}` };
    }

    return { url };
  }

  async mkdir(path: string, config: Record<string, any>): Promise<void> {
    const key = this.getKey(path) + '/';
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: new Uint8Array(0),
      ContentType: 'application/x-directory',
    });
    await this.client.send(command);
  }

  async rename(path: string, newName: string, config: Record<string, any>): Promise<void> {
    const oldKey = this.getKey(path);
    const parentPath = path.substring(0, path.lastIndexOf('/'));
    const newKey = this.getKey(`${parentPath}/${newName}`);

    await this.copyFile(oldKey, newKey);
    await this.deleteFile(oldKey);
  }

  async copy(src: string, dst: string, config: Record<string, any>): Promise<void> {
    const srcKey = this.getKey(src);
    const dstKey = this.getKey(dst);
    await this.copyFile(srcKey, dstKey);
  }

  async move(src: string, dst: string, config: Record<string, any>): Promise<void> {
    const srcKey = this.getKey(src);
    const dstKey = this.getKey(dst);
    await this.copyFile(srcKey, dstKey);
    await this.deleteFile(srcKey);
  }

  async remove(path: string, config: Record<string, any>): Promise<void> {
    const key = this.getKey(path);
    await this.deleteFile(key);
  }

  async put(path: string, file: ArrayBuffer, contentType: string, config: Record<string, any>): Promise<void> {
    const key = this.getKey(path);
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: new Uint8Array(file),
      ContentType: contentType,
    });
    await this.client.send(command);
  }

  private async copyFile(srcKey: string, dstKey: string): Promise<void> {
    const command = new CopyObjectCommand({
      Bucket: this.bucket,
      CopySource: `${this.bucket}/${srcKey}`,
      Key: dstKey,
    });
    await this.client.send(command);
  }

  private async deleteFile(key: string): Promise<void> {
    const command = new DeleteObjectCommand({ Bucket: this.bucket, Key: key });
    await this.client.send(command);
  }
}
