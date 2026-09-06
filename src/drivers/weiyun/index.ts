/**
 * 腾讯微云 (Weiyun) Driver — writable
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/weiyun (itself a TS re-port of OpenList drivers/weiyun +
 * github.com/foxxorcat/weiyun-sdk-go).
 *
 * Cookie-authenticated JSON protocol over https://www.weiyun.com. Cookies are
 * refreshed in place (refreshCtoken / weixin refresh / 403 retry) inside the
 * client; no DB persistence. IncrementalSha1 / base64 helpers are inlined.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const weiyunConfig: DriverConfig = {
  name: 'Weiyun',
  label: '腾讯微云',
  local_sort: false,
  only_proxy: true,
  no_cache: false,
  no_upload: false,
  default_root: '',
};

export const weiyunAdditional: DriverItem[] = [
  { name: 'root_folder_id', type: 'string', default: '', options: '', required: false, help: '根文件夹 ID，留空自动获取' },
  { name: 'cookies', type: 'text', default: '', options: '', required: true, help: '登录 Cookie（从浏览器复制）' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,size,updated_at', required: false, help: '排序字段' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: '排序方向' },
  { name: 'upload_thread', type: 'string', default: '4', options: '', required: false, help: '上传并发通道数（4<=thread<=32）' },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UPLOAD_CHUNK_SIZE = 1024 * 1024; // 1MB per chunk

// ---------------------------------------------------------------- types

interface WeiyunFile {
  file_id: string;
  filename: string;
  file_size: number;
  file_sha?: string;
  file_ctime?: number | string;
  file_mtime?: number | string;
  ext_info?: { thumb_url?: string };
  pdir_key?: string;
}

interface WeiyunFolder {
  dir_key: string;
  dir_name: string;
  dir_ctime?: number | string;
  dir_mtime?: number | string;
  pdir_key?: string;
}

interface WeiyunFolderPath {
  pdir_key: string;
  dir_key: string;
  dir_name: string;
}

interface DiskListData {
  dir_list?: WeiyunFolder[];
  file_list?: WeiyunFile[];
  finish_flag?: boolean;
}

interface DiskUserInfoGetData {
  root_dir_key?: string;
  main_dir_key?: string;
}

interface DiskFileDownloadData {
  cookie_name: string;
  cookie_value: string;
  download_url: string;
}

interface PreUploadData {
  file_exist: boolean;
  common_upload_rsp?: WeiyunFile;
  upload_key?: string;
  ex?: string;
  channel_list?: UploadChannelData[];
}

interface AddChannelData {
  channels?: UploadChannelData[];
}

interface UploadPieceData {
  channel?: UploadChannelData;
  upload_state?: number; // 1: not finished, 2: finished
}

interface UploadChannelData {
  id: number;
  offset: number;
  len: number;
}

interface FolderParam {
  ppdir_key?: string;
  pdir_key?: string;
  dir_key?: string;
  dir_name?: string;
}

interface FileParam {
  ppdir_key?: string;
  pdir_key?: string;
  file_id?: string;
  filename?: string;
}

type AccountType = 'qq' | 'weixin' | 'weixin_openid' | 'qq_openid' | 'unknown';

// ---------------------------------------------------------------- crypto helpers

function rotl(n: number, s: number): number {
  return (n << s) | (n >>> (32 - s));
}

/** Incremental SHA-1 whose internal state can be snapshotted as hex (Go-compatible). */
class IncrementalSha1 {
  private h0 = 0x67452301;
  private h1 = 0xefcdab89;
  private h2 = 0x98badcfe;
  private h3 = 0x10325476;
  private h4 = 0xc3d2e1f0;

  private block = new Uint8Array(64);
  private blockLen = 0;
  private totalBytes = 0;
  private w = new Int32Array(80);

  update(data: Uint8Array): this {
    const len = data.length;
    this.totalBytes += len;

    let offset = 0;
    while (offset < len) {
      const needed = 64 - this.blockLen;
      const toCopy = Math.min(needed, len - offset);
      this.block.set(data.subarray(offset, offset + toCopy), this.blockLen);
      this.blockLen += toCopy;
      offset += toCopy;

      if (this.blockLen === 64) {
        this.processBlock(this.block);
        this.blockLen = 0;
      }
    }
    return this;
  }

  private processBlock(block: Uint8Array): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const idx = i * 4;
      w[i] =
        (block[idx] << 24) |
        (block[idx + 1] << 16) |
        (block[idx + 2] << 8) |
        block[idx + 3];
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;

    for (let i = 0; i < 80; i++) {
      let f = 0;
      let k = 0;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
  }

  /** Returns current internal state as hex (little-endian per 32-bit word). */
  getStateHex(): string {
    const words = [this.h0, this.h1, this.h2, this.h3, this.h4];
    let hex = '';
    for (const w of words) {
      const b0 = (w & 0xff).toString(16).padStart(2, '0');
      const b1 = ((w >>> 8) & 0xff).toString(16).padStart(2, '0');
      const b2 = ((w >>> 16) & 0xff).toString(16).padStart(2, '0');
      const b3 = ((w >>> 24) & 0xff).toString(16).padStart(2, '0');
      hex += b0 + b1 + b2 + b3;
    }
    return hex.toLowerCase();
  }

  /** Finalize and calculate standard SHA-1 hex digest without corrupting the state. */
  digestHex(): string {
    const clone = new IncrementalSha1();
    clone.h0 = this.h0;
    clone.h1 = this.h1;
    clone.h2 = this.h2;
    clone.h3 = this.h3;
    clone.h4 = this.h4;
    clone.block.set(this.block);
    clone.blockLen = this.blockLen;
    clone.totalBytes = this.totalBytes;

    const padLen =
      clone.blockLen < 56 ? 56 - clone.blockLen : 120 - clone.blockLen;
    const pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;

    const totalBits = clone.totalBytes * 8;
    const hiBits = Math.floor(clone.totalBytes / 0x20000000);
    const loBits = (totalBits & 0xffffffff) >>> 0;

    const view = new DataView(pad.buffer, pad.byteOffset + padLen, 8);
    view.setUint32(0, hiBits, false);
    view.setUint32(4, loBits, false);

    clone.update(pad);

    const h = [clone.h0, clone.h1, clone.h2, clone.h3, clone.h4];
    return h
      .map(val => (val >>> 0).toString(16).padStart(8, '0'))
      .join('')
      .toLowerCase();
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------- cookie helpers

function parseCookieStr(str: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!str) return map;

  const parts = str.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && val) {
        map.set(key, val);
      }
    }
  }
  return map;
}

function cookieToString(cookies: Map<string, string>): string {
  const pairs: string[] = [];
  for (const [key, val] of cookies.entries()) {
    if (key && val) {
      pairs.push(`${key}=${val}`);
    }
  }
  return pairs.join('; ');
}

// ---------------------------------------------------------------- client

class WeiyunClient {
  private cookies = new Map<string, string>();

  constructor(cookieStr: string) {
    this.cookies = parseCookieStr(cookieStr || '');
  }

  getCookieStr(): string {
    return cookieToString(this.cookies);
  }

  private updateCookiesFromHeaders(headers: Headers): void {
    const getSetCookie = (headers as any).getSetCookie;
    let rawSetCookies: string[] = [];
    if (typeof getSetCookie === 'function') {
      rawSetCookies = getSetCookie.call(headers);
    } else {
      const single = headers.get('set-cookie');
      if (single) rawSetCookies = [single];
    }

    for (const sc of rawSetCookies) {
      const firstPart = sc.split(';')[0] || '';
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx > 0) {
        const key = firstPart.slice(0, eqIdx).trim();
        const val = firstPart.slice(eqIdx + 1).trim();
        if (key && val) {
          this.cookies.set(key, val);
        }
      }
    }
  }

  loginType(): AccountType {
    const wyUf = this.cookies.get('wy_uf') || '';
    const wxOpenId = this.cookies.get('weiyun_wx_openid') || '';
    const qqOpenId = this.cookies.get('weiyun_qq_openid') || '';

    if (wyUf === '2' && wxOpenId) return 'weixin_openid';
    if (wyUf === '2' && qqOpenId) return 'qq_openid';
    if (wyUf === '1') return 'weixin';
    if (wyUf === '0' || !wyUf) return 'qq';
    return 'unknown';
  }

  parseTokenInfo(): Record<string, any> {
    const type = this.loginType();
    switch (type) {
      case 'weixin':
        return {
          token_type: 1,
          openid: this.cookies.get('openid') || '',
          open_appid: this.cookies.get('wy_appid') || '',
          access_token: this.cookies.get('access_token') || '',
          login_key_type: 192,
          login_key_value: this.cookies.get('access_token') || '',
        };
      case 'qq':
        return {
          token_type: 0,
          login_key_type: 27,
          login_key_value: this.cookies.get('p_skey') || this.cookies.get('skey') || '',
          openid: '',
        };
      case 'weixin_openid':
      case 'qq_openid':
        return {
          token_type: 3,
          login_key_type: 1540,
        };
      default:
        return {};
    }
  }

  async refreshCtoken(): Promise<void> {
    const resp = await fetch('https://www.weiyun.com/disk', {
      headers: {
        'User-Agent': UA,
        Cookie: this.getCookieStr(),
      },
      redirect: 'manual',
    });
    this.updateCookiesFromHeaders(resp.headers);
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location') || '';
      if (loc && !loc.includes('/disk')) {
        throw new Error(
          '[WeiYun] Login cookie expired or invalid, please login again',
        );
      }
    }
  }

  async weixinRefreshToken(): Promise<void> {
    const appid = this.cookies.get('wy_appid') || '';
    const refreshToken = this.cookies.get('refresh_token') || '';
    if (!appid || !refreshToken) return;

    const url = `https://api.weixin.qq.com/sns/oauth2/refresh_token?grant_type=refresh_token&appid=${encodeURIComponent(appid)}&refresh_token=${encodeURIComponent(refreshToken)}`;
    const res = await fetch(url);
    const data: any = await res.json().catch(() => ({}));
    if (data.errcode) {
      throw new Error(`[WeiYun] WeChat refresh token failed: ${data.errmsg}`);
    }
    if (data.openid) this.cookies.set('openid', data.openid);
    if (data.access_token) this.cookies.set('access_token', data.access_token);
    if (data.refresh_token) this.cookies.set('refresh_token', data.refresh_token);
  }

  private newHeader(cmd: number, tokenInfo: Record<string, any>): Record<string, any> {
    const wx_openid = tokenInfo.openid || tokenInfo.minico_openid || '';
    return {
      seq: Math.floor(Date.now() / 1000),
      cmd,
      wx_openid,
      qq_openid: tokenInfo.qq_openid || '',
      user_flag: tokenInfo.token_type ?? 0,
      env_id: tokenInfo.env_id || '',
      type: 1,
      appid: 30013,
      version: 3,
      major_version: 3,
      minor_version: 3,
      fix_version: 3,
    };
  }

  private newBody(cmdName: string, data: any, tokenInfo: Record<string, any>): Record<string, any> {
    return {
      ReqMsg_body: {
        ext_req_head: {
          token_info: tokenInfo,
          language_info: {
            language_type: 2052,
          },
        },
        [`.weiyun.${cmdName}MsgReq_body`]: data,
      },
    };
  }

  private newUploadJson(cmdName: string, cmd: number, data: any): Record<string, any> {
    return {
      req_header: {
        cmd,
        appid: 30013,
        major_version: 3,
        minor_version: 0,
        fix_version: 0,
        version: 3,
        user_flag: 0,
      },
      req_body: {
        ReqMsg_body: {
          [`weiyun.${cmdName}MsgReq_body`]: data,
        },
      },
    };
  }

  async request(
    protocol:
      | 'weiyunQdisk'
      | 'weiyunQdiskClient'
      | 'weiyunFileLibClient'
      | 'preUpload'
      | 'upload',
    cmdName: string,
    cmd: number,
    data: any,
    fileBuffer?: Uint8Array,
  ): Promise<any> {
    const tokenInfo = this.parseTokenInfo();
    const wyctoken = this.cookies.get('wyctoken') || '';

    let url = '';
    let body: any;
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Referer: 'https://www.weiyun.com',
      Cookie: this.getCookieStr(),
    };

    if (protocol === 'preUpload') {
      url = `https://www.weiyun.com/api/v3/ftn_pre_upload?g_tk=${encodeURIComponent(wyctoken)}&cmd=${cmd}`;
      body = JSON.stringify(this.newUploadJson(cmdName, cmd, data));
      headers['Content-Type'] = 'application/json; charset=UTF-8';
    } else if (protocol === 'upload') {
      url = `https://upload.weiyun.com/ftnup_v2/weiyun?g_tk=${encodeURIComponent(wyctoken)}&cmd=${cmd}`;
      const boundary = '----WebKitFormBoundaryIifrOqiswelC8nfe';
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;

      const uploadJson = JSON.stringify(this.newUploadJson(cmdName, cmd, data));
      const part1 = `--${boundary}\r\nContent-Disposition: form-data; name="json"\r\n\r\n${uploadJson}\r\n`;
      let part2 = '';
      if (fileBuffer && fileBuffer.length > 0) {
        part2 = `--${boundary}\r\nContent-Disposition: form-data; name="upload"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`;
      }
      const part3 = `\r\n--${boundary}--\r\n`;

      const enc = new TextEncoder();
      const p1Bytes = enc.encode(part1);
      const p2Bytes = fileBuffer ? enc.encode(part2) : new Uint8Array(0);
      const p3Bytes = enc.encode(part3);
      const fbBytes = fileBuffer || new Uint8Array(0);

      const fullLen =
        p1Bytes.length + p2Bytes.length + fbBytes.length + p3Bytes.length;
      const fullBuffer = new Uint8Array(fullLen);
      let offset = 0;
      fullBuffer.set(p1Bytes, offset);
      offset += p1Bytes.length;
      if (p2Bytes.length > 0) {
        fullBuffer.set(p2Bytes, offset);
        offset += p2Bytes.length;
        fullBuffer.set(fbBytes, offset);
        offset += fbBytes.length;
      }
      fullBuffer.set(p3Bytes, offset);

      body = fullBuffer;
    } else {
      url = `https://www.weiyun.com/webapp/json/${protocol}/${cmdName}?g_tk=${encodeURIComponent(wyctoken)}&cmd=${cmd}`;
      body = JSON.stringify({
        req_header: JSON.stringify(this.newHeader(cmd, tokenInfo)),
        req_body: JSON.stringify(this.newBody(cmdName, data, tokenInfo)),
      });
      headers['Content-Type'] = 'application/json; charset=UTF-8';
    }

    let resp = await fetch(url, {
      method: 'POST',
      headers,
      body,
    });
    this.updateCookiesFromHeaders(resp.headers);

    // Handle 403 / auth error
    if (resp.status === 403) {
      try {
        await this.refreshCtoken();
        if (
          this.loginType() === 'weixin' ||
          this.loginType() === 'weixin_openid'
        ) {
          await this.weixinRefreshToken().catch(() => {});
          await this.refreshCtoken();
        }
        headers.Cookie = this.getCookieStr();
        headers['g_tk'] = this.cookies.get('wyctoken') || '';
        resp = await fetch(url, { method: 'POST', headers, body });
        this.updateCookiesFromHeaders(resp.headers);
      } catch (err: any) {
        throw new Error(`[WeiYun] Request failed (403): ${err.message}`);
      }
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`[WeiYun] HTTP ${resp.status}: ${errText}`);
    }

    const rawJson: any = await resp.json().catch(() => ({}));
    const rawResult = rawJson.data || rawJson.result;

    if (rawJson.ret !== undefined && rawJson.ret !== 0) {
      throw new Error(
        `[WeiYun] Error (${rawJson.ret}): ${rawJson.msg || 'Unknown'}`,
      );
    }

    if (rawResult?.rsp_header && rawResult.rsp_header.retcode !== 0) {
      const h = rawResult.rsp_header;
      throw new Error(
        `[WeiYun] Cmd ${h.cmd} (${h.cmdName || cmdName}) Error (${h.retcode}): ${h.retmsg || 'Unknown error'}`,
      );
    }

    if (protocol === 'preUpload') {
      return (
        rawResult?.rsp_body?.RspMsg_body?.weiyunPreUploadMsgRsp_body || rawJson
      );
    }
    if (protocol === 'upload') {
      return (
        rawResult?.rsp_body?.RspMsg_body?.[`weiyun.${cmdName}MsgRsp_body`] ||
        rawJson
      );
    }

    const bodyMsg = rawResult?.rsp_body?.RspMsg_body;
    if (typeof bodyMsg === 'string') {
      try {
        return JSON.parse(bodyMsg);
      } catch {
        return bodyMsg;
      }
    }
    return bodyMsg || rawResult || rawJson;
  }

  async diskUserInfoGet(): Promise<DiskUserInfoGetData> {
    return this.request('weiyunQdiskClient', 'DiskUserInfoGet', 2201, {
      is_get_upload_flow_flag: false,
      is_get_high_speed_flow_info: false,
      is_get_weiyun_flag: false,
      is_get_space_clean_info: false,
      is_get_user_reward_info: false,
    });
  }

  async libDirPathGet(dirKey: string): Promise<WeiyunFolderPath[]> {
    const res = await this.request(
      'weiyunFileLibClient',
      'LibDirPathGet',
      26150,
      { dir_key: dirKey },
    );
    return res.items || [];
  }

  async diskDirFileList(
    dirKey: string,
    opts: {
      start?: number;
      count?: number;
      sortField?: number; // 1: FileName, 2: FileMtime, 3: FileSize
      reverseOrder?: boolean;
      getType?: number; // 0: FileAndDir, 1: OnlyDir, 2: OnlyFile
    } = {},
  ): Promise<DiskListData> {
    return this.request('weiyunQdisk', 'DiskDirList', 2208, {
      dir_key: dirKey,
      start: opts.start || 0,
      count: opts.count || 500,
      sort_field: opts.sortField ?? 2,
      reverse_order: opts.reverseOrder ?? false,
      get_type: opts.getType ?? 0,
      get_abstract_url: false,
      get_dir_detail_info: false,
    });
  }

  async diskFileDownload(fParam: FileParam): Promise<DiskFileDownloadData> {
    const res = await this.request(
      'weiyunQdiskClient',
      'DiskFileBatchDownload',
      2402,
      {
        file_list: [fParam],
        download_type: 0,
      },
    );
    const list: DiskFileDownloadData[] = res.file_list || [];
    if (!list || list.length === 0) {
      throw new Error('[WeiYun] No download link returned');
    }
    return list[0];
  }

  async diskDirCreate(dParam: FolderParam): Promise<void> {
    await this.request('weiyunQdiskClient', 'DiskDirCreate', 2614, {
      ppdir_key: dParam.ppdir_key,
      pdir_key: dParam.pdir_key,
      dir_name: dParam.dir_name,
      file_exist_option: 2,
      create_type: 1,
    });
  }

  async diskFileRename(fParam: FileParam, newName: string): Promise<void> {
    await this.request('weiyunQdiskClient', 'DiskFileRename', 2605, {
      ppdir_key: fParam.ppdir_key,
      pdir_key: fParam.pdir_key,
      file_id: fParam.file_id,
      src_filename: fParam.filename,
      filename: newName,
    });
  }

  async diskDirAttrModify(dParam: FolderParam, newName: string): Promise<void> {
    await this.request('weiyunQdiskClient', 'DiskDirAttrModify', 2615, {
      ppdir_key: dParam.ppdir_key,
      pdir_key: dParam.pdir_key,
      dir_key: dParam.dir_key,
      src_dir_name: dParam.dir_name,
      dst_dir_name: newName,
    });
  }

  async diskFileDelete(fParam: FileParam): Promise<void> {
    await this.request('weiyunQdiskClient', 'DiskDirFileBatchDeleteEx', 2509, {
      file_list: [fParam],
    });
  }

  async diskDirDelete(dParam: FolderParam): Promise<void> {
    await this.request('weiyunQdiskClient', 'DiskDirFileBatchDeleteEx', 2509, {
      dir_list: [dParam],
    });
  }

  async diskFileMove(srcParam: FileParam, dstParam: FolderParam): Promise<void> {
    await this.request('weiyunQdiskClient', 'DiskDirFileBatchMove', 2618, {
      src_ppdir_key: srcParam.ppdir_key,
      src_pdir_key: srcParam.pdir_key,
      file_list: [srcParam],
      dst_ppdir_key: dstParam.pdir_key,
      dst_pdir_key: dstParam.dir_key,
    });
  }

  async diskDirMove(srcParam: FolderParam, dstParam: FolderParam): Promise<void> {
    await this.request('weiyunQdiskClient', 'DiskDirFileBatchMove', 2618, {
      src_ppdir_key: srcParam.ppdir_key,
      src_pdir_key: srcParam.pdir_key,
      dir_list: [srcParam],
      dst_ppdir_key: dstParam.pdir_key,
      dst_pdir_key: dstParam.dir_key,
    });
  }

  // ---- Upload APIs ----

  async preUpload(
    pdirKey: string,
    dirKey: string,
    fileName: string,
    fileSize: number,
    content: Uint8Array,
    channelCount = 4,
    fileExistOption = 1,
  ): Promise<PreUploadData> {
    const blockSize = 1024 * 1024;
    let beforeBlockSize = 0;
    let lastBlockSize = fileSize;
    let checkBlockSize = 0;

    if (fileSize > 0) {
      lastBlockSize = fileSize % blockSize;
      if (lastBlockSize === 0) lastBlockSize = blockSize;
      checkBlockSize = lastBlockSize % 128;
      if (checkBlockSize === 0) checkBlockSize = 128;
      beforeBlockSize = fileSize - lastBlockSize;
    }

    interface BlockInfo {
      sha: string;
      offset: number;
      size: number;
    }

    const blockInfoList: BlockInfo[] = [];
    const sha = new IncrementalSha1();

    for (let offset = 0; offset < beforeBlockSize; offset += blockSize) {
      const slice = content.subarray(offset, offset + blockSize);
      sha.update(slice);
      blockInfoList.push({
        sha: sha.getStateHex(),
        offset,
        size: blockSize,
      });
    }

    const checkPointSlice = content.subarray(
      beforeBlockSize,
      beforeBlockSize + lastBlockSize - checkBlockSize,
    );
    sha.update(checkPointSlice);
    const checkSha = sha.getStateHex();

    const checkDataSlice = content.subarray(
      beforeBlockSize + lastBlockSize - checkBlockSize,
      fileSize,
    );
    sha.update(checkDataSlice);
    const checkData = uint8ArrayToBase64(checkDataSlice);
    const fileHash = sha.digestHex();

    blockInfoList.push({
      sha: fileHash,
      offset: beforeBlockSize,
      size: lastBlockSize,
    });

    const reqData = {
      common_upload_req: {
        ppdir_key: pdirKey,
        pdir_key: dirKey,
        file_size: fileSize,
        filename: fileName,
        file_exist_option: fileExistOption,
        use_mutil_channel: true,
      },
      upload_scr: 0,
      channel_count: channelCount,
      block_size: blockSize,
      check_sha: checkSha,
      check_data: checkData,
      block_info_list: blockInfoList,
    };

    const res: PreUploadData = await this.request(
      'preUpload',
      'PreUpload',
      247120,
      reqData,
    );
    if (res.common_upload_rsp) {
      res.common_upload_rsp.file_sha = fileHash;
      res.common_upload_rsp.file_size = fileSize;
    }
    return res;
  }

  async addUploadChannel(
    origCount: number,
    destCount: number,
    auth: { upload_key: string; ex: string },
  ): Promise<AddChannelData> {
    return this.request('upload', 'AddChannel', 247122, {
      upload_key: auth.upload_key,
      ex: auth.ex,
      orig_channel_count: origCount,
      dest_channel_count: destCount,
      speed: 4303,
    });
  }

  async uploadPiece(
    channel: UploadChannelData,
    auth: { upload_key: string; ex: string },
    chunk: Uint8Array,
  ): Promise<UploadPieceData> {
    const res: UploadPieceData = await this.request(
      'upload',
      'UploadPiece',
      247121,
      {
        upload_key: auth.upload_key,
        ex: auth.ex,
        channel,
      },
      chunk,
    );

    if (res.channel && res.channel.len === 0 && res.upload_state === 1) {
      res.channel.len = channel.len;
    }
    return res;
  }
}

// ---------------------------------------------------------------- driver helpers

function parseWeiyunDate(timeVal?: number | string): string {
  if (!timeVal) return new Date().toISOString();
  try {
    const num = typeof timeVal === 'string' ? parseInt(timeVal, 10) : timeVal;
    if (!isNaN(num) && num > 0) {
      // If unix seconds (10 digits) vs millis (13 digits)
      const ms = num < 10000000000 ? num * 1000 : num;
      return new Date(ms).toISOString();
    }
    const d = new Date(timeVal);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch {
    // fallthrough
  }
  return new Date().toISOString();
}

function weiyunFolderToObj(folder: WeiyunFolder): Obj {
  return createDirObj({
    name: folder.dir_name,
    modified: parseWeiyunDate(folder.dir_mtime || folder.dir_ctime),
    id: folder.dir_key,
  });
}

function weiyunFileToObj(file: WeiyunFile): Obj {
  return createFileObj({
    name: file.filename,
    size: file.file_size || 0,
    modified: parseWeiyunDate(file.file_mtime || file.file_ctime),
    thumb: file.ext_info?.thumb_url || undefined,
    id: file.file_id,
  });
}

function normalizeAddition(a: any): Record<string, any> {
  const norm = { ...(a || {}) } as any;
  norm.root_folder_id = (norm.root_folder_id || '').trim();
  norm.cookies = (norm.cookies || '').trim();
  norm.order_by = norm.order_by || 'name';
  norm.order_direction = norm.order_direction || 'asc';
  norm.upload_thread = norm.upload_thread || '4';
  return norm;
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
    } else if (key.includes('time') || key.includes('updated') || key.includes('modified')) {
      cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
    } else {
      cmp = String(a.name).localeCompare(String(b.name));
    }
    return asc ? cmp : -cmp;
  });
  return sorted;
}

interface ResolvedFolderInfo {
  dirKey: string;
  pdirKey: string;
  dirName: string;
}

// ---------------------------------------------------------------- driver

export class WeiyunDriver implements Driver {
  private cfg: Record<string, any> = {};
  private client: WeiyunClient = new WeiyunClient('');
  private rootFolderId = '';
  private rootPdirKey = '';
  private uploadThreads = 4;
  private pathFolderCache = new Map<string, ResolvedFolderInfo>();

  config(): DriverConfig {
    return weiyunConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = normalizeAddition(cfg);
    this.client = new WeiyunClient(this.cfg.cookies || '');
    this.pathFolderCache = new Map<string, ResolvedFolderInfo>();

    const threadNum = parseInt(this.cfg.upload_thread || '4', 10);
    this.uploadThreads = Math.min(
      32,
      Math.max(4, isNaN(threadNum) ? 4 : threadNum),
    );
    this.cfg.upload_thread = String(this.uploadThreads);

    await this.client.refreshCtoken();

    if (!this.cfg.root_folder_id) {
      const userInfo = await this.client.diskUserInfoGet();
      this.rootFolderId = userInfo.main_dir_key || userInfo.root_dir_key || '';
      this.cfg.root_folder_id = this.rootFolderId;
    } else {
      this.rootFolderId = this.cfg.root_folder_id;
    }

    if (!this.rootFolderId) {
      throw new Error('[WeiYun] Failed to obtain root folder ID');
    }

    const folders = await this.client.libDirPathGet(this.rootFolderId);
    if (!folders || folders.length === 0) {
      throw new Error(
        `[WeiYun] Invalid root directory ID: ${this.rootFolderId}`,
      );
    }

    const last = folders[folders.length - 1];
    this.rootPdirKey = last.pdir_key || '';
    this.pathFolderCache.set('/', {
      dirKey: this.rootFolderId,
      pdirKey: this.rootPdirKey,
      dirName: last.dir_name || 'root',
    });
  }

  private async resolveFolder(physicalPath: string): Promise<ResolvedFolderInfo> {
    const clean =
      '/' +
      String(physicalPath || '')
        .split('/')
        .filter(Boolean)
        .join('/');

    if (clean === '/' || clean === `/${this.rootFolderId}`) {
      return {
        dirKey: this.rootFolderId,
        pdirKey: this.rootPdirKey,
        dirName: 'root',
      };
    }

    if (this.pathFolderCache.has(clean)) {
      return this.pathFolderCache.get(clean)!;
    }

    const segs = clean.split('/').filter(Boolean);
    let current: ResolvedFolderInfo = {
      dirKey: this.rootFolderId,
      pdirKey: this.rootPdirKey,
      dirName: 'root',
    };
    let currentPath = '';

    for (let i = 0; i < segs.length; i++) {
      const rawPart = segs[i];
      const decodedPart = (() => {
        try {
          return decodeURIComponent(rawPart);
        } catch {
          return rawPart;
        }
      })();

      currentPath = '/' + segs.slice(0, i + 1).join('/');
      if (this.pathFolderCache.has(currentPath)) {
        current = this.pathFolderCache.get(currentPath)!;
        continue;
      }

      const listData = await this.client.diskDirFileList(current.dirKey, {
        count: 500,
        getType: 1, // Only directories
      });

      const dirs = listData.dir_list || [];
      const target = dirs.find(
        d =>
          d.dir_name === rawPart ||
          d.dir_name === decodedPart ||
          d.dir_key === rawPart,
      );

      if (!target) {
        throw new Error(
          `[WeiYun] Directory '${rawPart}' not found in folder '${current.dirKey}'`,
        );
      }

      current = {
        dirKey: target.dir_key,
        pdirKey: current.dirKey,
        dirName: target.dir_name,
      };
      this.pathFolderCache.set(currentPath, current);
    }

    return current;
  }

  private async resolveFile(physicalPath: string): Promise<{
    file?: WeiyunFile;
    folder?: WeiyunFolder;
    parent: ResolvedFolderInfo;
    isDir: boolean;
  }> {
    const segs = String(physicalPath || '')
      .split('/')
      .filter(Boolean);
    if (segs.length === 0) throw new Error('[WeiYun] 路径无效');

    const rawName = segs[segs.length - 1];
    const decodedName = (() => {
      try {
        return decodeURIComponent(rawName);
      } catch {
        return rawName;
      }
    })();

    const parentPath = '/' + segs.slice(0, segs.length - 1).join('/');
    const parent = await this.resolveFolder(parentPath);

    const listData = await this.client.diskDirFileList(parent.dirKey, {
      count: 500,
      getType: 0, // File and dir
    });

    const file = (listData.file_list || []).find(
      f =>
        f.filename === rawName ||
        f.filename === decodedName ||
        f.file_id === rawName,
    );
    if (file) {
      return { file, parent, isDir: false };
    }

    const folder = (listData.dir_list || []).find(
      d =>
        d.dir_name === rawName ||
        d.dir_name === decodedName ||
        d.dir_key === rawName,
    );
    if (folder) {
      return { folder, parent, isDir: true };
    }

    throw new Error(`[WeiYun] 文件或目录未找到: ${rawName}`);
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const folderInfo = await this.resolveFolder(path);

    const allFolders: WeiyunFolder[] = [];
    const allFiles: WeiyunFile[] = [];

    let start = 0;
    while (true) {
      const sortField =
        this.cfg.order_by === 'size'
          ? 3
          : this.cfg.order_by === 'updated_at'
            ? 2
            : 1;
      const reverseOrder = this.cfg.order_direction === 'desc';

      const data = await this.client.diskDirFileList(folderInfo.dirKey, {
        start,
        count: 500,
        sortField,
        reverseOrder,
        getType: 0,
      });

      const dirs = data.dir_list || [];
      const files = data.file_list || [];

      for (const d of dirs) {
        d.pdir_key = folderInfo.dirKey;
        allFolders.push(d);
      }
      for (const f of files) {
        f.pdir_key = folderInfo.dirKey;
        allFiles.push(f);
      }

      start = allFolders.length + allFiles.length;
      if (data.finish_flag || (dirs.length === 0 && files.length === 0)) {
        break;
      }
    }

    const content: Obj[] = [
      ...allFolders.map(weiyunFolderToObj),
      ...allFiles.map(weiyunFileToObj),
    ];
    return {
      content: sortItems(
        content,
        this.cfg.order_by === 'size'
          ? 'size'
          : this.cfg.order_by === 'updated_at'
            ? 'updated_at'
            : 'name',
        this.cfg.order_direction,
      ),
      total: content.length,
    };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const clean =
      '/' +
      String(path || '')
        .split('/')
        .filter(Boolean)
        .join('/');

    if (clean === '/' || clean === `/${this.rootFolderId}`) {
      return createDirObj({
        name: 'root',
        modified: new Date().toISOString(),
        id: this.rootFolderId,
      });
    }

    const { file, folder, isDir } = await this.resolveFile(path);
    if (isDir && folder) {
      return weiyunFolderToObj(folder);
    }
    if (file) {
      return weiyunFileToObj(file);
    }
    throw new Error(`[WeiYun] 条目未找到: ${path}`);
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const { file, folder, parent, isDir } = await this.resolveFile(path);
    if (isDir || !file) {
      throw new Error(`[WeiYun] 无法获取下载链接: ${path}`);
    }
    const downloadData = await this.client.diskFileDownload({
      ppdir_key: parent.pdirKey,
      pdir_key: parent.dirKey,
      file_id: file.file_id,
      filename: file.filename,
    });
    return {
      url: downloadData.download_url,
      header: {
        Cookie: `${downloadData.cookie_name}=${downloadData.cookie_value}`,
      },
    };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const parts = String(path || '')
      .split('/')
      .filter(Boolean);
    const dirName = parts.pop() || '新建文件夹';
    const parentPath = '/' + parts.join('/');
    const parent = await this.resolveFolder(parentPath);

    await this.client.diskDirCreate({
      ppdir_key: parent.pdirKey,
      pdir_key: parent.dirKey,
      dir_name: dirName,
    });
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const { file, folder, parent, isDir } = await this.resolveFile(path);
    if (isDir && folder) {
      await this.client.diskDirAttrModify(
        {
          ppdir_key: parent.pdirKey,
          pdir_key: parent.dirKey,
          dir_key: folder.dir_key,
          dir_name: folder.dir_name,
        },
        newName,
      );
    } else if (file) {
      await this.client.diskFileRename(
        {
          ppdir_key: parent.pdirKey,
          pdir_key: parent.dirKey,
          file_id: file.file_id,
          filename: file.filename,
        },
        newName,
      );
    }
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const { file, folder, parent, isDir } = await this.resolveFile(path);
    if (isDir && folder) {
      await this.client.diskDirDelete({
        ppdir_key: parent.pdirKey,
        pdir_key: parent.dirKey,
        dir_key: folder.dir_key,
        dir_name: folder.dir_name,
      });
    } else if (file) {
      await this.client.diskFileDelete({
        ppdir_key: parent.pdirKey,
        pdir_key: parent.dirKey,
        file_id: file.file_id,
        filename: file.filename,
      });
    }
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const { file, folder, parent: srcParent, isDir } = await this.resolveFile(src);
    const dstParent = await this.resolveFolder(dst.substring(0, dst.lastIndexOf('/')) || '/');

    if (isDir && folder) {
      await this.client.diskDirMove(
        {
          ppdir_key: srcParent.pdirKey,
          pdir_key: srcParent.dirKey,
          dir_key: folder.dir_key,
          dir_name: folder.dir_name,
        },
        {
          pdir_key: dstParent.pdirKey,
          dir_key: dstParent.dirKey,
        },
      );
    } else if (file) {
      await this.client.diskFileMove(
        {
          ppdir_key: srcParent.pdirKey,
          pdir_key: srcParent.dirKey,
          file_id: file.file_id,
          filename: file.filename,
        },
        {
          pdir_key: dstParent.pdirKey,
          dir_key: dstParent.dirKey,
        },
      );
    }
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('[WeiYun] 微云接口不支持复制操作 (Copy not supported)');
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const content = new Uint8Array(file);
    const parts = String(path || '')
      .split('/')
      .filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new Error('[WeiYun] 上传路径无效');

    const parentPath = '/' + parts.join('/');
    const parent = await this.resolveFolder(parentPath);

    const preData = await this.client.preUpload(
      parent.pdirKey,
      parent.dirKey,
      fileName,
      content.length,
      content,
      4,
      1,
    );

    if (preData.file_exist) {
      return; // Fast upload succeeded
    }

    const auth = {
      upload_key: preData.upload_key || '',
      ex: preData.ex || '',
    };

    let channels = preData.channel_list || [];
    if (channels.length === 0) {
      channels = [{ id: 0, offset: 0, len: content.length }];
    }

    for (const ch of channels) {
      let cur = { ...ch };
      while (cur.offset < content.length) {
        const sliceLen = Math.min(
          cur.len || UPLOAD_CHUNK_SIZE,
          content.length - cur.offset,
        );
        const chunk = content.subarray(cur.offset, cur.offset + sliceLen);
        const res = await this.client.uploadPiece(cur, auth, chunk);
        if (res.upload_state === 2) {
          break;
        }
        if (res.channel) {
          cur = res.channel;
        } else {
          cur.offset += sliceLen;
        }
      }
    }
  }
}

registerDriver(WeiyunDriver, weiyunConfig, weiyunAdditional);
