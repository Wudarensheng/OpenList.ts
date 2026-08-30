/**
 * 蓝奏云 / 蓝奏云分享 Driver
 * Re-ported from OpenList official (OpenListTeam/Openlist) with robustness
 * fixes learned from the openlistnext implementation:
 * - Multi-domain failover: when a share CDN domain returns 403/405 (WAF
 *   blocking datacenter IPs like CF Workers), retry on other lanzou domains.
 * - probeShareDomain: each account's share page uses a different domain
 *   (e.g. xxx.lanzn.com); probe it from the page HTML instead of relying on
 *   the configured shareUrl.
 * - acw_sc__v2 anti-bot cookie cached per domain.
 * - Browser-like AJAX headers (X-Requested-With / Sec-Fetch-* / Origin) to
 *   avoid WAF rejection, and download-link resolution with retries + fallback.
 * - Write operations (mkdir / rename / move / remove) via doupload tasks.
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
  { name: 'root_folder_id', type: 'string', default: '-1', options: '', required: false, help: 'Root folder id (or share id / full share URL for type=url)' },
  { name: 'share_password', type: 'string', default: '', options: '', required: false, help: 'Share password (type=url)' },
  { name: 'baseUrl', type: 'string', default: 'https://pc.woozooo.com', options: '', required: true, help: 'Basic URL for file operation' },
  { name: 'shareUrl', type: 'string', default: 'https://pan.lanzoui.com', options: '', required: true, help: 'URL used to get the sharing page' },
  { name: 'user_agent', type: 'string', default: '', options: '', required: false, help: 'Custom User-Agent' },
  { name: 'repair_file_info', type: 'bool', default: 'false', options: '', required: false, help: 'Repair file size/time from download headers' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

// 分享 ID 全局可用，任一域名都能访问同一分享；数据中心 IP 被某域名 WAF
// 拦截时可切换其他域名重试。
const LANZOU_SHARE_DOMAINS = [
  'pan.lanzoui.com',
  'lanzoub.com',
  'lanzouo.com',
  'lanzouw.com',
  'lanzoux.com',
  'lanzouy.com',
  'lanzou.com',
];

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
  const b1: number[] = [];
  const b2: number[] = [];
  for (let i = 0; i < a.length; i += 2) b1.push(parseInt(a.slice(i, i + 2), 16));
  for (let i = 0; i < b.length; i += 2) b2.push(parseInt(b.slice(i, i + 2), 16));
  const n = Math.min(b1.length, b2.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(b1[i] ^ b2[i]);
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

function findJSFunctionIndex(data: string, all: boolean): Array<{ start: number; end: number }> {
  const re = all ? /function[^{]+/g : /^function[^{]+/gm;
  const indexes: Array<{ start: number; end: number }> = [];
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

function htmlJsonToMap(html: string, extraHtml?: string): Record<string, string> {
  const m = html.match(/data[:\s]+({[^}]+})/);
  if (!m) throw new Error('lanzou: not find data');
  return jsonToMap(m[1], extraHtml || html);
}

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

function mustParseTime(str: string): string {
  const s = (str || '').trim();
  if (!s) return new Date().toISOString();
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  // "x分钟前" / "x天前" / "昨天" / "前天" style
  const m = s.match(/([0-9.]+)\s*([秒分小钟天前昨])/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const now = Date.now();
    if (unit === '秒' || unit === '分') return new Date(now - n * 60000).toISOString();
    if (unit === '小') return new Date(now - n * 3600000).toISOString();
    if (unit === '天' || unit === '昨') return new Date(now - n * 86400000).toISOString();
  }
  return new Date().toISOString();
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

function targetUrlWithDomain(url: string, domain: string): string {
  try {
    const u = new URL(url);
    u.host = domain;
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------
interface LanzouItem {
  id?: string;
  fol_id?: string;
  name?: string;
  name_all?: string;
  size?: string;
  time?: string;
  is_folder?: boolean;
  pwd?: string;
  url?: string;
}

interface LanzouShareInfo {
  f_id?: string;
  id?: string;
  pwd?: string;
  is_newd?: string;
}

interface LanzouShareResp {
  zt?: number;
  dom?: string;
  url?: string;
  inf?: string;
  info?: string;
  text?: string;
}

/**
 * 蓝奏云 Driver Implementation
 */
export class LanZouDriver implements Driver {
  private cfg: Record<string, any> = {};
  private cookie = '';
  private uid = '';
  private vei = '';
  private acwMap = new Map<string, string>();
  private workingShareHost = '';
  private pathIdCache = new Map<string, string>();

  config(): DriverConfig {
    return lanzouConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.cookie = (cfg.cookie || '').trim();
    const type = cfg.type || 'cookie';
    if (type === 'account') {
      await this.login();
      await this.initVeiAndUid();
    } else if (type === 'cookie' && this.cookie) {
      await this.initVeiAndUid();
    }
    // Warm up acw_sc__v2 for the share host (datacenter IPs need it).
    if (!this.acwMap.has(this.shareHost())) {
      try {
        await this.request(`${this.getShareUrl()}/`, 'GET');
      } catch {
        // ignore
      }
    }
  }

  private isUrlMode(): boolean { return (this.cfg.type || 'cookie') === 'url'; }

  // Accept a full share URL as root_folder_id, or embedded in shareUrl:
  //   - root_folder_id = "https://pan.lanzoui.com/xxx"  -> origin = share base, "xxx" = root id
  //   - shareUrl = "https://pan.lanzoui.com/xxx" (root empty) -> same extraction
  private getRootId(): string {
    const root = String(this.cfg.root_folder_id || '').trim();
    if (root.includes('://')) {
      try {
        const u = new URL(root);
        (this.cfg as any)._shareBase = u.origin;
        return u.pathname.replace(/^\/+|\/+$/g, '');
      } catch {
        return root;
      }
    }
    // shareUrl may itself be a full share URL (host + share id path).
    const su = String(this.cfg.shareUrl || '');
    if (su.includes('://') && !root) {
      try {
        const u = new URL(su);
        if (u.pathname && u.pathname !== '/') {
          (this.cfg as any)._shareBase = u.origin;
          return u.pathname.replace(/^\/+|\/+$/g, '');
        }
      } catch {
        // keep as-is
      }
    }
    return root || (this.isUrlMode() ? '' : '-1');
  }

  private getBaseUrl(): string {
    return (this.cfg.baseUrl || 'https://pc.woozooo.com').replace(/\/+$/, '');
  }
  private getShareUrl(): string {
    return ((this.cfg as any)._shareBase || this.cfg.shareUrl || 'https://pan.lanzoui.com').replace(/\/+$/, '');
  }
  private shareHost(): string {
    try { return new URL(this.getShareUrl()).host; } catch { return 'pan.lanzoui.com'; }
  }
  private ua(): string { return this.cfg.user_agent || UA; }
  private sharePassword(): string { return this.cfg.share_password || ''; }

  private updateCookie(setCookie: string | null, host?: string): void {
    if (!setCookie) return;
    const acwMatch = setCookie.match(/(?:^|,\s*)acw_sc__v2=([^;,\s]+)/i);
    if (acwMatch && acwMatch[1]) {
      this.acwMap.set(host || this.shareHost(), acwMatch[1]);
    }
    const parts = this.cookie ? this.cookie.split(';').map(s => s.trim()) : [];
    const entries = setCookie.split(/,(?=[a-zA-Z0-9_\-]+=[^;]+)/);
    for (const entry of entries) {
      const main = entry.split(';')[0].trim();
      const eqIdx = main.indexOf('=');
      if (eqIdx > 0) {
        const k = main.slice(0, eqIdx).trim();
        const v = main.slice(eqIdx + 1).trim();
        const idx = parts.findIndex(p => p.startsWith(`${k}=`));
        if (idx !== -1) parts[idx] = `${k}=${v}`;
        else parts.push(`${k}=${v}`);
      }
    }
    const updated = parts.filter(Boolean).join('; ');
    if (updated) this.cookie = updated;
  }

  // Unified request with per-domain acw cache and multi-domain failover.
  private async request(
    url: string,
    method: 'GET' | 'POST' = 'GET',
    body?: Record<string, string>,
    customReferer?: string,
  ): Promise<string> {
    let effectiveUrl = url;
    const urlHost = safeHost(url);
    const isShareHost = urlHost === this.shareHost() || LANZOU_SHARE_DOMAINS.includes(urlHost);
    if (isShareHost && this.workingShareHost && urlHost !== this.workingShareHost) {
      effectiveUrl = targetUrlWithDomain(url, this.workingShareHost);
    }
    const shareCandidates = isShareHost ? LANZOU_SHARE_DOMAINS.filter(d => !url.includes(d)) : [];

    const tryUrl = (targetUrl: string): Promise<string> => {
      const targetHost = safeHost(targetUrl);
      const targetIsShare = targetHost === this.shareHost() || LANZOU_SHARE_DOMAINS.includes(targetHost);
      let referer: string;
      if (targetIsShare) {
        if (customReferer && (LANZOU_SHARE_DOMAINS.includes(safeHost(customReferer)) || safeHost(customReferer) === this.shareHost())) {
          referer = targetUrlWithDomain(customReferer, targetHost);
        } else {
          referer = `${new URL(targetUrl).origin}/`;
        }
      } else {
        referer = customReferer || this.getBaseUrl();
      }
      return this.requestOnce(targetUrl, method, body, referer, targetHost);
    };

    try {
      return await tryUrl(effectiveUrl);
    } catch (err: any) {
      const blocked = isShareHost && (err?.status === 403 || err?.status === 405 || /403|405/.test(err?.message || ''));
      if (!blocked) throw err;
      for (const domain of shareCandidates) {
        const altUrl = targetUrlWithDomain(effectiveUrl, domain);
        try {
          const result = await tryUrl(altUrl);
          this.workingShareHost = domain;
          return result;
        } catch (e2: any) {
          const stillBlocked = e2?.status === 403 || e2?.status === 405 || /403|405/.test(e2?.message || '');
          if (!stillBlocked) throw e2;
        }
      }
      throw err;
    }
  }

  private async requestOnce(
    url: string,
    method: 'GET' | 'POST',
    body: Record<string, string> | undefined,
    referer: string,
    host: string,
  ): Promise<string> {
    for (let retry = 0; retry < 3; retry++) {
      const headers: Record<string, string> = {
        'Referer': referer,
        'User-Agent': this.ua(),
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'X-Requested-With': 'XMLHttpRequest',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Accept': '*/*',
      };
      const refHost = (() => { try { return new URL(referer).host; } catch { return ''; } })();
      if (refHost === host) {
        headers['Origin'] = referer.slice(0, referer.indexOf(refHost) + refHost.length);
      }
      let cookieStr = this.cookie;
      if (url.includes('/file/')) cookieStr = (cookieStr ? cookieStr + '; ' : '') + 'down_ip=1';
      const acw = this.acwMap.get(host);
      if (acw) cookieStr = (cookieStr ? cookieStr + '; ' : '') + `acw_sc__v2=${acw}`;
      if (cookieStr) headers['Cookie'] = cookieStr;

      let reqBody: string | undefined;
      if (body && method === 'POST') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        reqBody = new URLSearchParams(body).toString();
      }

      const res = await fetch(url, { method, headers, body: reqBody });
      this.updateCookie(res.headers.get('set-cookie'), host);

      if (res.status === 403 || res.status === 405) {
        const err: any = new Error(`[Lanzou] ${url} 返回 HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      if (res.status === 429 || res.status >= 500 || res.status === 408) {
        if (retry < 2) {
          await new Promise(r => setTimeout(r, 300 * (retry + 1)));
          continue;
        }
        const err: any = new Error(`[Lanzou] ${url} 返回 HTTP ${res.status}（多次重试仍失败）`);
        err.status = res.status;
        throw err;
      }
      const bodyStr = await res.text();
      if (bodyStr.includes('acw_sc__v2')) {
        this.acwMap.set(host, calcAcwScV2(bodyStr));
        continue;
      }
      return bodyStr;
    }
    throw new Error('[Lanzou] 请求触发 acw_sc__v2 校验超限');
  }

  private async login(): Promise<void> {
    if (!this.cfg.account || !this.cfg.password) {
      throw new Error('lanzou: 账号模式下必须提供账号与密码');
    }
    for (let retry = 0; retry < 3; retry++) {
      const headers: Record<string, string> = {
        'User-Agent': this.ua(),
        'Referer': 'https://pc.woozooo.com',
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      const acw = this.acwMap.get('up.woozooo.com');
      if (acw) headers['Cookie'] = `acw_sc__v2=${acw}`;
      const res = await fetch('https://up.woozooo.com/mlogin.php', {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          task: '3',
          uid: this.cfg.account || '',
          pwd: this.cfg.password || '',
          setSessionId: '',
          setSig: '',
          setScene: '',
          setTocen: '',
          formhash: '',
        }),
      });
      this.updateCookie(res.headers.get('set-cookie'), 'up.woozooo.com');
      const bodyStr = await res.text();
      if (bodyStr.includes('acw_sc__v2')) {
        this.acwMap.set('up.woozooo.com', calcAcwScV2(bodyStr));
        continue;
      }
      let data: any;
      try { data = JSON.parse(bodyStr); } catch { throw new Error(`lanzou: 登录响应异常: ${bodyStr.slice(0, 200)}`); }
      if (data.zt !== 1) {
        throw new Error(`lanzou: 登录失败: ${data.info || bodyStr.slice(0, 200)}`);
      }
      return;
    }
    throw new Error('lanzou: 登录多次触发 WAF 校验失败');
  }

  private async initVeiAndUid(): Promise<void> {
    const html = await this.request(`${this.getBaseUrl()}/mydisk.php?item=files&action=index`, 'GET');
    const uidMatch = html.match(/uid=([^'"&;]+)/);
    if (!uidMatch) {
      if (html.includes('退出中') || html.includes('acc.php?t=logout') || html.includes('login')) {
        throw new Error('lanzou: session invalid — cookie is expired or login failed, please re-login or update the cookie');
      }
      throw new Error('lanzou: uid variable not find (session invalid or page structure changed)');
    }
    this.uid = uidMatch[1];
    const cleanHtml = removeNotes(html);
    try {
      const data = htmlJsonToMap(cleanHtml);
      this.vei = data['vei'] || '';
    } catch {
      // fall through to the regex fallback
    }
    if (!this.vei) {
      const veiMatch = html.match(/['"]?vei['"]?\s*[:=]\s*['"]?([^'",\s]+)['"]?/);
      if (veiMatch) this.vei = veiMatch[1];
    }
    if (!this.vei) {
      // mydisk.php may embed vei in a JS var (var xxx = '...vei...').
      const veiVar = html.match(/vei\s*[:=]\s*['"]([^'"]+)['"]/);
      if (veiVar) this.vei = veiVar[1];
    }
    if (!this.uid || !this.vei) {
      throw new Error(`lanzou: 未能从 mydisk.php 提取到完整的 uid(${this.uid ? 'ok' : '缺失'})/vei(${this.vei ? 'ok' : '缺失'})，请检查 Cookie 是否有效`);
    }
  }

  /**
   * 主动校验当前 Cookie 是否有效（供管理后台状态刷新调用）。
   * 蓝奏云 Cookie 有效期约 15 天；url（公开分享）模式不依赖 Cookie。
   */
  async checkCookieValid(): Promise<{ valid: boolean; error?: string }> {
    if (this.isUrlMode()) return { valid: true };
    if (this.cfg.type === 'account') return { valid: true };
    try {
      await this.getFiles('-1');
      return { valid: true };
    } catch (err: any) {
      const msg = err?.message || String(err);
      return {
        valid: false,
        error: /expired|invalid|uid|vei|session|过期|失效/i.test(msg)
          ? 'lanzou: Cookie 已过期或失效（约 15 天有效期），请在管理后台重新填写 Cookie'
          : msg,
      };
    }
  }

  private async doupload(params: Record<string, string>): Promise<any> {
    const url = `${this.getBaseUrl()}/doupload.php?uid=${this.uid}&vei=${this.vei}`;
    const bodyStr = await this.request(url, 'POST', params);
    let data: any;
    try { data = JSON.parse(bodyStr); } catch { throw new Error(`lanzou: 非 JSON 响应: ${bodyStr.slice(0, 200)}`); }
    if (data.zt === 9) {
      if (this.cfg.type === 'account') {
        await this.login();
        await this.initVeiAndUid();
        return this.doupload(params);
      }
      const diag = `uid=${this.uid ? 'ok' : '缺失'} vei=${this.vei ? 'ok' : '缺失'}`;
      throw new Error(`lanzou: cookie is expired or invalid (约 15 天有效期), please update the cookie [${diag}]`);
    }
    if (data.zt !== 1 && data.zt !== 2 && data.zt !== 4) {
      throw new Error(data.inf || data.info || `lanzou: API error (zt: ${data.zt})`);
    }
    return data;
  }

  private async getFolders(folderId: string): Promise<LanzouItem[]> {
    const resp = await this.doupload({ task: '47', folder_id: folderId || '-1' });
    return (resp.text || []).map((item: any) => ({
      ...item,
      name: item.name,
      fol_id: item.fol_id || item.id,
      is_folder: true,
    }));
  }

  private async getFiles(folderId: string): Promise<LanzouItem[]> {
    const all: LanzouItem[] = [];
    for (let pg = 1; ; pg++) {
      const resp = await this.doupload({ task: '5', folder_id: folderId || '-1', pg: String(pg) });
      const list: any[] = resp.text || [];
      if (list.length === 0) break;
      all.push(...list.map((item: any) => ({
        ...item,
        name_all: item.name_all || item.name,
        id: item.id,
        size: item.size,
        time: item.time,
        is_folder: false,
      })));
    }
    return all;
  }

  private async getAllFiles(folderId: string): Promise<LanzouItem[]> {
    return [...await this.getFolders(folderId), ...await this.getFiles(folderId)];
  }

  private async getFileShareUrlById(fileId: string): Promise<LanzouShareInfo> {
    const resp = await this.doupload({ task: '22', file_id: fileId });
    return resp.info || {};
  }

  // ---------------- share page ----------------
  private async probeShareDomain(shareId: string): Promise<string> {
    const cleanId = (shareId || '').replace(/^\//, '');
    if (!cleanId) return this.getShareUrl();
    try {
      const pageData = await this.request(`${this.getShareUrl()}/${cleanId}`, 'GET');
      return this.extractRealShareDomain(pageData) || this.getShareUrl();
    } catch {
      return this.getShareUrl();
    }
  }

  private extractRealShareDomain(pageData: string): string {
    const candidates: string[] = [];
    const iframeMatch = pageData.match(/<iframe[^>]*?src=["'](https?:\/\/[^"'/]+)/i);
    if (iframeMatch) candidates.push(iframeMatch[1]);
    const fnMatch = pageData.match(/["'](https?:\/\/[^"']*?\/fn\?[^"']*)["']/i);
    if (fnMatch) candidates.push(fnMatch[1]);
    const domMatch = pageData.match(/["']?(?:dom|url)\s*[:=]\s*["']?(https?:\/\/[^"'\s]+)/i);
    if (domMatch) candidates.push(domMatch[1]);
    for (const raw of candidates) {
      try {
        const u = new URL(raw);
        return `${u.protocol}//${u.host}`;
      } catch {
        // next
      }
    }
    return '';
  }

  private async getFileOrFolderByShareUrl(shareId: string, pwd: string): Promise<LanzouItem[]> {
    const cleanId = (shareId || '').replace(/^\//, '');
    const pageData = await this.request(`${this.getShareUrl()}/${cleanId}`, 'GET');
    if (pageData.includes('取消分享')) throw new Error('lanzou: 该文件已取消分享');
    if (pageData.includes('文件不存在')) throw new Error('lanzou: 文件不存在');
    if (!/class="fileinfo"|id="file"|文件描述/i.test(pageData)) {
      return this.getFolderByShareUrl(pwd, pageData);
    }
    return [await this.getFilesByShareUrl(cleanId, pwd, pageData)];
  }

  private async getFolderByShareUrl(pwd: string, sharePageData: string): Promise<LanzouItem[]> {
    const cleanHtml = removeNotes(sharePageData);
    let form: Record<string, string> = {};
    try { form = htmlJsonToMap(cleanHtml); } catch { form = {}; }
    const files: LanzouItem[] = [];
    const subFolderMatches = Array.from(
      sharePageData.matchAll(/(?:folderlink|mbxfolder)[^>]*href=["']\/?([^"']+)["'][^>]*>(.+?)<\//gi),
    );
    for (const m of subFolderMatches) {
      files.push({ id: m[1], name_all: m[2].trim(), is_folder: true });
    }
    form['pwd'] = pwd || this.sharePassword();
    for (let page = 1; ; page++) {
      form['pg'] = String(page);
      const resStr = await this.request(`${this.getShareUrl()}/filemoreajax.php`, 'POST', form);
      let resp: any;
      try { resp = JSON.parse(resStr); } catch { break; }
      if (resp.zt !== 1 || !Array.isArray(resp.text) || resp.text.length === 0) break;
      for (const item of resp.text) {
        files.push({
          id: item.id,
          name_all: item.name_all || item.name,
          size: item.size,
          time: item.time,
          is_folder: false,
          pwd: form['pwd'],
        });
      }
    }
    return files;
  }

  private async getFilesByShareUrl(
    shareId: string,
    pwd: string,
    cachedPageData?: string,
    customShareDomain?: string,
  ): Promise<LanzouItem> {
    const cleanId = (shareId || '').replace(/^\//, '');
    const shareBase = (customShareDomain || await this.probeShareDomain(cleanId)).replace(/\/+$/, '');
    const sharePageUrl = `${shareBase}/${cleanId}`;
    let pageData = cachedPageData;
    if (!pageData) pageData = await this.request(sharePageUrl, 'GET');
    pageData = removeNotes(pageData);
    pageData = removeJSComment(pageData);

    let param: Record<string, string> = {};
    let baseUrl = '';
    let downloadUrl = '';
    const result: LanzouItem = { id: cleanId, is_folder: false };

    const needsPassword = pageData.includes('pwdload') || pageData.includes('passwddiv');
    if (needsPassword) {
      const fnCode = getJSFunctionByName(pageData, 'down_p');
      param = htmlJsonToMap(fnCode, pageData);
      param['p'] = pwd || this.sharePassword();
      const fileIdMatch =
        fnCode.match(/['"]?\/?ajax(?:file|m)\.php\?file=(\d+)['"]?/) ||
        pageData.match(/['"]?\/?ajax(?:file|m)\.php\?file=(\d+)['"]?/) ||
        fnCode.match(/file\s*[:=]\s*['"]?(\d+)['"]?/) ||
        pageData.match(/file\s*[:=]\s*['"]?(\d+)['"]?/);
      if (!fileIdMatch) throw new Error('lanzou: 未找到文件 ID');
      const fileId = fileIdMatch[1];
      const resStr = await this.request(`${shareBase}/ajaxfile.php?file=${fileId}`, 'POST', param, sharePageUrl);
      let resp: LanzouShareResp;
      try { resp = JSON.parse(resStr); } catch { throw new Error(`lanzou: ajaxfile.php 响应格式错误: ${resStr.slice(0, 200)}`); }
      if (resp.zt !== 1) throw new Error(resp.info || resp.text || `lanzou: 密码错误或提取链接失败 (zt=${resp.zt})`);
      result.name_all = resp.inf || 'download';
      baseUrl = `${resp.dom}/file`;
      downloadUrl = `${baseUrl}/${resp.url}`;
    } else {
      const iframeMatch =
        pageData.match(/<iframe[^>]*?src=["']([^"']+)["']/i) ||
        pageData.match(/href=["'](\/fn\?[^"']+)["']/i) ||
        pageData.match(/["'](\/fn\?[^"']+)["']/i);
      if (!iframeMatch) throw new Error('lanzou: 未找到下载页面 iframe 参数');
      const iframePath = iframeMatch[1];
      const iframeFullUrl = `${shareBase}${iframePath.startsWith('/') ? '' : '/'}${iframePath}`;
      const nextPageData = await this.request(iframeFullUrl, 'GET', undefined, sharePageUrl);
      const cleanNextPage = removeNotes(nextPageData);
      param = htmlJsonToMap(cleanNextPage, cleanNextPage);
      const fileIdMatch =
        cleanNextPage.match(/['"]?\/?ajax(?:file|m)\.php\?file=(\d+)['"]?/) ||
        cleanNextPage.match(/file\s*[:=]\s*['"]?(\d+)['"]?/) ||
        cleanNextPage.match(/file=(\d+)/) ||
        cleanNextPage.match(/var\s+file_id\s*=\s*['"]?(\d+)['"]?/);
      if (!fileIdMatch) throw new Error('lanzou: 未找到文件 ID');
      const fileId = fileIdMatch[1];
      const resStr = await this.request(`${shareBase}/ajaxfile.php?file=${fileId}`, 'POST', param, iframeFullUrl);
      let resp: LanzouShareResp;
      try { resp = JSON.parse(resStr); } catch { throw new Error(`lanzou: ajaxfile.php 响应格式错误: ${resStr.slice(0, 200)}`); }
      if (resp.zt !== 1) throw new Error(resp.info || resp.text || `lanzou: 提取链接失败 (zt=${resp.zt})`);
      baseUrl = `${resp.dom}/file`;
      downloadUrl = `${baseUrl}/${resp.url}`;
      const nameMatch = pageData.match(
        /<title>(.+?) - 蓝奏云<\/title>|id="filenajax">(.+?)<\/div>|var filename = ['"](.+?)['"];|<div style="font-size[^>]*>([^<>]+)<\/div>|<div class="filethetext"[^>]*>([^<>]+)<\/div>/i,
      );
      if (nameMatch) {
        for (let i = 1; i < nameMatch.length; i++) {
          if (nameMatch[i]) { result.name_all = nameMatch[i].trim(); break; }
        }
      }
    }

    const sizeMatch = pageData.match(/大小\W*([0-9.]+\s*[bkm]+)/i);
    if (sizeMatch) result.size = sizeMatch[1];
    const timeMatch = pageData.match(/\d+\s*[秒天分小][钟时]?前|[昨前]天|\d{4}-\d{2}-\d{2}/);
    if (timeMatch) result.time = timeMatch[0];

    // Resolve the 302 / direct URL with retries + fallback.
    let realDirectUrl = downloadUrl;
    let vs = '';
    let resolved = false;
    for (let i = 0; i < 3; i++) {
      const headers: Record<string, string> = {
        'Referer': baseUrl,
        'User-Agent': this.ua(),
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
      };
      let c = 'down_ip=1';
      if (vs) c += `; acw_sc__v2=${vs}`;
      headers['Cookie'] = c;
      let probeRes: Response;
      try {
        probeRes = await fetch(downloadUrl, { method: 'GET', headers, redirect: 'manual' });
      } catch {
        if (i < 2) { await new Promise(r => setTimeout(r, 400 * (i + 1))); continue; }
        throw new Error('lanzou: 直链探测网络错误，请稍后重试');
      }
      if ([301, 302, 303, 307, 308].includes(probeRes.status)) {
        const loc = probeRes.headers.get('location');
        if (loc) { realDirectUrl = new URL(loc, downloadUrl).toString(); resolved = true; break; }
      }
      if (probeRes.status === 200 && probeRes.url && probeRes.url !== downloadUrl) {
        realDirectUrl = probeRes.url;
        resolved = true;
        break;
      }
      if (probeRes.status === 429 || probeRes.status >= 500) {
        if (i < 2) { await new Promise(r => setTimeout(r, 400 * (i + 1))); continue; }
        throw new Error(`lanzou: 直链探测返回 HTTP ${probeRes.status}，请稍后重试`);
      }
      const bodyText = await probeRes.text();
      if (bodyText.includes('acw_sc__v2')) {
        vs = calcAcwScV2(bodyText);
        continue;
      }
      // Fallback: ajax.php secondary verification.
      try {
        const ajaxParam = htmlJsonToMap(bodyText, bodyText);
        ajaxParam['el'] = '2';
        await new Promise(r => setTimeout(r, 1500));
        const ajaxResStr = await this.request(`${baseUrl}/ajax.php`, 'POST', ajaxParam, baseUrl);
        const ajaxData = JSON.parse(ajaxResStr);
        if (ajaxData.url) {
          realDirectUrl = ajaxData.url.startsWith('http') ? ajaxData.url : new URL(ajaxData.url, baseUrl).toString();
          resolved = true;
          break;
        }
      } catch {
        if (i < 2) { await new Promise(r => setTimeout(r, 600 * (i + 1))); continue; }
      }
      break;
    }
    if (!resolved) throw new Error('lanzou: 直链解析失败，请稍后重试');
    result.url = realDirectUrl;
    return result;
  }

  private async getFileRealInfo(downUrl: string): Promise<{ size?: number; time?: string }> {
    try {
      const res = await fetch(downUrl, { method: 'HEAD', headers: { 'User-Agent': this.ua() } });
      const len = res.headers.get('content-length');
      const modified = res.headers.get('last-modified');
      return {
        size: len ? parseInt(len, 10) : undefined,
        time: modified ? new Date(modified).toISOString() : undefined,
      };
    } catch {
      return {};
    }
  }

  // ---------------- path resolution ----------------
  private async resolveFolderId(physicalPath: string): Promise<string> {
    const rootId = this.getRootId();
    const clean = '/' + String(physicalPath || '').split('/').filter(Boolean).join('/');
    if (clean === '/' || clean === `/${rootId}`) return rootId;
    const segs = clean.split('/').filter(Boolean);
    let cachedLen = 0;
    let parentId = rootId;
    for (let i = 0; i < segs.length; i++) {
      const p = '/' + segs.slice(0, i + 1).join('/');
      const id = this.pathIdCache.get(p);
      if (id !== undefined) { parentId = id; cachedLen = i + 1; }
      else break;
    }
    for (let i = cachedLen; i < segs.length; i++) {
      const rawName = segs[i];
      const decodedName = (() => { try { return decodeURIComponent(rawName); } catch { return rawName; } })();
      const items = this.isUrlMode()
        ? await this.getFileOrFolderByShareUrl(parentId, this.sharePassword())
        : await this.getFolders(parentId);
      const folder = items.find(f => {
        if (!f.is_folder && !f.fol_id) return false;
        const fName = f.name || f.name_all || '';
        const fId = f.fol_id || f.id || '';
        return fName === rawName || fName === decodedName || fId === rawName || fId === decodedName;
      });
      if (!folder) throw new Error(`lanzou: 目录未找到: ${rawName}`);
      parentId = folder.fol_id || folder.id || '';
      this.pathIdCache.set('/' + segs.slice(0, i + 1).join('/'), parentId);
    }
    return parentId;
  }

  private async resolveItem(physicalPath: string): Promise<{ item: LanzouItem; isDir: boolean }> {
    const clean = '/' + String(physicalPath || '').split('/').filter(Boolean).join('/');
    const segs = clean.split('/').filter(Boolean);
    if (segs.length === 0) throw new Error('lanzou: 路径无效');
    const rawName = segs[segs.length - 1];
    const decodedName = (() => { try { return decodeURIComponent(rawName); } catch { return rawName; } })();
    const parentPath = '/' + segs.slice(0, segs.length - 1).join('/');
    const parentId = await this.resolveFolderId(parentPath);
    const items = this.isUrlMode()
      ? await this.getFileOrFolderByShareUrl(parentId, this.sharePassword())
      : await this.getAllFiles(parentId);
    const found = items.find(f => {
      const fName = f.name_all || f.name || '';
      const fId = f.fol_id || f.id || '';
      return fName === rawName || fName === decodedName || fId === rawName || fId === decodedName;
    });
    if (!found) throw new Error(`lanzou: 文件或目录未找到: ${rawName}`);
    const isDir = Boolean(found.is_folder || found.fol_id);
    if (isDir) this.pathIdCache.set(clean, found.fol_id || found.id || '');
    return { item: found, isDir };
  }

  // ---------------- Driver interface ----------------
  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const folderId = await this.resolveFolderId(path);
    const rawItems = this.isUrlMode()
      ? await this.getFileOrFolderByShareUrl(folderId, this.sharePassword())
      : await this.getAllFiles(folderId);
    const content = rawItems.map(item => {
      const isDir = Boolean(item.is_folder || item.fol_id);
      const name = item.name_all || item.name || '';
      const common = { name, modified: mustParseTime(item.time || ''), id: item.fol_id || item.id || '' };
      return isDir ? createDirObj(common) : createFileObj({ ...common, size: sizeStrToInt64(item.size || '0') });
    });
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const segs = String(path || '').split('/').filter(Boolean);
    if (segs.length === 0 || segs[segs.length - 1] === this.getRootId()) {
      return createDirObj({ name: this.getRootId() || 'root', id: this.getRootId(), modified: new Date().toISOString() });
    }
    const { item, isDir } = await this.resolveItem(path);
    const name = item.name_all || item.name || '';
    const common = { name, modified: mustParseTime(item.time || ''), id: item.fol_id || item.id || '' };
    return isDir ? createDirObj(common) : createFileObj({ ...common, size: sizeStrToInt64(item.size || '0') });
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const { item } = await this.resolveItem(path);
    let downloadUrl = item.url || '';
    if (!downloadUrl) {
      try {
        if (this.isUrlMode()) {
          const resolved = await this.getFilesByShareUrl(
            item.id || '',
            item.pwd || this.sharePassword(),
            undefined,
            await this.probeShareDomain(item.id || ''),
          );
          downloadUrl = resolved.url || '';
        } else {
          const shareInfo = await this.getFileShareUrlById(item.id || '');
          const shareId = shareInfo.f_id || shareInfo.id;
          if (shareId) {
            const resolved = await this.getFilesByShareUrl(shareId, shareInfo.pwd || '');
            downloadUrl = resolved.url || '';
          }
        }
      } catch (err: any) {
        throw new Error(`lanzou: 获取下载直链失败 (${item.name_all || item.name}): ${err.message}`);
      }
    }
    if (!downloadUrl) {
      throw new Error(`lanzou: 未能获取到下载直链 (${item.name_all || item.name || path})`);
    }
    const header: Record<string, string> = { 'User-Agent': this.ua() };
    if (this.cfg.repair_file_info) {
      await this.getFileRealInfo(downloadUrl);
    }
    return { url: downloadUrl, header };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    if (this.isUrlMode()) throw new Error('lanzou: 分享链接模式不支持新建文件夹');
    const segs = String(path || '').split('/').filter(Boolean);
    const dirName = segs.pop() || '新文件夹';
    const parentId = await this.resolveFolderId('/' + segs.join('/'));
    await this.doupload({ task: '2', parent_id: parentId || '-1', folder_name: dirName, folder_description: '' });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    if (this.isUrlMode()) throw new Error('lanzou: 分享链接模式不支持重命名');
    const { item, isDir } = await this.resolveItem(path);
    if (isDir) throw new Error('lanzou: 不支持重命名文件夹');
    await this.doupload({ task: '46', file_id: item.id || '', file_name: newName, type: '2' });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    if (this.isUrlMode()) throw new Error('lanzou: 分享链接模式不支持移动');
    const { item, isDir } = await this.resolveItem(src);
    if (isDir) throw new Error('lanzou: 不支持移动文件夹');
    const targetParentId = await this.resolveFolderId(dst);
    await this.doupload({ task: '20', file_id: item.id || '', folder_id: targetParentId });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    if (this.isUrlMode()) throw new Error('lanzou: 分享链接模式不支持删除');
    const { item, isDir } = await this.resolveItem(path);
    if (isDir) {
      await this.doupload({ task: '3', folder_id: item.fol_id || item.id || '' });
    } else {
      await this.doupload({ task: '6', file_id: item.id || '' });
    }
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('lanzou: 不支持直接复制文件');
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('lanzou: Cloudflare Worker 环境暂不支持直接流式写入，请使用网页端进行文件上传');
  }
}

registerDriver(LanZouDriver, lanzouConfig, lanzouAdditional);
