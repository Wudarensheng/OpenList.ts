/**
 * 中国移动云盘 (139 Yun / 和彩云) Driver — personal_new
 * Referenced from OpenList's official drivers/139:
 * - Auth via a base64 `authorization` (account:token), refreshed through the
 *   tellin endpoint when close to expiry
 * - Route policy query resolves the personal cloud host
 * - Requests are signed with an MD5-based mcloud-sign header
 * - List via /file/list, download link via /file/getDownloadUrl
 * Only the `personal_new` type is ported (family/group/share are not).
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const yun139Config: DriverConfig = {
  name: '139Yun',
  label: '中国移动云盘',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: true,
  default_root: '/',
};

export const yun139Additional: DriverItem[] = [
  { name: 'authorization', type: 'text', default: '', options: '', required: true, help: 'Base64 authorization (account:token)' },
  { name: 'root_folder_id', type: 'string', default: '/', options: '', required: false, help: 'Root folder id' },
];

// ---------------------------------------------------------------------------
// MD5 (Web Crypto has no MD5; needed for the mcloud-sign header)
// ---------------------------------------------------------------------------
function md5hex(input: string): string {
  const rotl = (x: number, c: number) => (x << c) | (x >>> (32 - c));
  const bytes = new TextEncoder().encode(input);
  const n = bytes.length;
  const m: number[] = [];
  for (let i = 0; i < n; i++) m[i >> 2] = (m[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
  m[n >> 2] = (m[n >> 2] || 0) | (0x80 << ((n % 4) * 8));
  // 64-bit little-endian bit-length: low 32 bits at word 14, high at word 15.
  m[(((n + 8) >> 6) << 4) + 14] = (n * 8) >>> 0;
  m[(((n + 8) >> 6) << 4) + 15] = Math.floor(n / 536870912); // n bytes >> 29
  const K = [0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391];
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const w: number[] = new Array(16);
  for (let offset = 0; offset < m.length; offset += 16) {
    for (let i = 0; i < 16; i++) w[i] = m[offset + i] | 0;
    let A = a, B = b, C = c, D = d;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D; D = C; C = B;
      B = (B + rotl((A + F + K[i] + w[g]) | 0, S[i])) | 0;
      A = tmp;
    }
    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  // MD5 digests each 32-bit word as little-endian bytes.
  const hexLE = (x: number) => {
    const u = x >>> 0;
    return [u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff]
      .map(v => v.toString(16).padStart(2, '0')).join('');
  };
  return hexLE(a) + hexLE(b) + hexLE(c) + hexLE(d);
}

function calSign(body: string, ts: string, randStr: string): string {
  const encoded = encodeURIComponent(body);
  const sorted = encoded.split('').sort().join('');
  const b64 = btoa(sorted); // sorted is ASCII, so btoa is safe
  const res = md5hex(b64) + md5hex(`${ts}:${randStr}`);
  return md5hex(res).toUpperCase();
}

interface PersonalItem {
  fileId: string;
  name: string;
  size: number;
  type: string; // folder / file
  updatedAt: string;
  createdAt: string;
  thumbnails?: { style: string; url: string }[];
}

interface PersonalListResp {
  success: boolean;
  message?: string;
  data: { nextPageCursor: string; items: PersonalItem[] };
}

/**
 * 中国移动云盘 Driver Implementation
 */
export class Yun139Driver implements Driver {
  private authorization = '';
  private account = '';
  private personalHost = '';
  private cfg: Record<string, any> = {};

  config(): DriverConfig {
    return yun139Config;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    if (!cfg.authorization) {
      throw new Error('139: authorization is empty (username/password login is not ported)');
    }
    this.authorization = cfg.authorization;
    await this.refreshToken();
    await this.queryRoutePolicy();
  }

  private async refreshToken(): Promise<void> {
    const decoded = atob(this.authorization);
    const splits = decoded.split(':');
    if (splits.length < 3) throw new Error('139: authorization is invalid');
    this.account = splits[1];
    const tokenParts = splits[2].split('|');
    if (tokenParts.length < 4) throw new Error('139: authorization is invalid');
    const expiration = Number(tokenParts[3]);
    const remaining = expiration - Date.now();
    if (remaining > 1000 * 60 * 60 * 24 * 15) return; // more than 15 days left
    if (remaining < 0) throw new Error('139: authorization has expired');
    // Refresh through the tellin endpoint (only when close to expiry).
    const xml = `<root><token>${splits[2]}</token><account>${splits[1]}</account><clienttype>656</clienttype></root>`;
    const resp = await fetch('https://aas.caiyun.feixin.10086.cn:443/tellin/authTokenRefresh.do', {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: xml,
    });
    const text = await resp.text();
    const m = text.match(/<token>([^<]+)<\/token>/);
    if (!m) throw new Error('139: failed to refresh token, please update authorization');
    this.authorization = btoa(`${splits[0]}:${splits[1]}:${m[1]}`);
  }

  private async queryRoutePolicy(): Promise<void> {
    const data = {
      userInfo: { userType: 1, accountType: 1, accountName: this.account },
      modAddrType: 1,
    };
    const resp = await this.post('https://user-njs.yun.139.com/user/route/qryRoutePolicy', data, true);
    const list = resp?.data?.routePolicyList || [];
    for (const item of list) {
      if (item.modName === 'personal') this.personalHost = item.httpsUrl;
    }
    if (!this.personalHost) throw new Error('139: PersonalCloudHost is empty');
  }

  private async post(url: string, body: unknown, route = false): Promise<any> {
    const randStr = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    const ts = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const bodyStr = JSON.stringify(body);
    const sign = calSign(bodyStr, ts, randStr);
    const headers: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'CMS-DEVICE': 'default',
      'Authorization': `Basic ${this.authorization}`,
      'mcloud-channel': '1000101',
      'mcloud-client': '10701',
      'mcloud-sign': `${ts},${randStr},${sign}`,
      'mcloud-version': '7.14.0',
      'Origin': 'https://yun.139.com',
      'Referer': 'https://yun.139.com/w/',
      'x-DeviceInfo': '||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||',
      'x-huawei-channelSrc': '10000034',
      'x-inner-ntwk': '2',
      'x-m4c-caller': 'PC',
      'x-m4c-src': '10002',
      'x-SvcType': '1',
      'Inner-Hcy-Router-Https': '1',
      'Content-Type': 'application/json',
    };
    if (route) {
      headers['Caller'] = 'web';
      headers['Mcloud-Route'] = '001';
    }
    const resp = await fetch(url, { method: 'POST', headers, body: bodyStr });
    const data: any = await resp.json().catch(() => ({}));
    if (!data.success) {
      throw new Error(data.message || `139: API error (${resp.status})`);
    }
    return data;
  }

  private personalPost(pathname: string, body: unknown): Promise<any> {
    return this.post(this.personalHost + pathname, body);
  }

  private async getFiles(parentId: string): Promise<PersonalItem[]> {
    const files: PersonalItem[] = [];
    let cursor = '';
    for (;;) {
      const resp = await this.personalPost('/file/list', {
        imageThumbnailStyleList: ['Small', 'Large'],
        orderBy: 'updated_at',
        orderDirection: 'DESC',
        pageInfo: { pageCursor: cursor, pageSize: 100 },
        parentFileId: parentId,
      }) as PersonalListResp;
      files.push(...(resp.data?.items || []));
      cursor = resp.data?.nextPageCursor || '';
      if (!cursor) break;
    }
    return files;
  }

  private itemToObj(it: PersonalItem): Obj {
    const common = {
      name: it.name,
      modified: it.updatedAt ? new Date(it.updatedAt).toISOString() : new Date().toISOString(),
      created: it.createdAt ? new Date(it.createdAt).toISOString() : undefined,
      id: it.fileId,
      thumb: it.thumbnails?.length ? it.thumbnails[it.thumbnails.length - 1].url : undefined,
    };
    return it.type === 'folder' ? createDirObj(common) : createFileObj({ ...common, size: it.size || 0 });
  }

  private async getFileIdByPath(path: string): Promise<string> {
    const root = this.cfg.root_folder_id || '/';
    const parts = path.split('/').filter(p => p);
    let currentId = root;
    for (const part of parts) {
      const files = await this.getFiles(currentId);
      const found = files.find(f => f.name === part);
      if (!found) throw new Error(`139: path not found: ${path}`);
      currentId = found.fileId;
    }
    return currentId;
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const parentId = await this.getFileIdByPath(path);
    const files = await this.getFiles(parentId);
    const content = files.map(f => this.itemToObj(f));
    return { content, total: content.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const id = await this.getFileIdByPath(path);
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    const files = await this.getFiles(await this.getFileIdByPath(parent));
    const found = files.find(f => f.fileId === id);
    if (found) return this.itemToObj(found);
    const name = path.split('/').pop() || path;
    return createFileObj({ name, modified: new Date().toISOString(), id });
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const fileId = await this.getFileIdByPath(path);
    const resp = await this.personalPost('/file/getDownloadUrl', { fileId });
    const data = resp?.data || {};
    if (data.cdnUrl && data.cdnSwitch) {
      return { url: data.cdnUrl };
    }
    if (!data.url) throw new Error('139: failed to get download url');
    return { url: data.url };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('139: mkdir not ported');
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('139: rename not ported');
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('139: copy not ported');
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('139: move not ported');
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('139: remove not ported');
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('139: upload not ported');
  }
}

registerDriver(Yun139Driver, yun139Config, yun139Additional);
