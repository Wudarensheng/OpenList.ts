/**
 * OneDrive / SharePoint 分享链接 (OneDrive Sharelink) Driver — read-only
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/onedrive_sharelink.
 *
 * Given a public share URL, resolve short links (1drv.ms) via HEAD, list
 * single-file shares directly and folder shares through the SharePoint
 * _api/web/GetListUsingPath(...)/renderListDataAsStream endpoint.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const onedriveSharelinkConfig: DriverConfig = {
  name: 'OneDriveShare',
  label: 'OneDrive 分享链接',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: true,
  default_root: '/',
};

export const onedriveSharelinkAdditional: DriverItem[] = [
  { name: 'url', type: 'string', default: '', options: '', required: true, help: '分享链接' },
  { name: 'password', type: 'string', default: '', options: '', required: false, help: '访问密码 (保留字段)' },
  { name: 'disable_disk_usage', type: 'bool', default: 'false', options: '', required: false, help: '禁用磁盘占用 (保留字段)' },
  { name: 'enable_direct_upload', type: 'bool', default: 'false', options: '', required: false, help: '允许直传 (保留字段)' },
  { name: 'root_folder_path', type: 'string', default: '/', options: '', required: false, help: '根目录路径' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,size,modified', required: false, help: '排序字段' },
  { name: 'order_direction', type: 'select', default: '', options: 'ASC,DESC', required: false, help: '排序方向' },
];

interface OnedriveShareItem {
  id: string;
  name: string;
  size: number;
  is_folder: boolean;
  modified: string;
  download_url?: string;
}

interface SharepointRow {
  FSObjType: string | number; // 1 = folder, 0 = file
  FileLeafRef: string;
  File_x0020_Size?: string;
  UniqueId: string;
  'Modified.'?: string;
  '@content.downloadUrl'?: string;
}

interface SharepointListDataResp {
  ListData?: {
    Row?: SharepointRow[];
  };
}

class OnedriveSharelinkApiClient {
  private shareUrl: string;
  private finalUrl = '';

  constructor(cfg: Record<string, any>) {
    this.shareUrl = cfg.url || '';
  }

  async init(): Promise<void> {
    if (!this.shareUrl) {
      throw new Error('OneDriveShare: url is required');
    }

    // Resolve short links (like 1drv.ms)
    try {
      const res = await fetch(this.shareUrl, {
        method: 'HEAD',
        redirect: 'follow',
      });
      this.finalUrl = res.url || this.shareUrl;
    } catch {
      this.finalUrl = this.shareUrl;
    }
  }

  async getFiles(folderPath = '/'): Promise<OnedriveShareItem[]> {
    if (!this.finalUrl) {
      await this.init();
    }

    const u = new URL(this.finalUrl);
    // For single file shared links
    if (
      u.pathname.includes('/:u:/') ||
      u.pathname.includes('/:v:/') ||
      u.pathname.includes('/:b:/')
    ) {
      const fileName = decodeURIComponent(u.pathname.split('/').pop() || 'file');
      return [
        {
          id: 'root_file',
          name: fileName,
          size: 0,
          is_folder: false,
          modified: new Date().toISOString(),
          download_url: this.getDirectDownloadLink(this.finalUrl),
        },
      ];
    }

    // Attempt SharePoint renderListDataAsStream
    try {
      const apiUrl = `${u.origin}${u.pathname}/_api/web/GetListUsingPath(DecodedUrl=@a1)/renderListDataAsStream`;
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json;odata=nometadata',
          'Content-Type': 'application/json;odata=verbose',
        },
        body: JSON.stringify({
          parameters: {
            RenderOptions: 5707,
            AllowMultipleValueFilterForTaxonomyFields: true,
            AddRequiredFields: true,
          },
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as SharepointListDataResp;
        const rows = data.ListData?.Row || [];
        return rows.map(r => {
          const isDir = String(r.FSObjType) === '1';
          const sizeNum = parseInt(r.File_x0020_Size || '0', 10);
          return {
            id: r.UniqueId,
            name: r.FileLeafRef,
            size: isDir ? 0 : isNaN(sizeNum) ? 0 : sizeNum,
            is_folder: isDir,
            modified: r['Modified.'] || new Date().toISOString(),
            download_url: r['@content.downloadUrl'],
          };
        });
      }
    } catch {
      // Fallback: empty listing
    }

    return [];
  }

  getDirectDownloadLink(url: string): string {
    const u = new URL(url);
    u.searchParams.set('download', '1');
    return u.toString();
  }
}

export class OnedriveSharelinkDriver implements Driver {
  private cfg: Record<string, any> = {};
  private client: OnedriveSharelinkApiClient = new OnedriveSharelinkApiClient({});

  config(): DriverConfig {
    return onedriveSharelinkConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.client = new OnedriveSharelinkApiClient(cfg);
    await this.client.init();
  }

  private cleanPath(p: string): string {
    const s = '/' + (p || '').split('/').filter(Boolean).join('/');
    return s === '/' ? '/' : s;
  }

  private toObj(f: OnedriveShareItem): Obj {
    const common = {
      name: f.name,
      size: f.is_folder ? 0 : f.size || 0,
      modified: f.modified || new Date().toISOString(),
      id: f.id || f.name,
    };
    return f.is_folder ? createDirObj(common) : createFileObj(common);
  }

  private sort(items: Obj[]): Obj[] {
    const asc = (this.cfg.order_direction || '').toLowerCase() !== 'desc';
    const key = String(this.cfg.order_by || 'name').toLowerCase();
    return [...items].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let cmp: number;
      if (key.includes('size')) cmp = (a.size || 0) - (b.size || 0);
      else if (key.includes('time') || key.includes('modified')) {
        cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
      } else {
        cmp = String(a.name).localeCompare(String(b.name));
      }
      return asc ? cmp : -cmp;
    });
  }

  async list(path: string): Promise<ListResult> {
    const files = await this.client.getFiles(this.cleanPath(path));
    const content = files.map(f => this.toObj(f));
    return { content: this.sort(content), total: content.length };
  }

  async get(path: string): Promise<Obj> {
    const clean = this.cleanPath(path);
    const name = clean.split('/').filter(Boolean).pop() || 'root';

    if (clean === '/') {
      return createDirObj({ name: 'root', modified: new Date().toISOString(), id: 'root' });
    }

    const files = await this.client.getFiles('/');
    const found = files.find(f => f.name === name);
    if (!found) throw new Error(`File not found: ${clean}`);
    return this.toObj(found);
  }

  async link(path: string): Promise<LinkResult> {
    const clean = this.cleanPath(path);
    const name = clean.substring(clean.lastIndexOf('/') + 1);
    if (clean === '/' || !name) throw new Error(`Cannot get link for: ${clean}`);

    const files = await this.client.getFiles('/');
    const found = files.find(f => f.name === name);
    if (!found || found.is_folder) throw new Error(`Cannot get link for: ${clean}`);
    const url = found.download_url || this.client.getDirectDownloadLink(this.cfg.url);
    return { url };
  }

  async mkdir(_path: string): Promise<void> { throw new Error('OneDriveShare is read-only'); }
  async rename(_path: string, _newName: string): Promise<void> { throw new Error('OneDriveShare is read-only'); }
  async copy(_src: string, _dst: string): Promise<void> { throw new Error('OneDriveShare is read-only'); }
  async move(_src: string, _dst: string): Promise<void> { throw new Error('OneDriveShare is read-only'); }
  async remove(_path: string): Promise<void> { throw new Error('OneDriveShare is read-only'); }
  async put(_path: string, _file: ArrayBuffer, _contentType: string): Promise<void> {
    throw new Error('OneDriveShare is read-only');
  }
}

registerDriver(OnedriveSharelinkDriver, onedriveSharelinkConfig, onedriveSharelinkAdditional);
