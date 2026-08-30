/**
 * 蓝奏云 / 蓝奏云分享 Driver
 * Referenced from OpenList's official drivers/lanzou:
 * - `account` / `cookie` type: personal drive (login or cookie), browse via
 *   doupload.php, download by generating a share link then parsing it
 * - `url` type: share link browsing / downloading
 * - Handles the acw_sc__v2 anti-bot cookie and share-page JS parsing
 * Write operations (mkdir/rename/move/remove/upload) are not ported.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const lanzouConfig: DriverConfig = {
  name: 'Lanzou',
  label: '蓝奏云',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: true,
  default_root: '-1',
};

export const lanzouAdditional: DriverItem[] = [
  { name: 'type', type: 'select', default: 'cookie', options: 'account,cookie,url', required: false, help: 'Type: account / cookie / url (share)' },
  { name: 'account', type: 'string', default: '', options: '', required: false, help: 'Account (for type=account)' },
  { name: 'password', type: 'string', default: '', options: '', required: false, help: 'Password' },
  { name: 'cookie', type: 'string', default: '', options: '', required: false, help: 'Cookie (about 15 days valid, ignore if shareUrl is used)' },
  { name: 'root_folder_id', type: 'string', default: '-1', options: '', required: false, help: 'Root folder id (or share id for type=url)' },
  { name: 'share_password', type: 'string', default: '', options: '', required: false, help: 'Share password (type=url)' },
  { name: 'baseUrl', type: 'string', default: 'https://pc.woozooo.com', options: '', required: true, help: 'Basic URL for file operation' },
  { name: 'shareUrl', type: 'string', default: 'https://pan.lanzoui.com', options: '', required: true, help: 'URL used to get the sharing page' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// acw_sc__v2 anti-bot cookie
// ---------------------------------------------------------------------------
const ACW_MASK = '3000176000856006061501533003690027800375';
const ACW_BOX = [6, 28, 34, 31, 33, 18, 30, 23, 9, 8, 19, 38, 17, 24, 0, 5, 32, 21, 10, 22, 25, 14, 15, 3, 16, 27, 13, 35, 2, 29, 11, 26, 4, 36, 1, 39, 37, 7, 20, 12];

function unbox(hex: string): string {
  const out = new Array(hex.length).fill('0');
  for (let i = 0; i < ACW_BOX.length; i++) {
    const j = ACW_BOX[i];
    if (j < hex.length) out[j] = hex[i];
  }
  return out.join('');
}

function hexXor(a: string, b: string): string {
  const bytes1: number[] = [];
  const bytes2: number[] = [];
  for (let i = 0; i < a.length; i += 2) bytes1.push(parseInt(a.slice(i, i + 2), 16));
  for (let i = 0; i < b.length; i += 2) bytes2.push(parseInt(b.slice(i, i + 2), 16));
  const min = Math.min(bytes1.length, bytes2.length);
  const out: number[] = [];
  for (let i = 0; i < min; i++) out.push(bytes1[i] ^ bytes2[i]);
  return out.map(x => x.toString(16).padStart(2, '0')).join('');
}

function calcAcwScV2(html: string): string {
  const m = html.match(/arg1='([0-9A-Z]+)'/);
  if (!m) throw new Error('lanzou: cannot match arg1');
  return hexXor(unbox(m[1]), ACW_MASK);
}

// ---------------------------------------------------------------------------
// HTML / JS parsing helpers
// ---------------------------------------------------------------------------
function removeNotes(html: string): string {
  return html.replace(/<!--.*?-->|[^:]\/\/.*|\/\*.*?\*\//g, b => {
    if (b.slice(1, 3) === '//') return b.slice(0, 1);
    return '\n';
  });
}

function removeJSComment(data: string): string {
  let out = '';
  let inBlock = false;
  let inLine = false;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (inLine) {
      if (v === '\n' || v === '\r') { inLine = false; out += v; }
      continue;
    }
    if (inBlock) {
      if (v === '*' && data[i + 1] === '/') { inBlock = false; i++; }
      continue;
    }
    if (v === '/' && i + 1 < data.length) {
      const n = data[i + 1];
      if (n === '*') { inBlock = true; i++; continue; }
      if (n === '/') { inLine = true; i++; continue; }
    }
    out += v;
  }
  return out;
}

interface FuncIndex { start: number; end: number }

function findJSFunctionIndex(data: string, all: boolean): FuncIndex[] {
  const re = all ? /function[^{]+/g : /^function[^{]+/gm;
  const indexes: FuncIndex[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(data)) !== null) {
    let count = 0;
    const start = m.index;
    for (let i = m.index + m[0].length; i < data.length; i++) {
      const v = data[i];
      if (v === ' ' && count === 0) continue;
      if (v === '{') count++;
      if (v === '}') count--;
      if (count === 0) {
        indexes.push({ start, end: i + 1 });
        break;
      }
    }
  }
  return indexes;
}

function getJSFunctionByName(html: string, name: string): string {
  const indexes = findJSFunctionIndex(html, true);
  const re = new RegExp(`function\\s+${name}[()\\s]+{`);
  for (const idx of indexes) {
    const data = html.slice(idx.start, idx.end);
    if (re.test(data)) return data;
  }
  throw new Error(`lanzou: not find ${name} function`);
}

function findJSVarFunc(key: string, data: string): string {
  const re = new RegExp(`var\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*['\"]?([^'\"]*)['\"]?\\s*;`, 'g');
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(data)) !== null) matches.push(m);
  if (matches.length === 0) return '';
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i][1] !== '') return matches[i][1];
  }
  return matches[matches.length - 1][1];
}

function jsonToMap(data: string, html: string): Record<string, string> {
  const param: Record<string, string> = {};
  const re = /'(.+?)':('?([^' },]*)'?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data)) !== null) {
    const k = m[1];
    const v = m[3];
    if (v === '' || m[2].includes("'") || /^\d+$/.test(m[2])) {
      param[k] = v;
    } else {
      param[k] = findJSVarFunc(v, html);
    }
  }
  return param;
}

function htmlJsonToMap(html: string): Record<string, string> {
  const m = html.match(/data[:\s]+({[^}]+})/);
  if (!m) throw new Error('lanzou: not find data');
  return jsonToMap(m[1], html);
}

function getExpirationTime(url: string): number {
  const m = url.match(/e=(\d+)/);
  if (!m) return 0;
  return Number(m[1]);
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------
interface FileOrFolder {
  id: string;
  name_all: string;
  size: string;
  time: string;
  isFolder: boolean;
}

interface ShareFile {
  id: string;      // share id (url mode) or file id
  name_all: string;
  size: string;
  time: string;
  pwd: string;
  isFolder: boolean;
  url?: string;
}

interface FileShareInfo {
  f_id?: string;
  pwd: string;
  new_url?: string;
}

interface AjaxResp {
  dom?: string;
  url?: string;
  inf?: string;
}

/**
 * 蓝奏云 Driver Implementation
 */
export class LanZouDriver implements Driver {
  private cookie = '';
  private uid = '';
  private vei = '';
  private acwVs = '';
  private cfg: Record<string, any> = {};

  config(): DriverConfig {
    return lanzouConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    if (cfg.type === 'account') {
      await this.login();
    }
    this.cookie = cfg.cookie || this.cookie;
    if (cfg.type === 'account' || cfg.type === 'cookie') {
      const r = await this.getVeiAndUid();
      this.vei = r.vei;
      this.uid = r.uid;
    }
  }

  private isAccount(): boolean { return this.cfg.type === 'account'; }
  private isCookie(): boolean { return this.cfg.type === 'cookie'; }
  private isUrl(): boolean { return this.cfg.type === 'url'; }

  private baseUrl(): string { return this.cfg.baseUrl || 'https://pc.woozooo.com'; }
  private shareUrl(): string { return this.cfg.shareUrl || 'https://pan.lanzoui.com'; }
  private ua(): string { return this.cfg.user_agent || UA; }

  // Core request with acw_sc__v2 auto-handling.
  private async request(url: string, method: string, form?: Record<string, string>): Promise<string> {
    for (let retry = 0; retry < 3; retry++) {
      let cookie = this.cookie;
      if (url.includes('/file/')) cookie = (cookie ? cookie + '; ' : '') + 'down_ip=1';
      if (this.acwVs) cookie += (cookie ? '; ' : '') + 'acw_sc__v2=' + this.acwVs;
      const headers: Record<string, string> = {
        'Referer': 'https://pc.woozooo.com',
        'User-Agent': this.ua(),
      };
      if (cookie) headers['Cookie'] = cookie;
      const init: RequestInit = { method, headers };
      if (form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        init.body = new URLSearchParams(form).toString();
      }
      const resp = await fetch(url, init);
      const text = await resp.text();
      if (text.includes('acw_sc__v2')) {
        this.acwVs = calcAcwScV2(text);
        continue;
      }
      return text;
    }
    throw new Error('lanzou: acw_sc__v2 validation error');
  }

  private async httpGet(url: string): Promise<string> {
    return this.request(url, 'GET');
  }

  private async post(url: string, form: Record<string, string>): Promise<string> {
    return this.request(url, 'POST', form);
  }

  private async login(): Promise<void> {
    const form: Record<string, string> = {
      task: '3',
      uid: this.cfg.account || '',
      pwd: this.cfg.password || '',
      setSessionId: '',
      setSig: '',
      setScene: '',
      setTocen: '',
      formhash: '',
    };
    const resp = await this.post('https://up.woozooo.com/mlogin.php', form);
    const data: any = JSON.parse(resp);
    if (data.zt !== 1) {
      throw new Error(`lanzou: login err: ${resp.slice(0, 200)}`);
    }
    // Login sets cookies via Set-Cookie; fetch in Node keeps them per-call only,
    // so re-request mlogin with the cookie jar is handled by the caller storing
    // the returned cookie — here we approximate by keeping the acw cookie.
  }

  private async getVeiAndUid(): Promise<{ vei: string; uid: string }> {
    const text = await this.httpGet(`${this.baseUrl()}/mydisk.php?item=files&action=index`);
    const uids = text.match(/uid=([^'"&;]+)/);
    if (!uids) throw new Error('lanzou: uid variable not find');
    const uid = uids[1];
    const html = removeNotes(text);
    let vei = '';
    try {
      vei = htmlJsonToMap(html).vei || '';
    } catch {
      vei = '';
    }
    return { vei, uid };
  }

  // POST to doupload.php with uid/vei (account / cookie mode).
  private async doupload(form: Record<string, string>): Promise<any> {
    const q = new URLSearchParams({ uid: this.uid, vei: this.vei }).toString();
    const text = await this.post(`${this.baseUrl()}/doupload.php?${q}`, form);
    const data = JSON.parse(text);
    if (data.zt === 1 || data.zt === 2 || data.zt === 4) return data;
    if (data.zt === 9) {
      if (this.isAccount()) {
        await this.login();
        const text2 = await this.post(`${this.baseUrl()}/doupload.php?${q}`, form);
        const data2 = JSON.parse(text2);
        if (data2.zt === 1 || data2.zt === 2 || data2.zt === 4) return data2;
      }
      throw new Error('lanzou: cookie expired');
    }
    throw new Error(data.inf || data.info || `lanzou: zt=${data.zt}`);
  }

  // ---------------- account / cookie mode ----------------
  private async getFolders(folderId: string): Promise<FileOrFolder[]> {
    const data = await this.doupload({ task: '47', folder_id: folderId });
    return (data.text || []).map((f: any) => ({
      id: String(f.fol_id || f.id),
      name_all: f.name_all || f.name || '',
      size: '',
      time: '',
      isFolder: true,
    }));
  }

  private async getFiles(folderId: string): Promise<FileOrFolder[]> {
    const files: FileOrFolder[] = [];
    for (let pg = 1; ; pg++) {
      const data = await this.doupload({ task: '5', folder_id: folderId, pg: String(pg) });
      const list = data.text || [];
      for (const f of list) {
        files.push({ id: String(f.id), name_all: f.name_all || f.name || '', size: f.size || '', time: f.time || '', isFolder: false });
      }
      if (list.length === 0) break;
    }
    return files;
  }

  private async getAllFiles(folderId: string): Promise<FileOrFolder[]> {
    const folders = await this.getFolders(folderId);
    const files = await this.getFiles(folderId);
    return [...folders, ...files];
  }

  private async getFileShareUrlByID(fileId: string): Promise<FileShareInfo> {
    const data = await this.doupload({ task: '22', file_id: fileId });
    const info = data.info || {};
    return { f_id: info.f_id, pwd: info.pwd || '', new_url: info.new_url };
  }

  // Resolve a path to a folder id in account/cookie mode.
  private async resolveFolderIdByPath(path: string): Promise<string> {
    const root = this.cfg.root_folder_id || '-1';
    const parts = path.split('/').filter(p => p);
    let currentId = root;
    for (const part of parts) {
      const folders = await this.getFolders(currentId);
      const found = folders.find(f => f.name_all === part);
      if (!found) throw new Error(`lanzou: path not found: ${path}`);
      currentId = found.id;
    }
    return currentId;
  }

  // ---------------- share (url) mode ----------------
  private async getShareUrlHtml(shareId: string): Promise<string> {
    for (let i = 0; i < 3; i++) {
      let text = await this.httpGet(`${this.shareUrl()}/${shareId}`);
      if (text.includes('acw_sc__v2')) {
        this.acwVs = calcAcwScV2(text);
        text = await this.httpGet(`${this.shareUrl()}/${shareId}`);
      }
      text = removeNotes(text);
      if (text.includes('取消分享')) throw new Error('lanzou: share cancelled');
      if (text.includes('文件不存在')) throw new Error('lanzou: file not exist');
      return text;
    }
    throw new Error('lanzou: acw_sc__v2 validation error');
  }

  // Parse the share page and return the direct download URL.
  private async getFilesByShareUrl(shareId: string, pwd: string, pageData?: string): Promise<ShareFile> {
    if (!pageData) pageData = await this.getShareUrlHtml(shareId);
    let html = removeJSComment(pageData);
    const file: ShareFile = { id: shareId, name_all: '', size: '', time: '', pwd, isFolder: false };
    let baseUrl = '';
    let downloadUrl = '';

    if (html.includes('pwdload') || html.includes('passwddiv')) {
      const downP = getJSFunctionByName(html, 'down_p');
      const param = htmlJsonToMap(downP);
      param.p = pwd;
      const m = html.match(/'\/ajax(?:file|m)\.php\?file=(\d+)'/);
      if (!m) throw new Error('lanzou: not find file id');
      const ajaxUrl = this.shareUrl() + m[0].slice(1, -1);
      const resp = await this.post(ajaxUrl, param) as unknown as string;
      const data = JSON.parse(resp) as AjaxResp;
      file.name_all = data.inf || '';
      baseUrl = `${data.dom}/file`;
      downloadUrl = `${baseUrl}/${data.url}`;
    } else {
      const urlpaths = html.match(/<iframe.*?src="(.+?)"/);
      if (!urlpaths) throw new Error('lanzou: not find file page param');
      let next = await this.httpGet(this.shareUrl() + urlpaths[1]);
      next = removeNotes(next);
      const param = htmlJsonToMap(next);
      const m = next.match(/'\/ajax(?:file|m)\.php\?file=(\d+)'/);
      if (!m) throw new Error('lanzou: not find file id');
      const ajaxUrl = this.shareUrl() + m[0].slice(1, -1);
      const resp = await this.post(ajaxUrl, param) as unknown as string;
      const data = JSON.parse(resp) as AjaxResp;
      baseUrl = `${data.dom}/file`;
      downloadUrl = `${baseUrl}/${data.url}`;
      const names = html.match(/<title>(.+?) - 蓝奏云<\/title>|id="filenajax">(.+?)<\/div>|var filename = '(.+?)';|<div style="font-size.+?>([^<>].+?)<\/div>|<div class="filethetext".+?>([^<>]+?)<\/div>/);
      if (names) {
        for (let i = 1; i < names.length; i++) {
          if (names[i]) { file.name_all = names[i]; break; }
        }
      }
    }
    const sizes = pageData.match(/大小\W*([0-9.]+\s*[bkm]+)/i);
    if (sizes) file.size = sizes[1];
    const times = pageData.match(/\d+\s*[秒天分小][钟时]?前|[昨前]天|\d{4}-\d{2}-\d{2}/);
    if (times) file.time = times[0];

    // Follow the download URL redirect (manual) to the final CDN link.
    const head = await fetch(downloadUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': baseUrl,
        'Cookie': 'down_ip=1' + (this.acwVs ? '; acw_sc__v2=' + this.acwVs : ''),
        'User-Agent': this.ua(),
      },
    });
    if (head.status === 302 || head.status === 301) {
      file.url = head.headers.get('location') || downloadUrl;
    } else {
      file.url = downloadUrl;
    }
    return file;
  }

  private async getFolderByShareUrl(pwd: string, pageData: string): Promise<ShareFile[]> {
    const from = htmlJsonToMap(pageData);
    const files: ShareFile[] = [];
    // sub-folders
    const folderRe = /(?:folderlink|mbxfolder).+?href="\/(.+?)"(?:.+filename")?>(.+?)</gi;
    let fm: RegExpExecArray | null;
    while ((fm = folderRe.exec(pageData)) !== null) {
      if (fm.length >= 3) files.push({ id: fm[1], name_all: fm[2], size: '', time: '', pwd, isFolder: true });
    }
    // files (paginated)
    from.pwd = pwd;
    for (let page = 1; ; page++) {
      from.pg = String(page);
      const resp = await this.post(`${this.shareUrl()}/filemoreajax.php`, from) as unknown as string;
      const data = JSON.parse(resp);
      const list: any[] = data.text || [];
      if (list.length === 0) break;
      for (const f of list) {
        files.push({
          id: String(f.id),
          name_all: f.name_all || '',
          size: f.size || '',
          time: f.time || '',
          pwd,
          isFolder: false,
        });
      }
    }
    return files;
  }

  private async getShareList(shareId: string, pwd: string): Promise<ShareFile[]> {
    const pageData = await this.getShareUrlHtml(shareId);
    if (!/class="fileinfo"|id="file"|文件描述/.test(pageData)) {
      return this.getFolderByShareUrl(pwd, pageData);
    }
    const file = await this.getFilesByShareUrl(shareId, pwd, pageData);
    return [file];
  }

  // Resolve a path to a file id in share (url) mode.
  private async resolveShareIdByPath(path: string): Promise<string> {
    const root = this.cfg.root_folder_id || '';
    const parts = path.split('/').filter(p => p);
    let currentId = root;
    for (const part of parts) {
      const list = await this.getShareList(currentId, this.cfg.share_password || '');
      const found = list.find(f => f.name_all === part);
      if (!found) throw new Error(`lanzou: path not found: ${path}`);
      currentId = found.id;
    }
    return currentId;
  }

  // ---------------- Driver interface ----------------
  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    let content: Obj[];
    if (this.isUrl()) {
      const id = await this.resolveShareIdByPath(path);
      const list = await this.getShareList(id, this.cfg.share_password || '');
      content = list.map(f => {
        const common = { name: f.name_all, id: f.id, modified: new Date().toISOString() };
        return f.isFolder ? createDirObj(common) : createFileObj({ ...common, size: sizeStrToInt64(f.size) });
      });
    } else {
      const id = await this.resolveFolderIdByPath(path);
      const list = await this.getAllFiles(id);
      content = list.map(f => {
        const common = { name: f.name_all, id: f.id, modified: new Date().toISOString() };
        return f.isFolder ? createDirObj(common) : createFileObj({ ...common, size: sizeStrToInt64(f.size) });
      });
    }
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const name = path.split('/').pop() || path;
    return createFileObj({ name, modified: new Date().toISOString() });
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    let shareId = '';
    let pwd = this.cfg.share_password || '';
    if (this.isUrl()) {
      shareId = await this.resolveShareIdByPath(path);
    } else {
      // account/cookie: resolve the file id, generate a share link, then parse it.
      const parent = path.substring(0, path.lastIndexOf('/')) || '/';
      const name = path.split('/').pop() || '';
      const parentId = await this.resolveFolderIdByPath(parent);
      const files = await this.getAllFiles(parentId);
      const target = files.find(f => !f.isFolder && f.name_all === name);
      if (!target) throw new Error('lanzou: file not found');
      const share = await this.getFileShareUrlByID(target.id);
      if (!share.f_id) throw new Error('lanzou: failed to get share url');
      shareId = share.f_id;
      pwd = share.pwd || '';
    }
    const file = await this.getFilesByShareUrl(shareId, pwd);
    if (!file.url) throw new Error('lanzou: failed to get download url');
    return {
      url: file.url,
      header: { 'User-Agent': this.ua() },
    };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> { throw new Error('lanzou: mkdir not ported'); }
  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> { throw new Error('lanzou: rename not ported'); }
  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> { throw new Error('lanzou: copy not ported'); }
  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> { throw new Error('lanzou: move not ported'); }
  async remove(path: string, cfg: Record<string, any>): Promise<void> { throw new Error('lanzou: remove not ported'); }
  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> { throw new Error('lanzou: upload not ported'); }
}

// Parse a size string like "12.5 MB" / "345KB" into bytes.
function sizeStrToInt64(size: string): number {
  const m = size.match(/([0-9.]+)\s*([bkm]+)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch (m[2].toUpperCase()) {
    case 'B': return Math.round(n);
    case 'K': case 'KB': return Math.round(n * 1024);
    case 'M': case 'MB': return Math.round(n * 1024 * 1024);
    case 'G': case 'GB': return Math.round(n * 1024 * 1024 * 1024);
    default: return Math.round(n);
  }
}

registerDriver(LanZouDriver, lanzouConfig, lanzouAdditional);
