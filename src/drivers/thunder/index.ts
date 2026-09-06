/**
 * 迅雷云盘 (Thunder) Driver — writable
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/thunder (ThunderDriver). Self-contained: duplicated pure helpers
 * (MD5/SHA-1/GCID/device-sign) are inlined; no cross-folder driver imports.
 *
 * Username/password login through xluser-ssl.xunlei.com; access tokens are
 * kept in instance fields and refreshed in place (no DB persistence) whenever
 * an API call reports an expired access/captcha token.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const thunderConfig: DriverConfig = {
  name: 'Thunder',
  label: '迅雷云盘',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '',
};

export const thunderAdditional: DriverItem[] = [
  { name: 'root_folder_id', type: 'string', default: '', options: '', required: false, help: '根文件夹 ID' },
  { name: 'username', type: 'string', default: '', options: '', required: true, help: '登录用户名（手机号/邮箱）' },
  { name: 'password', type: 'string', default: '', options: '', required: true, help: '登录密码' },
  { name: 'captcha_token', type: 'string', default: '', options: '', required: false, help: '验证码 token（出现滑块验证/设备锁时填写）' },
  { name: 'credit_key', type: 'string', default: '', options: '', required: false, help: 'credit key, used for login' },
  { name: 'device_id', type: 'string', default: '', options: '', required: false, help: '设备 ID（32 位 hex），留空自动生成' },
  { name: 'space', type: 'string', default: '', options: '', required: false, help: '远程设备 ID' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,size,modified', required: false, help: '排序字段' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: '排序方向' },
];

// ---------------------------------------------------------------- constants

export const API_URL = 'https://api-pan.xunlei.com/drive/v1';
export const FILE_API_URL = `${API_URL}/files`;
export const XLUSER_API_BASE_URL = 'https://xluser-ssl.xunlei.com';
export const XLUSER_API_URL = `${XLUSER_API_BASE_URL}/v1`;

export const FOLDER = 'drive#folder';
export const FILE = 'drive#file';
export const UPLOAD_TYPE_RESUMABLE = 'UPLOAD_TYPE_RESUMABLE';

export const SignProvider = 'access_end_point_token';
export const APPID = '40';
export const APPKey = '34a062aaa22f906fca4fefe9fb3a3021';

const DEFAULT_USER_AGENT =
  'ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 deviceName/Xiaomi_M2004j7ac deviceModel/M2004J7AC OSVersion/12 protocolVersion/301 platformVersion/10 sdkVersion/512000 Oauth2Client/0.9 (Linux 4_14_186-perf-gddfs8vbb238b) (JAVA 0)';
const DEFAULT_DOWNLOAD_UA =
  'Dalvik/2.1.0 (Linux; U; Android 12; M2004J7AC Build/SP1A.210812.016)';

// ---------------------------------------------------------------- types

interface ThunderFile {
  kind: string; // "drive#folder" | "drive#file"
  id: string;
  parent_id: string;
  name: string;
  size: string;
  web_content_link?: string;
  created_time?: string;
  modified_time?: string;
  icon_link?: string;
  thumbnail_link?: string;
  medias?: Array<{ link?: { url: string } }>;
}

interface ThunderFileListResp {
  files: ThunderFile[];
  next_page_token?: string;
}

interface ThunderTokenResp {
  token_type: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_id?: string;
}

interface ThunderCoreLoginResp {
  sessionID: string;
  userID: string;
  creditkey?: string;
}

interface ThunderLoginReviewResp {
  creditkey: string;
  reviewurl: string;
}

interface ThunderCaptchaTokenResponse {
  captcha_token: string;
  expires_in: number;
  url?: string;
}

interface ThunderErrResp {
  error_code?: number;
  error?: string;
  error_description?: string;
}

interface ThunderUploadTaskResp {
  upload_type: string;
  resumable?: {
    params: {
      bucket: string;
      endpoint: string;
      key: string;
      security_token: string;
    };
  };
}

interface ThunderReviewData {
  creditkey: string;
  reviewurl: string;
  deviceid: string;
  devicesign: string;
}

interface ThunderClientOptions {
  algorithms?: string[];
  timestamp?: string;
  captchaSign?: string;
  deviceId: string;
  clientId: string;
  clientSecret: string;
  clientVersion: string;
  packageName: string;
  userAgent: string;
  downloadUserAgent: string;
  space?: string;
  captchaToken?: string;
  creditKey?: string;
}

// ---------------------------------------------------------------- crypto / pure helpers

function md5(input: string): string {
  // RFC 1321 pure-JS MD5 (dependency-free; SubtleCrypto does not support MD5).
  const msg = new TextEncoder().encode(input);
  const msgLen = msg.length;
  const bitLen = msgLen * 8;

  const padLen = (56 - ((msgLen + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(msgLen + 1 + padLen + 8);
  padded.set(msg);
  padded[msgLen] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  const T = new Int32Array(64);
  for (let i = 0; i < 64; i++) T[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;

  const r = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
  ];

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let i = 0; i < padded.length; i += 64) {
    const chunk = new DataView(padded.buffer, i, 64);
    const M = Array.from({ length: 16 }, (_, j) => chunk.getInt32(j * 4, true));
    let A = a0, B = b0, C = c0, D = d0;

    for (let j = 0; j < 64; j++) {
      let F: number, g: number;
      if (j < 16) { F = (B & C) | (~B & D); g = j; }
      else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
      else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * j) % 16; }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + T[j] + M[g]) | 0;
      B = (B + ((sum << r[j]) | (sum >>> (32 - r[j])))) | 0;
      A = tmp;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const result = new DataView(new ArrayBuffer(16));
  result.setInt32(0, a0, true);
  result.setInt32(4, b0, true);
  result.setInt32(8, c0, true);
  result.setInt32(12, d0, true);
  return Array.from(new Uint8Array(result.buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha1Hex(input: Uint8Array | string): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buf = await crypto.subtle.digest('SHA-1', data as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Xunlei GCID: per-chunk SHA-1 digests concatenated then SHA-1'd. */
async function calcGcid(data: Uint8Array): Promise<string> {
  const size = data.length;
  let psize = 0x40000; // 256KB
  while (size / psize > 0x200 && psize < 0x200000) {
    psize = psize << 1;
  }

  const chunkDigests: Uint8Array[] = [];
  for (let offset = 0; offset < size; offset += psize) {
    const chunk = data.subarray(offset, Math.min(offset + psize, size));
    const digest = await crypto.subtle.digest('SHA-1', chunk as BufferSource);
    chunkDigests.push(new Uint8Array(digest));
  }

  const total = chunkDigests.reduce((n, d) => n + d.length, 0);
  const combined = new Uint8Array(total);
  let p = 0;
  for (const d of chunkDigests) {
    combined.set(d, p);
    p += d.length;
  }
  const finalBuf = await crypto.subtle.digest('SHA-1', combined as BufferSource);
  return Array.from(new Uint8Array(finalBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function generateDeviceSignAsync(deviceID: string, packageName: string): Promise<string> {
  const signatureBase = `${deviceID}${packageName}${APPID}${APPKey}`;
  const sha1Result = await sha1Hex(signatureBase);
  const md5Result = md5(sha1Result);
  return `div101.${deviceID}${md5Result}`;
}

export function getAction(method: string, url: string): string {
  const m = url.match(/:\/\/[^/]+((\/[^/\s?#]+)*)/);
  const path = m ? m[1] : url;
  return `${method}:${path}`;
}

// ---------------------------------------------------------------- client

export class ThunderClient {
  public options: ThunderClientOptions;
  public tokenResp: ThunderTokenResp | null = null;
  public captchaToken: string = '';
  public creditKey: string = '';

  constructor(options: ThunderClientOptions) {
    this.options = options;
    this.captchaToken = options.captchaToken || '';
    this.creditKey = options.creditKey || '';
  }

  private genDeviceSign(): Promise<string> {
    return generateDeviceSignAsync(this.options.deviceId, this.options.packageName);
  }

  getCaptchaSign(): { timestamp: string; sign: string } {
    if (!this.options.algorithms || this.options.algorithms.length === 0) {
      return {
        timestamp: this.options.timestamp || '',
        sign: this.options.captchaSign || '',
      };
    }
    const timestamp = Date.now().toString();
    let str = `${this.options.clientId}${this.options.clientVersion}${this.options.packageName}${this.options.deviceId}${timestamp}`;
    for (const algorithm of this.options.algorithms) {
      str = md5(str + algorithm);
    }
    return {
      timestamp,
      sign: `1.${str}`,
    };
  }

  async refreshCaptchaToken(
    action: string,
    metas: Record<string, string>,
  ): Promise<void> {
    const param = {
      action,
      captcha_token: this.captchaToken,
      client_id: this.options.clientId,
      device_id: this.options.deviceId,
      meta: metas,
      redirect_uri: 'xlaccsdk01://xunlei.com/callback?state=harbor',
    };

    const res = await this.rawRequest<ThunderCaptchaTokenResponse & ThunderErrResp>(
      `${XLUSER_API_URL}/shield/captcha/init`,
      {
        method: 'POST',
        body: param,
      },
    );

    if (res.error_code || (res.error && res.error !== 'success')) {
      throw new Error(
        `Captcha error: ${res.error_code} ${res.error} ${res.error_description || ''}`,
      );
    }

    if (res.url) {
      throw new Error(
        `need verify: <a target="_blank" href="${res.url}">Click Here</a>`,
      );
    }

    if (!res.captcha_token) {
      throw new Error('empty captchaToken');
    }

    this.captchaToken = res.captcha_token;
  }

  async refreshCaptchaTokenAtLogin(action: string, userId: string): Promise<void> {
    const { timestamp, sign } = this.getCaptchaSign();
    const metas: Record<string, string> = {
      client_version: this.options.clientVersion,
      package_name: this.options.packageName,
      user_id: userId,
      timestamp,
      captcha_sign: sign,
    };
    await this.refreshCaptchaToken(action, metas);
  }

  async refreshCaptchaTokenInLogin(action: string, username: string): Promise<void> {
    const metas: Record<string, string> = {};
    if (/\w+([-+.]\w+)*@\w+([-.]\w+)*\.\w+([-.]\w+)*/.test(username)) {
      metas.email = username;
    } else if (username.length >= 11 && username.length <= 18) {
      metas.phone_number = username;
    } else {
      metas.username = username;
    }
    await this.refreshCaptchaToken(action, metas);
  }

  private formatReviewData(
    reviewResp: ThunderLoginReviewResp,
    deviceSign: string,
  ): Error {
    const reviewData: ThunderReviewData = {
      creditkey: reviewResp.creditkey,
      reviewurl: `${reviewResp.reviewurl}&deviceid=${deviceSign}`,
      deviceid: deviceSign,
      devicesign: deviceSign,
    };
    const jsonStr = JSON.stringify(reviewData, null, 2);
    const html = `
<div style="font-family: Arial, sans-serif; padding: 15px; border-radius: 5px; border: 1px solid #e0e0e0;">
    <h3 style="color: #d9534f; margin-top: 0;">
        <span style="font-size: 16px;">🔒 本次登录需要验证</span><br>
        <span style="font-size: 14px; font-weight: normal; color: #666;">This login requires verification</span>
    </h3>
    <p style="font-size: 14px; margin-bottom: 15px;">下面是验证所需要的数据，具体使用方法请参照对应的驱动文档<br>
    <span style="color: #666; font-size: 13px;">Below are the relevant verification data. For specific usage methods, please refer to the corresponding driver documentation.</span></p>
    <div style="border: 1px solid #ddd; border-radius: 4px; padding: 10px; overflow-x: auto; font-family: 'Courier New', monospace; font-size: 13px;">
        <pre style="margin: 0; white-space: pre-wrap;"><code>${jsonStr}</code></pre>
    </div>
</div>`;
    return new Error(html);
  }

  async rawRequest<T>(
    url: string,
    options: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      'user-agent': this.options.userAgent,
      accept: 'application/json;charset=UTF-8',
      'x-device-id': this.options.deviceId,
      'x-client-id': this.options.clientId,
      'x-client-version': this.options.clientVersion,
      ...(options.headers || {}),
    };

    let bodyStr: string | undefined = undefined;
    if (options.body !== undefined) {
      if (typeof options.body === 'string') {
        bodyStr = options.body;
      } else {
        bodyStr = JSON.stringify(options.body);
        if (!headers['content-type']) {
          headers['content-type'] = 'application/json;charset=UTF-8';
        }
      }
    }

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: bodyStr,
    });

    const text = await res.text();
    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${text}`);
      }
      return text as unknown as T;
    }

    if (data.error === 'review_panel') {
      const deviceSign = await this.genDeviceSign();
      throw this.formatReviewData(data as ThunderLoginReviewResp, deviceSign);
    }

    return data as T;
  }

  async authRequest<T>(
    url: string,
    options: {
      method?: string;
      body?: any;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    if (!this.tokenResp?.access_token) {
      throw new Error('empty token');
    }

    const authHeaders: Record<string, string> = {
      Authorization: `${this.tokenResp.token_type} ${this.tokenResp.access_token}`,
      'X-Captcha-Token': this.captchaToken,
      ...(options.headers || {}),
    };

    const data = await this.rawRequest<any>(url, {
      ...options,
      headers: authHeaders,
    });

    const errCode = data?.error_code || 0;
    if (
      errCode === 4122 ||
      errCode === 4121 ||
      errCode === 10 ||
      errCode === 16
    ) {
      // Access token expired, try to refresh in place (no DB persistence).
      if (this.tokenResp?.refresh_token) {
        const refreshed = await this.refreshToken(this.tokenResp.refresh_token);
        this.tokenResp = refreshed;
        return this.authRequest<T>(url, options);
      }
      throw new Error(`Token expired error ${errCode}`);
    } else if (errCode === 9) {
      // Captcha token expired
      const action = getAction(options.method || 'GET', url);
      await this.refreshCaptchaTokenAtLogin(
        action,
        this.tokenResp.user_id || '',
      );
      return this.authRequest<T>(url, options);
    } else if (errCode !== 0 || (data.error && data.error !== 'success')) {
      throw new Error(
        `ErrorCode: ${data.error_code || 0}, Error: ${data.error || ''}, ErrorDescription: ${data.error_description || ''}`,
      );
    }

    return data as T;
  }

  async coreLogin(
    username: string,
    password: string,
  ): Promise<ThunderCoreLoginResp> {
    const url = `${XLUSER_API_BASE_URL}/xluser.core.login/v3/login`;
    const body = {
      protocolVersion: '301',
      sequenceNo: '1000012',
      platformVersion: '10',
      isCompressed: '0',
      appid: APPID,
      clientVersion: this.options.clientVersion,
      peerID: '00000000000000000000000000000000',
      appName: 'ANDROID-com.xunlei.downloadprovider',
      sdkVersion: '512000',
      devicesign: await this.genDeviceSign(),
      netWorkType: 'WIFI',
      providerName: 'NONE',
      deviceModel: 'M2004J7AC',
      deviceName: 'Xiaomi_M2004j7ac',
      OSVersion: '12',
      creditkey: this.creditKey,
      hl: 'zh-CN',
      userName: username,
      passWord: password,
      verifyKey: '',
      verifyCode: '',
      isMd5Pwd: '0',
    };

    const res = await this.rawRequest<ThunderCoreLoginResp>(url, {
      method: 'POST',
      body,
      headers: {
        'user-agent': 'android-ok-http-client/xl-acc-sdk/version-5.0.12.512000',
      },
    });
    return res;
  }

  async login(username: string, password: string): Promise<ThunderTokenResp> {
    const coreResp = await this.coreLogin(username, password);
    const sessionId = coreResp.sessionID;

    const signinUrl = `${XLUSER_API_URL}/auth/signin/token`;
    await this.refreshCaptchaTokenInLogin(
      getAction('POST', signinUrl),
      username,
    );

    const resp = await this.rawRequest<ThunderTokenResp>(signinUrl, {
      method: 'POST',
      body: {
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        provider: SignProvider,
        signin_token: sessionId,
      },
    });

    this.tokenResp = resp;
    this.creditKey = ''; // reset credit key upon successful login
    return resp;
  }

  async refreshToken(refreshToken: string): Promise<ThunderTokenResp> {
    const url = `${XLUSER_API_URL}/auth/token`;
    const resp = await this.rawRequest<ThunderTokenResp>(url, {
      method: 'POST',
      body: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      },
    });
    this.tokenResp = resp;
    return resp;
  }

  async isLogin(): Promise<boolean> {
    if (!this.tokenResp?.access_token) return false;
    try {
      await this.authRequest(`${XLUSER_API_URL}/user/me`, { method: 'GET' });
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------- helpers

function generateDeviceId(cfg: Record<string, any>): string {
  if (cfg?.device_id && String(cfg.device_id).trim().length === 32) {
    return String(cfg.device_id).trim();
  }
  const seed = `${cfg?.username || ''}${cfg?.password || ''}`;
  if (seed.trim()) {
    return md5(seed);
  }
  return md5(Math.random().toString(36) + Date.now().toString(36));
}

function sortItems(items: Obj[], orderBy?: string, orderDirection?: string): Obj[] {
  const asc = orderDirection !== 'desc';
  const key = String(orderBy || 'name').toLowerCase();
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let cmp: number;
    if (key.includes('size')) {
      cmp = (a.size || 0) - (b.size || 0);
    } else if (
      key.includes('time') ||
      key.includes('modified') ||
      key.includes('created')
    ) {
      cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
    } else {
      cmp = String(a.name).localeCompare(String(b.name));
    }
    return asc ? cmp : -cmp;
  });
  return sorted;
}

function thunderFileToObj(f: ThunderFile): Obj {
  const isDir = f.kind === FOLDER;
  const common = {
    name: f.name,
    size: isDir ? 0 : parseInt(f.size || '0', 10),
    modified: f.modified_time || f.created_time || new Date().toISOString(),
    thumb: f.thumbnail_link || f.icon_link || undefined,
    id: f.id,
  };
  return isDir ? createDirObj(common) : createFileObj(common);
}

// ---------------------------------------------------------------- driver

export class ThunderDriver implements Driver {
  private cfg: Record<string, any> = {};
  private client: ThunderClient | null = null;
  private identity: string = '';

  config(): DriverConfig {
    return thunderConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = { ...(cfg || {}) };
    const username = this.cfg.username || '';
    const password = this.cfg.password || '';
    const identity = md5(`${username}${password}`);

    const deviceId = generateDeviceId(this.cfg);
    this.cfg.device_id = deviceId;

    const client = new ThunderClient({
      deviceId,
      clientId: 'Xp6vsxz_7IYVw2BB',
      clientSecret: 'Xp6vsy4tN9toTVdMSpomVdXpRmES',
      clientVersion: '8.31.0.9726',
      packageName: 'com.xunlei.downloadprovider',
      userAgent: DEFAULT_USER_AGENT,
      downloadUserAgent: DEFAULT_DOWNLOAD_UA,
      space: this.cfg.space || '',
      captchaToken: this.cfg.captcha_token || '',
      creditKey: this.cfg.credit_key || '',
    });
    this.client = client;

    if (this.identity !== identity || !(await client.isLogin())) {
      this.identity = identity;
      await client.login(username, password);
    }
  }

  private requireClient(): ThunderClient {
    if (!this.client) throw new Error('Thunder driver not initialized');
    return this.client;
  }

  private getDownloadUserAgent(): string {
    return DEFAULT_DOWNLOAD_UA;
  }

  private resolveFolderId(physicalPath: string): string {
    if (!physicalPath || physicalPath === '/' || physicalPath === '0') {
      return this.cfg.root_folder_id || '';
    }
    const parts = physicalPath.split('/').filter(Boolean);
    return parts[parts.length - 1] || this.cfg.root_folder_id || '';
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const client = this.requireClient();
    const folderId = this.resolveFolderId(path);
    const items: Obj[] = [];
    let pageToken = '';

    while (true) {
      const url = new URL(FILE_API_URL);
      url.searchParams.set('space', this.cfg.space || '');
      url.searchParams.set('__type', 'drive');
      url.searchParams.set('refresh', 'true');
      url.searchParams.set('__sync', 'true');
      url.searchParams.set('parent_id', folderId);
      url.searchParams.set('page_token', pageToken);
      url.searchParams.set('with_audit', 'true');
      url.searchParams.set('limit', '100');
      url.searchParams.set(
        'filters',
        JSON.stringify({
          phase: { eq: 'PHASE_TYPE_COMPLETE' },
          trashed: { eq: false },
        }),
      );

      const res = await client.authRequest<ThunderFileListResp>(
        url.toString(),
        { method: 'GET' },
      );

      if (res.files && res.files.length > 0) {
        for (const f of res.files) {
          items.push(thunderFileToObj(f));
        }
      }

      if (!res.next_page_token) {
        break;
      }
      pageToken = res.next_page_token;
    }

    const content = sortItems(items, this.cfg.order_by, this.cfg.order_direction);
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const client = this.requireClient();
    const fileId = this.resolveFolderId(path);
    const url = new URL(`${FILE_API_URL}/${fileId}`);
    url.searchParams.set('space', this.cfg.space || '');
    const res = await client.authRequest<ThunderFile>(url.toString(), {
      method: 'GET',
    });
    return thunderFileToObj(res);
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const client = this.requireClient();
    const fileId = this.resolveFolderId(path);
    const url = new URL(`${FILE_API_URL}/${fileId}`);
    url.searchParams.set('space', this.cfg.space || '');
    const res = await client.authRequest<ThunderFile>(url.toString(), {
      method: 'GET',
    });
    if (res.kind === FOLDER) {
      throw new Error(`Cannot get link for directory: ${path}`);
    }
    let rawUrl = res.web_content_link || '';
    if (res.medias && res.medias.length > 0) {
      for (const m of res.medias) {
        if (m.link?.url) {
          rawUrl = m.link.url;
          break;
        }
      }
    }
    if (!rawUrl) {
      throw new Error(`Thunder: no download link for ${res.name}`);
    }
    return { url: rawUrl, header: { 'User-Agent': this.getDownloadUserAgent() } };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const client = this.requireClient();
    const parts = path.split('/').filter(Boolean);
    const dirName = parts.pop() || 'new_folder';
    const parentPath = '/' + parts.join('/');
    const parentId = this.resolveFolderId(parentPath);

    await client.authRequest(FILE_API_URL, {
      method: 'POST',
      body: {
        kind: FOLDER,
        name: dirName,
        parent_id: parentId,
        space: this.cfg.space || '',
      },
    });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const client = this.requireClient();
    const fileId = this.resolveFolderId(path);
    await client.authRequest(`${FILE_API_URL}/${fileId}`, {
      method: 'PATCH',
      body: {
        name: newName,
        space: this.cfg.space || '',
      },
    });
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const client = this.requireClient();
    const fileId = this.resolveFolderId(path);
    const url = new URL(`${FILE_API_URL}/${fileId}/trash`);
    url.searchParams.set('space', this.cfg.space || '');
    await client.authRequest(url.toString(), {
      method: 'PATCH',
      body: {},
    });
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const client = this.requireClient();
    const srcFileId = this.resolveFolderId(src);
    const dstDir = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstDirId = this.resolveFolderId(dstDir);

    await client.authRequest(`${FILE_API_URL}:batchMove`, {
      method: 'POST',
      body: {
        to: { parent_id: dstDirId },
        ids: [srcFileId],
        space: this.cfg.space || '',
      },
    });
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const client = this.requireClient();
    const srcFileId = this.resolveFolderId(src);
    const dstDir = dst.substring(0, dst.lastIndexOf('/')) || '/';
    const dstDirId = this.resolveFolderId(dstDir);

    await client.authRequest(`${FILE_API_URL}:batchCopy`, {
      method: 'POST',
      body: {
        to: { parent_id: dstDirId },
        ids: [srcFileId],
        space: this.cfg.space || '',
      },
    });
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const client = this.requireClient();
    const content = new Uint8Array(file);
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop() || 'file';
    const parentPath = '/' + parts.join('/');
    const parentId = this.resolveFolderId(parentPath);
    const gcid = await calcGcid(content);

    const resp = await client.authRequest<ThunderUploadTaskResp>(
      FILE_API_URL,
      {
        method: 'POST',
        body: {
          kind: FILE,
          parent_id: parentId,
          name: fileName,
          size: content.length.toString(),
          hash: gcid,
          upload_type: UPLOAD_TYPE_RESUMABLE,
          space: this.cfg.space || '',
        },
      },
    );

    if (resp.upload_type === UPLOAD_TYPE_RESUMABLE && resp.resumable?.params) {
      const params = resp.resumable.params;
      let endpoint = params.endpoint;
      if (endpoint.startsWith(params.bucket + '.')) {
        endpoint = endpoint.slice(params.bucket.length + 1);
      }
      if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
        endpoint = `https://${endpoint}`;
      }

      const uploadUrl = `${endpoint.replace(/\/$/, '')}/${params.bucket}/${params.key}`;
      const headers: Record<string, string> = {
        'x-amz-security-token': params.security_token,
      };

      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers,
        body: content as BodyInit,
      });

      if (!uploadRes.ok) {
        throw new Error(
          `S3 Upload failed: ${uploadRes.status} ${uploadRes.statusText}`,
        );
      }
    }
  }
}

registerDriver(ThunderDriver, thunderConfig, thunderAdditional);
