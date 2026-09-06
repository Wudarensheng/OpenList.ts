/**
 * WPS 网盘 Driver
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/wps.
 *
 * Cookie-authenticated driver for WPS 云盘. Personal (drive.wps.cn) and
 * Business (365.kdocs.cn /3rd/drive) endpoints are both supported. The mount
 * root lists groups; files/folders live under each group. Direct upload needs
 * a chunked protocol that is not implemented in the reference driver, so put()
 * throws and no_upload is set.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const wpsConfig: DriverConfig = {
  name: 'WPS',
  label: 'WPS',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: true,
  default_root: '/',
};

export const wpsAdditional: DriverItem[] = [
  { name: 'cookie', type: 'string', default: '', options: '', required: true, help: '登录 Cookie（从浏览器复制）' },
  { name: 'mode', type: 'select', default: 'Personal', options: 'Personal,Business', required: false, help: '账号类型: 个人版 or 企业版' },
  { name: 'custom_ua', type: 'string', default: '', options: '', required: false, help: '自定义 User-Agent（留空使用默认）' },
  { name: 'root_folder_path', type: 'string', default: '/', options: '', required: false, help: '根文件夹路径，默认为 /' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,time,size', required: false, help: '排序字段' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: '排序方向' },
];

const ENDPOINT_BUSINESS = 'https://365.kdocs.cn';
const ENDPOINT_PERSONAL = 'https://drive.wps.cn';

interface WpsLoginState {
  account_num?: number;
  companyid?: number;
  current_companyid?: number;
  is_company_account?: boolean;
  is_plus?: boolean;
  loginmode?: string;
  userid?: number;
}

interface WpsGroup {
  company_id?: number;
  group_id?: number;
  name: string;
  id?: number;
}

interface WpsFileInfo {
  groupid: number;
  parentid: number;
  fname: string;
  fsize: number;
  ftype: string;
  ctime: number;
  mtime: number;
  id: number;
  deleted?: boolean;
  file_perms_acl?: { download?: number };
}

interface WpsFilesResp {
  files: WpsFileInfo[];
  next_offset: number;
}

interface WpsDownloadResp {
  url: string;
  result?: string;
}

interface ResolvedNode {
  kind: 'root' | 'group' | 'folder' | 'file';
  groupId: number;
  fileId: number;
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

class WpsApiClient {
  private cfg: Record<string, any>;
  public loginState?: WpsLoginState;

  constructor(cfg: Record<string, any>) {
    this.cfg = cfg;
  }

  isPersonal(): boolean {
    if (this.loginState?.is_company_account !== undefined) {
      return !this.loginState.is_company_account;
    }
    return (this.cfg.mode || 'Personal') === 'Personal';
  }

  driveHost(): string {
    return this.isPersonal() ? ENDPOINT_PERSONAL : ENDPOINT_BUSINESS;
  }

  drivePrefix(): string {
    return this.isPersonal() ? '' : '/3rd/drive';
  }

  driveUrl(path: string): string {
    return `${this.driveHost()}${this.drivePrefix()}${path}`;
  }

  getUA(): string {
    return (
      this.cfg.custom_ua ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
  }

  private async request<T = any>(
    url: string,
    options: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
      params?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const fullUrl = new URL(url);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        fullUrl.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      Cookie: this.cfg.cookie || '',
      Accept: 'application/json',
      'User-Agent': this.getUA(),
      Origin: this.driveHost(),
      ...options.headers,
    };

    let body: any = undefined;
    if (options.body !== undefined) {
      if (typeof options.body === 'object') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      } else {
        body = options.body;
      }
    }

    const res = await fetch(fullUrl.toString(), {
      method: options.method || 'GET',
      headers,
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`WPS API error (${res.status}): ${text}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = (await res.json()) as any;
      if (json.result && json.result !== 'ok' && json.result !== 'success') {
        throw new Error(`WPS API error: ${json.result} - ${json.msg || ''}`);
      }
      return json as T;
    }
    return (await res.text()) as any;
  }

  async init(): Promise<void> {
    const res = await this.request<WpsLoginState>(
      'https://account.kdocs.cn/api/v3/islogin',
      { method: 'GET' },
    );
    this.loginState = res;
  }

  async getGroups(): Promise<WpsGroup[]> {
    if (this.isPersonal()) {
      const res = await this.request<{
        groups: Array<{ id: number; name: string }>;
      }>(this.driveUrl('/api/v3/groups'));
      return (res.groups || []).map((g) => ({
        group_id: g.id,
        id: g.id,
        name: g.name,
      }));
    }

    const companyId = this.loginState?.companyid || 0;
    const url = `${ENDPOINT_BUSINESS}/3rd/plus/groups/v1/companies/${companyId}/users/self/groups/private`;
    const res = await this.request<{ groups: WpsGroup[] }>(url);
    return res.groups || [];
  }

  async getFiles(groupId: number, parentId: number): Promise<WpsFileInfo[]> {
    const files: WpsFileInfo[] = [];
    let nextOffset = 0;

    for (let i = 0; i < 50; i++) {
      const url = this.driveUrl(`/api/v5/groups/${groupId}/files`);
      const res = await this.request<WpsFilesResp>(url, {
        params: {
          parentid: String(parentId),
          offset: String(nextOffset),
        },
      });

      if (res.files && res.files.length > 0) {
        files.push(...res.files);
      }

      if (res.next_offset === -1 || res.next_offset === undefined) {
        break;
      }
      nextOffset = res.next_offset;
    }

    return files;
  }

  async getDownloadUrl(groupId: number, fileId: number): Promise<string> {
    const url = this.driveUrl(
      `/api/v5/groups/${groupId}/files/${fileId}/download?support_checksums=sha1`,
    );
    const res = await this.request<WpsDownloadResp>(url);
    if (!res.url) {
      throw new Error('Empty download url received from WPS');
    }
    return res.url;
  }

  async createFolder(groupId: number, parentId: number, name: string): Promise<void> {
    await this.request(this.driveUrl('/api/v5/files/folder'), {
      method: 'POST',
      body: {
        groupid: groupId,
        parentid: parentId,
        name,
      },
    });
  }

  async rename(groupId: number, fileId: number, newName: string): Promise<void> {
    await this.request(
      this.driveUrl(`/api/v3/groups/${groupId}/files/${fileId}`),
      {
        method: 'PUT',
        body: { fname: newName },
      },
    );
  }

  async move(
    groupId: number,
    fileId: number,
    targetGroupId: number,
    targetParentId: number,
  ): Promise<void> {
    await this.request(
      this.driveUrl(`/api/v3/groups/${groupId}/files/batch/move`),
      {
        method: 'POST',
        body: {
          fileids: [fileId],
          target_groupid: targetGroupId,
          target_parentid: targetParentId,
        },
      },
    );
  }

  async copy(
    groupId: number,
    fileId: number,
    targetGroupId: number,
    targetParentId: number,
  ): Promise<void> {
    await this.request(
      this.driveUrl(`/api/v3/groups/${groupId}/files/batch/copy`),
      {
        method: 'POST',
        body: {
          fileids: [fileId],
          groupid: groupId,
          target_groupid: targetGroupId,
          target_parentid: targetParentId,
          duplicated_name_model: 1,
        },
      },
    );
  }

  async delete(groupId: number, fileId: number): Promise<void> {
    await this.request(
      this.driveUrl(`/api/v3/groups/${groupId}/files/batch/delete`),
      {
        method: 'POST',
        body: {
          fileids: [fileId],
        },
      },
    );
  }
}

/**
 * WPS 网盘 Driver Implementation
 */
export class WpsDriver implements Driver {
  private cfg: Record<string, any> = {};
  private client: WpsApiClient = new WpsApiClient({});

  config(): DriverConfig {
    return wpsConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.client = new WpsApiClient(cfg);
    if (!(cfg.cookie || '').trim()) {
      throw new Error('WPS cookie is required');
    }
    await this.client.init();
  }

  private cleanPath(p: string): string {
    const s = '/' + (p || '').split('/').filter(Boolean).join('/');
    return s === '/' ? '/' : s;
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private async resolvePath(p: string): Promise<ResolvedNode | null> {
    const clean = this.cleanPath(p);
    if (clean === '/') {
      return {
        kind: 'root',
        groupId: 0,
        fileId: 0,
        name: 'root',
        isDir: true,
        size: 0,
        modified: this.nowIso(),
      };
    }

    const parts = clean.split('/').filter(Boolean);
    const groups = await this.client.getGroups();
    const group = groups.find((g) => g.name === parts[0]);
    if (!group) return null;

    const groupId = group.group_id || group.id || 0;
    if (parts.length === 1) {
      return {
        kind: 'group',
        groupId,
        fileId: 0,
        name: group.name,
        isDir: true,
        size: 0,
        modified: this.nowIso(),
      };
    }

    let currentParentId = 0;
    let currentNode: ResolvedNode | null = null;

    for (let i = 1; i < parts.length; i++) {
      const partName = parts[i];
      const files = await this.client.getFiles(groupId, currentParentId);
      const found: WpsFileInfo | undefined = files.find(
        (f) => f.fname === partName,
      );
      if (!found) return null;

      const isDir = found.ftype === 'folder';
      currentNode = {
        kind: isDir ? 'folder' : 'file',
        groupId,
        fileId: found.id,
        name: found.fname,
        isDir,
        size: found.fsize || 0,
        modified: found.mtime
          ? new Date(found.mtime * 1000).toISOString()
          : this.nowIso(),
      };
      currentParentId = found.id;
    }

    return currentNode;
  }

  private nodeToObj(node: ResolvedNode): Obj {
    const common = {
      name: node.name,
      size: node.isDir ? 0 : node.size || 0,
      modified: node.modified,
      id: String(node.fileId || node.groupId || 0),
    };
    return node.isDir ? createDirObj(common) : createFileObj(common);
  }

  private sortItems(items: Obj[]): Obj[] {
    const asc = String(this.cfg.order_direction || '') !== 'desc';
    const key = String(this.cfg.order_by || 'name').toLowerCase();
    return [...items].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let cmp: number;
      if (key.includes('size')) {
        cmp = (a.size || 0) - (b.size || 0);
      } else if (key.includes('time') || key.includes('modified')) {
        cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
      } else {
        cmp = String(a.name).localeCompare(String(b.name));
      }
      return asc ? cmp : -cmp;
    });
  }

  // Destination directory of a full target path (name stripped).
  private dstDirOf(dst: string): string {
    const clean = this.cleanPath(dst);
    const i = clean.lastIndexOf('/');
    return i <= 0 ? '/' : clean.substring(0, i);
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const clean = this.cleanPath(path);
    const node = await this.resolvePath(clean);
    if (!node || !node.isDir) {
      return { content: [], total: 0 };
    }

    if (node.kind === 'root') {
      const groups = await this.client.getGroups();
      const content: Obj[] = groups.map((g) =>
        createDirObj({
          name: g.name,
          modified: this.nowIso(),
          id: String(g.group_id || g.id),
        })
      );
      return { content: this.sortItems(content), total: content.length };
    }

    const files = await this.client.getFiles(node.groupId, node.fileId);
    const content: Obj[] = files.map((f) => {
      const isDir = f.ftype === 'folder';
      const common = {
        name: f.fname,
        size: f.fsize || 0,
        modified: f.mtime
          ? new Date(f.mtime * 1000).toISOString()
          : this.nowIso(),
        id: String(f.id),
      };
      return isDir ? createDirObj(common) : createFileObj(common);
    });
    return { content: this.sortItems(content), total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const clean = this.cleanPath(path);
    const node = await this.resolvePath(clean);
    if (!node) {
      throw new Error(`Path not found: ${clean}`);
    }
    return this.nodeToObj(node);
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const clean = this.cleanPath(path);
    const node = await this.resolvePath(clean);
    if (!node || node.isDir || node.kind !== 'file') {
      throw new Error(`Cannot get link for non-file: ${clean}`);
    }

    const url = await this.client.getDownloadUrl(node.groupId, node.fileId);
    return {
      url,
      header: {
        'User-Agent': this.client.getUA(),
        Referer: this.client.driveHost(),
      },
    };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const clean = this.cleanPath(path);
    const parentPath = clean.substring(0, clean.lastIndexOf('/')) || '/';
    const dirName = clean.substring(clean.lastIndexOf('/') + 1);

    const parentNode = await this.resolvePath(parentPath);
    if (!parentNode || !parentNode.isDir || parentNode.kind === 'root') {
      throw new Error(
        'Cannot create folder directly in root (groups are read-only)',
      );
    }

    await this.client.createFolder(
      parentNode.groupId,
      parentNode.fileId,
      dirName,
    );
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const srcNode = await this.resolvePath(this.cleanPath(path));
    if (!srcNode) {
      throw new Error('Source node not found');
    }

    await this.client.rename(srcNode.groupId, srcNode.fileId, newName);
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const dstNode = await this.resolvePath(this.dstDirOf(dst));
    if (!dstNode || !dstNode.isDir || dstNode.kind === 'root') {
      throw new Error('Target destination directory not found');
    }

    const srcNode = await this.resolvePath(this.cleanPath(src));
    if (srcNode) {
      await this.client.move(
        srcNode.groupId,
        srcNode.fileId,
        dstNode.groupId,
        dstNode.fileId,
      );
    }
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const dstNode = await this.resolvePath(this.dstDirOf(dst));
    if (!dstNode || !dstNode.isDir || dstNode.kind === 'root') {
      throw new Error('Target destination directory not found');
    }

    const srcNode = await this.resolvePath(this.cleanPath(src));
    if (srcNode) {
      await this.client.copy(
        srcNode.groupId,
        srcNode.fileId,
        dstNode.groupId,
        dstNode.fileId,
      );
    }
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const node = await this.resolvePath(this.cleanPath(path));
    if (node && node.kind !== 'root' && node.kind !== 'group') {
      await this.client.delete(node.groupId, node.fileId);
    }
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    // WPS direct upload requires chunked upload protocol (not ported).
    throw new Error('WPS: direct upload not supported (chunked upload not ported)');
  }
}

registerDriver(WpsDriver, wpsConfig, wpsAdditional);
