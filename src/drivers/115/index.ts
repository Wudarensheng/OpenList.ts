/**
 * 115 网盘开放平台 (115 Open) Driver — writable
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/115open (itself a TS re-port of OpenList drivers/115_open).
 *
 * Token-authenticated driver against https://proapi.115.com. When an API call
 * reports an expired token (code 401-prefixed or 99) the client refreshes in
 * place via passportapi.115.com/open/refreshToken and retries once (no DB
 * persistence). Upload uses OSS direct PUT (秒传 → 二次校验 → PUT Object),
 * with inline SHA-1/HMAC-SHA1 helpers (crypto.subtle, no external deps).
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const pan115OpenConfig: DriverConfig = {
  name: '115',
  label: '115 网盘',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '0',
};

export const pan115OpenAdditional: DriverItem[] = [
  { name: 'access_token', type: 'string', default: '', options: '', required: true, help: '访问令牌（115 开放平台 OAuth access_token）' },
  { name: 'refresh_token', type: 'string', default: '', options: '', required: true, help: '刷新令牌（115 开放平台 OAuth refresh_token）' },
  { name: 'root_id', type: 'string', default: '0', options: '', required: false, help: '根文件夹 ID，默认 "0"（网盘根目录）' },
  { name: 'order_by', type: 'select', default: 'file_name', options: 'file_name,file_size,user_utime,file_type', required: false, help: '排序字段' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: '排序方向' },
  { name: 'limit_rate', type: 'number', default: '0', options: '', required: false, help: '所有 API 请求限速 (N次/秒)，0 表示不限' },
  { name: 'page_size', type: 'number', default: '200', options: '', required: false, help: '列表分页大小（1~1150，默认 200）' },
];

/** OpenList Go base.UserAgent（与 Go 驱动一致，115 防盗链校验通过率高） */
const OPENLIST_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30';

const API_BASE = 'https://proapi.115.com';
const API_AUTH = 'https://passportapi.115.com';

const ApiFsUploadGetToken = API_BASE + '/open/upload/get_token';
const ApiFsUploadInit = API_BASE + '/open/upload/init';
const ApiFsMkdir = API_BASE + '/open/folder/add';
const ApiFsGetFiles = API_BASE + '/open/ufile/files';
const ApiFsGetFolderInfo = API_BASE + '/open/folder/get_info';
const ApiFsCopy = API_BASE + '/open/ufile/copy';
const ApiFsMove = API_BASE + '/open/ufile/move';
const ApiFsDownURL = API_BASE + '/open/ufile/downurl';
const ApiFsUpdate = API_BASE + '/open/ufile/update';
const ApiFsDelete = API_BASE + '/open/ufile/delete';
const ApiUserInfo = API_BASE + '/open/user/info';
const ApiRefreshToken = API_AUTH + '/open/refreshToken';

const ERR_OBJECT_NOT_FOUND = 430004;

interface Pan115File {
  fid: string; // 文件ID
  pid?: string; // 父文件夹ID
  fc: string; // 文件分类 0 文件夹 1 文件
  fn: string; // 文件名
  fco?: string; // 文件夹封面
  pc?: string; // 文件提取码
  upt?: number; // 修改时间
  uppt?: number; // 上传时间
  sha1?: string; // 文件sha1
  fs?: number; // 文件大小
  thumbnail?: string; // 缩略图
}

interface Pan115GetFilesResp {
  data: Pan115File[];
  count: number;
}

interface Pan115FolderInfoResp {
  file_id: string;
  file_name: string;
  paths?: Array<{ file_id: string; file_name: string }>;
}

interface Pan115DownUrlEntry {
  url?: { url: string };
}
type Pan115DownUrlResp = Record<string, Pan115DownUrlEntry>;

interface Pan115UploadInitResp {
  pick_code: string;
  status: number;
  sign_key?: string;
  sign_check?: string;
  bucket?: string;
  object?: string;
  callback?: { callback: string; callback_var: string };
}

interface Pan115UploadTokenResp {
  endpoint: string;
  AccessKeyId: string;
  AccessKeySecret: string;
  SecurityToken: string;
}

// ---------------------------------------------------------------- helpers

function hexEncode(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha1(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', data as BufferSource);
  return hexEncode(buf);
}

async function hmacSha1Base64(data: string, key: string): Promise<string> {
  const keyMat = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key) as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', keyMat, new TextEncoder().encode(data) as BufferSource);
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64FromUtf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function normalizeAddition(a: any): Record<string, any> {
  const norm = { ...(a || {}) } as any;
  norm.order_by = norm.order_by || 'file_name';
  norm.order_direction = norm.order_direction || 'asc';
  norm.page_size = norm.page_size || 200;
  // 兼容 OpenList Go 原版字段名（root_folder_id → root_id）
  if ((norm.root_folder_id || norm.root_folder_id === '0') && !norm.root_id) {
    norm.root_id = String(norm.root_folder_id);
  }
  return norm;
}

function sortItems(items: Obj[], orderBy?: string, orderDirection?: string): Obj[] {
  const asc = orderDirection !== 'desc';
  const key = String(orderBy || 'file_name').toLowerCase();
  const sorted = [...items];
  sorted.sort((a, b) => {
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
  return sorted;
}

function fileToObj(f: Pan115File): Obj {
  const isDir = f.fc === '0';
  const common = {
    name: f.fn,
    size: isDir ? 0 : f.fs || 0,
    modified: f.upt ? new Date(f.upt * 1000).toISOString() : new Date().toISOString(),
    created: f.uppt ? new Date(f.uppt * 1000).toISOString() : undefined,
    thumb: f.thumbnail || f.fco || undefined,
    id: f.fid,
  };
  return isDir ? createDirObj(common) : createFileObj(common);
}

// ---------------------------------------------------------------- client

class Pan115Client {
  private addition: Record<string, any>;
  public accessToken = '';
  public refreshTokenValue = '';
  private rateLimitMs = 0;
  private lastRequestAt = 0;

  constructor(addition: Record<string, any>) {
    this.addition = addition;
    this.accessToken = addition.access_token || '';
    this.refreshTokenValue = addition.refresh_token || '';
    const rate = addition.limit_rate || 0;
    if (rate > 0) this.rateLimitMs = 1000 / rate;
  }

  private async waitRateLimit(): Promise<void> {
    if (this.rateLimitMs <= 0) return;
    const now = Date.now();
    const wait = this.lastRequestAt + this.rateLimitMs - now;
    if (wait > 0) {
      await new Promise(r => setTimeout(r, wait));
    }
    this.lastRequestAt = Date.now();
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
          return await fetch(url, { ...init, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        lastErr = e;
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }

  private static isAuthError(code: number): boolean {
    return code === 99 || String(code).startsWith('401');
  }

  public async refreshToken(): Promise<void> {
    if (!this.refreshTokenValue) {
      throw new Error('115 网盘缺少 refresh_token（必填）');
    }
    const form = new URLSearchParams();
    form.set('refresh_token', this.refreshTokenValue);
    const res = await this.fetchWithRetry(ApiRefreshToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = (await res.json()) as any;
    if (
      data.code !== 0 ||
      !data.data?.access_token ||
      !data.data?.refresh_token
    ) {
      throw new Error(
        `115 网盘 token 刷新失败（code ${data.code} ${data.message}）：请确认 refresh_token 有效。`,
      );
    }
    this.accessToken = data.data.access_token;
    this.refreshTokenValue = data.data.refresh_token;
    this.addition.access_token = this.accessToken;
    this.addition.refresh_token = this.refreshTokenValue;
  }

  public async request(
    url: string,
    method: 'GET' | 'POST',
    query?: Record<string, string>,
    form?: Record<string, string>,
    ua?: string,
    skipAuthRetry = false,
  ): Promise<any> {
    await this.waitRateLimit();

    const doReq = async (): Promise<any> => {
      const u = new URL(url);
      for (const [k, v] of Object.entries(query || {})) {
        if (v !== '') u.searchParams.set(k, v);
      }
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent':
          ua ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/142.0.0.0 OpenList/425.6.30',
      };
      if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;
      const init: RequestInit = { method, headers };
      if (form && method === 'POST') {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(form)) {
          if (v !== '') body.set(k, v);
        }
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = body.toString();
      }
      const res = await this.fetchWithRetry(u.toString(), init);
      const rawText = await res.text();
      let body: any;
      try {
        body = JSON.parse(rawText);
      } catch {
        body = { state: false, code: res.status, message: rawText.slice(0, 200) };
      }
      return body;
    };

    let body: any;
    try {
      body = await doReq();
    } catch (e: any) {
      const causeCode = e?.cause?.code || e?.cause?.cause?.code;
      const causeMsg = e?.cause?.message || e?.cause?.cause?.message;
      if (causeCode) throw new Error(`${e?.message || 'fetch failed'}（${causeCode}）`);
      if (causeMsg) throw new Error(`${e?.message || 'fetch failed'}（${causeMsg}）`);
      throw new Error(e?.message || String(e));
    }

    const state = body?.state;
    if (state === false || state === undefined) {
      const code = Number(body?.code ?? 0);
      if (Pan115Client.isAuthError(code) && !skipAuthRetry) {
        await this.refreshToken();
        body = await doReq();
        const retryState = body?.state;
        if (retryState !== false && retryState !== undefined) {
          return body;
        }
        throw new Error(`115 网盘 API 错误（code ${body?.code} ${body?.message}）`);
      }
      if (code === ERR_OBJECT_NOT_FOUND) {
        const err: any = new Error('115 object not found');
        err.code = ERR_OBJECT_NOT_FOUND;
        throw err;
      }
      throw new Error(`115 网盘 API 错误（code ${code} ${body?.message || ''}）`);
    }
    return body;
  }

  public async userInfo(): Promise<any> {
    return (await this.request(ApiUserInfo, 'GET'))?.data;
  }

  public async getFiles(opts: {
    cid: string;
    limit: number;
    offset: number;
    asc: boolean;
    o?: string;
    showDir?: boolean;
  }): Promise<{ files: Pan115File[]; count: number }> {
    const resp = (await this.request(ApiFsGetFiles, 'GET', {
      cid: opts.cid,
      limit: String(opts.limit),
      offset: String(opts.offset),
      asc: opts.asc ? '1' : '0',
      o: opts.o || '',
      show_dir: opts.showDir ? '1' : '0',
      cur: '1',
    })) as any;
    return { files: resp.data || [], count: resp.count || 0 };
  }

  public async getFolderInfo(fileId: string): Promise<Pan115FolderInfoResp> {
    return (
      await this.request(ApiFsGetFolderInfo, 'GET', { file_id: fileId })
    )?.data as Pan115FolderInfoResp;
  }

  public async getFolderInfoByPath(path: string): Promise<Pan115FolderInfoResp> {
    return (
      await this.request(ApiFsGetFolderInfo, 'POST', undefined, { path })
    )?.data as Pan115FolderInfoResp;
  }

  public async mkdir(pid: string, fileName: string): Promise<void> {
    await this.request(ApiFsMkdir, 'POST', undefined, {
      pid,
      file_name: fileName,
    });
  }

  public async move(fileIds: string, toCid: string): Promise<void> {
    await this.request(ApiFsMove, 'POST', undefined, {
      file_ids: fileIds,
      to_cid: toCid,
    });
  }

  public async updateFile(fileId: string, fileName: string): Promise<void> {
    await this.request(ApiFsUpdate, 'POST', undefined, {
      file_id: fileId,
      file_name: fileName,
    });
  }

  public async copy(pid: string, fileId: string): Promise<void> {
    await this.request(ApiFsCopy, 'POST', undefined, {
      pid,
      file_id: fileId,
      no_dupli: '1',
    });
  }

  public async delFile(fileIds: string, parentId: string): Promise<void> {
    await this.request(ApiFsDelete, 'POST', undefined, {
      file_ids: fileIds,
      parent_id: parentId,
    });
  }

  public async downUrl(pickCode: string, ua: string): Promise<Pan115DownUrlResp> {
    return (
      await this.request(ApiFsDownURL, 'POST', undefined, { pick_code: pickCode }, ua)
    )?.data as Pan115DownUrlResp;
  }

  public async uploadGetToken(): Promise<Pan115UploadTokenResp> {
    return (await this.request(ApiFsUploadGetToken, 'GET'))?.data as Pan115UploadTokenResp;
  }

  public async uploadInit(opts: {
    fileName: string;
    fileSize: number;
    target: string;
    fileId: string; // sha1 大写
    preId: string; // 前128k sha1 大写
    signKey?: string;
    signVal?: string;
  }): Promise<Pan115UploadInitResp> {
    return (
      await this.request(ApiFsUploadInit, 'POST', undefined, {
        file_name: opts.fileName,
        file_size: String(opts.fileSize),
        target: `U_1_${opts.target}`,
        fileid: opts.fileId,
        preid: opts.preId,
        sign_key: opts.signKey || '',
        sign_val: opts.signVal || '',
      })
    )?.data as Pan115UploadInitResp;
  }
}

// ---------------------------------------------------------------- driver

export class Pan115OpenDriver implements Driver {
  private cfg: Record<string, any> = {};
  private client: Pan115Client = new Pan115Client({});
  private pageSize = 200;
  private fidCache = new Map<string, string>();

  config(): DriverConfig {
    return pan115OpenConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = normalizeAddition(cfg);
    this.client = new Pan115Client(this.cfg);
    this.fidCache = new Map<string, string>();

    let ps = this.cfg.page_size || 200;
    if (ps <= 0) ps = 200;
    if (ps > 1150) ps = 1150;
    this.pageSize = ps;

    // 验证 token（失败即挂载失败，给出明确错误）
    try {
      await this.client.userInfo();
    } catch (e: any) {
      if (e?.code === ERR_OBJECT_NOT_FOUND) throw e;
      const msg = String(e?.message || e);
      if (
        msg.includes('fetch') ||
        msg.includes('ECONN') ||
        msg.includes('abort')
      ) {
        throw new Error(
          `115 网盘网络连接失败（${msg}）：proapi.115.com 可能无法从当前部署环境访问` +
            `（数据中心 IP 可能被 115 拦截），请稍后重试或更换部署环境。`,
        );
      }
      throw new Error(
        `115 网盘 token 验证失败：${msg}。请确认 access_token / refresh_token 有效。`,
      );
    }
  }

  private getRootId(): string {
    return (this.cfg.root_id || '0').trim() || '0';
  }

  private cleanPath(p: string): string {
    const s = '/' + (p || '').split('/').filter(Boolean).join('/');
    return s === '/' ? '/' : s;
  }

  private dirOf(p: string): string {
    const clean = this.cleanPath(p);
    const i = clean.lastIndexOf('/');
    return i <= 0 ? '/' : clean.substring(0, i);
  }

  private async resolveFolderId(physicalPath: string): Promise<string> {
    const rootId = this.getRootId();
    const clean = this.cleanPath(physicalPath);
    if (clean === '/' || clean === `/${rootId}`) return rootId;

    const cached = this.fidCache.get(clean);
    if (cached) return cached;

    // 用 GetFolderInfoByPath 一次性解析（Go Get 逻辑）
    const fullPath = `/${rootId === '0' ? '' : rootId}${clean === '/' ? '' : clean}`;
    try {
      const info = await this.client.getFolderInfoByPath(fullPath);
      if (info.file_id) {
        this.fidCache.set(clean, info.file_id);
        return info.file_id;
      }
    } catch (e: any) {
      // folder/get_info 只支持目录路径：参数错误(990002)/不存在(430004) → 回退逐层
      if (e?.code !== ERR_OBJECT_NOT_FOUND && e?.code !== 990002) throw e;
    }
    // 逐层解析
    const segs = clean.split('/').filter(Boolean);
    let cid = rootId;
    let prefix = '';
    for (const rawSeg of segs) {
      const decodedSeg = (() => {
        try {
          return decodeURIComponent(rawSeg);
        } catch {
          return rawSeg;
        }
      })();
      prefix = `${prefix}/${rawSeg}`;
      const cachedId = this.fidCache.get(prefix);
      if (cachedId) {
        cid = cachedId;
        continue;
      }
      const { files } = await this.client.getFiles({
        cid,
        limit: 1000,
        offset: 0,
        asc: true,
        o: 'file_name',
        showDir: true,
      });
      const folder = files.find(
        f => f.fc === '0' && (f.fn === rawSeg || f.fn === decodedSeg || f.fid === rawSeg),
      );
      if (!folder) throw new Error(`folder not found: ${rawSeg}`);
      cid = folder.fid;
      this.fidCache.set(prefix, cid);
    }
    return cid;
  }

  private async resolveFile(physicalPath: string): Promise<Pan115File> {
    const clean = this.cleanPath(physicalPath);
    const segs = clean.split('/').filter(Boolean);
    const rawName = segs.pop() || '';
    if (!rawName) throw new Error(`file not found: ${clean}`);
    const decodedName = (() => {
      try {
        return decodeURIComponent(rawName);
      } catch {
        return rawName;
      }
    })();
    const parentPath = '/' + segs.join('/');

    const parentId = await this.resolveFolderId(parentPath);
    let offset = 0;
    for (;;) {
      const { files, count } = await this.client.getFiles({
        cid: parentId,
        limit: Math.max(this.pageSize, 1000),
        offset,
        asc: true,
        o: 'file_name',
        showDir: true,
      });
      const hit = files.find(
        f => f.fn === rawName || f.fn === decodedName || f.fid === rawName || f.fid === decodedName,
      );
      if (hit) return hit;
      if (files.length === 0 || offset + files.length >= count) break;
      offset += files.length;
    }
    throw new Error(`file not found: ${rawName}`);
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const cid = await this.resolveFolderId(path);
    const items: Obj[] = [];
    let offset = 0;
    for (;;) {
      const { files, count } = await this.client.getFiles({
        cid,
        limit: this.pageSize,
        offset,
        asc: this.cfg.order_direction === 'asc',
        o: this.cfg.order_by || 'file_name',
        showDir: true,
      });
      for (const f of files) {
        items.push(fileToObj(f));
        this.fidCache.set(f.fid, f.fid);
      }
      if (items.length >= count || files.length === 0) break;
      offset += files.length;
    }
    const content = sortItems(items, this.cfg.order_by || 'file_name', this.cfg.order_direction);
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const clean = this.cleanPath(path);
    if (clean === '/' || clean === `/${this.getRootId()}`) {
      return createDirObj({
        name: this.getRootId(),
        modified: new Date().toISOString(),
        id: this.getRootId(),
      });
    }
    const file = await this.resolveFile(path);
    return fileToObj(file);
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const file = await this.resolveFile(path);
    if (file.fc === '0' || !file.pc) {
      throw new Error(`Cannot get link for: ${this.cleanPath(path)}`);
    }
    const resp = await this.client.downUrl(file.pc, OPENLIST_UA);
    const entry = resp[file.fid];
    const url = entry?.url?.url;
    if (!url) {
      throw new Error(`115: failed to obtain download URL for ${file.fn}`);
    }
    return { url, header: { 'User-Agent': OPENLIST_UA } };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const segs = String(path || '').split('/').filter(Boolean);
    const dirName = segs.pop() || '新文件夹';
    const parentPath = '/' + segs.join('/');
    const parentId = await this.resolveFolderId(parentPath);
    await this.client.mkdir(parentId, dirName);
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const file = await this.resolveFile(path);
    await this.client.updateFile(file.fid, newName);
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const file = await this.resolveFile(path);
    await this.client.delFile(file.fid, file.pid || this.getRootId());
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const file = await this.resolveFile(src);
    const dstId = await this.resolveFolderId(this.dirOf(dst));
    await this.client.move(file.fid, dstId);
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const file = await this.resolveFile(src);
    const dstId = await this.resolveFolderId(this.dirOf(dst));
    await this.client.copy(dstId, file.fid);
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const content = new Uint8Array(file);
    if (content.length < 1) {
      throw new Error('115 网盘不允许上传空文件');
    }
    const segs = String(path || '').split('/').filter(Boolean);
    const fileName = segs.pop() || 'file';
    const parentPath = '/' + segs.join('/');
    const parentId = await this.resolveFolderId(parentPath);

    const fileSize = content.length;
    const sha1Full = (await sha1(content)).toUpperCase();
    const preSize = Math.min(128 * 1024, fileSize);
    const sha1128k = (await sha1(content.subarray(0, preSize))).toUpperCase();

    // 1. UploadInit（秒传）
    let initResp = await this.client.uploadInit({
      fileName,
      fileSize,
      target: parentId,
      fileId: sha1Full,
      preId: sha1128k,
    });
    if (initResp.status === 2) return; // 秒传成功

    // 2. 二次校验（status 6/7/8）
    if ([6, 7, 8].includes(initResp.status) && initResp.sign_check) {
      const parts = initResp.sign_check.split('-');
      const start = parseInt(parts[0], 10);
      const end = parseInt(parts[1], 10);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const signVal = (await sha1(content.subarray(start, end + 1))).toUpperCase();
        initResp = await this.client.uploadInit({
          fileName,
          fileSize,
          target: parentId,
          fileId: sha1Full,
          preId: sha1128k,
          signKey: initResp.sign_key,
          signVal,
        });
        if (initResp.status === 2) return; // 校验后秒传成功
      }
    }

    // 3. 获取 OSS 上传凭证
    const token = await this.client.uploadGetToken();
    if (!initResp.bucket || !initResp.object || !token.endpoint) {
      throw new Error('115 上传初始化失败：缺少 OSS 上传信息');
    }

    // 4. OSS PUT Object（单请求上传，含 V1 签名）
    await this.ossPutObject(token, initResp, content);
  }

  private async ossPutObject(
    token: Pan115UploadTokenResp,
    initResp: { bucket?: string; object?: string; callback?: { callback: string; callback_var: string } },
    content: Uint8Array,
  ): Promise<void> {
    const bucket = initResp.bucket;
    const object = initResp.object;
    if (!bucket || !object) {
      throw new Error('115 上传初始化失败：缺少 OSS 上传信息');
    }
    const endpoint = token.endpoint.startsWith('http')
      ? token.endpoint
      : `https://${token.endpoint}`;
    const url = `${endpoint.replace(/\/$/, '')}/${object}`;
    const cb = base64FromUtf8(initResp.callback?.callback || '');
    const cbv = base64FromUtf8(initResp.callback?.callback_var || '');

    const date = new Date().toUTCString();
    const contentType = 'application/octet-stream';
    const ossHeaders = `x-oss-callback:${cb}\nx-oss-callback-var:${cbv}\nx-oss-security-token:${token.SecurityToken}\n`;
    const canonicalResource = `/${bucket}/${object}`;
    const stringToSign = `PUT\n\n${contentType}\n${date}\n${ossHeaders}${canonicalResource}`;
    const signature = await hmacSha1Base64(stringToSign, token.AccessKeySecret);

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        Date: date,
        Authorization: `OSS ${token.AccessKeyId}:${signature}`,
        'x-oss-security-token': token.SecurityToken,
        'x-oss-callback': cb,
        'x-oss-callback-var': cbv,
        'Content-Length': String(content.length),
      },
      body: content as BodyInit,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`115 OSS 上传失败（HTTP ${res.status}）：${text}`);
    }
  }
}

registerDriver(Pan115OpenDriver, pan115OpenConfig, pan115OpenAdditional);
