/**
 * 中国联通沃云盘 (WoPan) Driver — writable
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/wopan (a TS re-port of OpenList drivers/wopan).
 *
 * OAuth (refresh_token) authenticated JSON dispatcher against
 * https://panservice.mail.wo.cn. Requests/params and responses are AES-CBC +
 * PKCS7 encrypted and MD5-signed; both are reimplemented inline with
 * crypto.subtle + a pure-JS MD5 (no crypto-js). Tokens are refreshed in place
 * on rsp_code 9999 (no DB persistence).
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const wopanConfig: DriverConfig = {
  name: 'WoPan',
  label: '沃云盘',
  local_sort: true,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '0',
};

export const wopanAdditional: DriverItem[] = [
  { name: 'root_folder_id', type: 'string', default: '0', options: '', required: false, help: '根文件夹 ID，默认 0' },
  { name: 'refresh_token', type: 'text', default: '', options: '', required: true, help: '刷新令牌（必须）' },
  { name: 'family_id', type: 'string', default: '', options: '', required: false, help: '家庭云空间 ID（可选，填了则使用家庭空间）' },
  { name: 'sort_rule', type: 'select', default: 'name_asc', options: 'name_asc,name_desc,time_asc,time_desc,size_asc,size_desc', required: false, help: '服务端排序规则' },
  { name: 'access_token', type: 'string', default: '', options: '', required: false, help: '访问令牌（可留空，通过 refresh_token 刷新）' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,size,modified', required: false, help: '排序字段' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: '排序方向' },
];

// ---------------------------------------------------------------- constants

const DefaultClientID = '1001000021';
const DefaultClientSecret = 'XFmi9GS2hzk98jGX';
const DefaultAppID = '10000001';
const DefaultBaseURL = 'https://panservice.mail.wo.cn';
const DefaultZoneURL = 'https://tjupload.pan.wo.cn';
const DefaultUA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.37';
const DefaultPartSize = 8 * 1024 * 1024; // 8MB

const ChannelAPIUser = 'api-user';
const ChannelWoHome = 'wohome';
const ChannelWoCloud = 'wocloud';

const SpaceTypePersonal = '0';
const SpaceTypeFamily = '1';

const KeyAppQueryUser = 'AppQueryUser';
const KeyAppRefreshToken = 'AppRefreshToken';
const KeyClassifyRule = 'ClassifyRule';
const KeyGetZoneInfo = 'GetZoneInfo';
const KeyFamilyUserCurrentEncode = 'FamilyUserCurrentEncode';
const KeyQueryAllFiles = 'QueryAllFiles';
const KeyGetDownloadUrlV2 = 'GetDownloadUrlV2';
const KeyCreateDirectory = 'CreateDirectory';
const KeyRenameFileOrDirectory = 'RenameFileOrDirectory';
const KeyMoveFile = 'MoveFile';
const KeyCopyFile = 'CopyFile';
const KeyDeleteFile = 'DeleteFile';
const KeyUpload2C = 'upload2C';

const SortRules: Record<string, number> = {
  name_asc: 1,
  name_desc: 2,
  size_asc: 3,
  size_desc: 4,
  time_asc: 5,
  time_desc: 6,
};

const DEFAULT_IV = 'wNSOYIB1k1DjY5lA';

// ---------------------------------------------------------------- types

interface WoPanFile {
  fid: string;
  size?: number;
  createTime: string;
  name: string;
  id: string;
  type: number; // 0: Directory/Folder, 1: File
  thumbUrl?: string;
}

interface QueryAllFilesData {
  files: WoPanFile[];
}

interface GetDownloadUrlV2Data {
  list: Array<{ fid: string; downloadUrl: string }>;
}

interface FamilyUserCurrentEncodeData {
  defaultHomeId?: number | null;
}

interface Upload2CResp {
  code: string;
  data?: { fid: string };
  msg?: string;
}

interface ClassifyRuleData {
  fileTypes?: Record<string, { type: string }>;
}

// ---------------------------------------------------------------- crypto

function md5Hex(input: string): string {
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

function utf8ToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function pkcs7Pad(data: Uint8Array): Uint8Array {
  const padLen = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + padLen);
  out.set(data);
  for (let i = data.length; i < out.length; i++) {
    out[i] = padLen;
  }
  return out;
}

function pkcs7Unpad(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;
  const padLen = data[data.length - 1];
  if (padLen < 1 || padLen > 16 || padLen > data.length) return data;
  return data.subarray(0, data.length - padLen);
}

class WoPanCrypto {
  private key: string = DefaultClientSecret;
  private iv: string = DEFAULT_IV;
  private accessKey: string = '';

  constructor(accessToken?: string) {
    if (accessToken) {
      this.setAccessToken(accessToken);
    }
  }

  setAccessToken(token: string): void {
    if (token && token.length >= 16) {
      this.accessKey = token.slice(0, 16);
    } else if (token) {
      this.accessKey = token;
    }
  }

  private keyBytes(channel: string): Uint8Array {
    const keyStr = channel === ChannelAPIUser ? this.key : this.accessKey || this.key;
    const raw = utf8ToBytes(keyStr);
    // CryptoJS uses the first 16 bytes (zero-padded) for AES-128 when the
    // word-array key is shorter than 16 bytes.
    if (raw.length === 16) return raw;
    const out = new Uint8Array(16);
    out.set(raw.subarray(0, 16));
    return out;
  }

  private async importAesKey(channel: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      'raw',
      this.keyBytes(channel) as BufferSource,
      { name: 'AES-CBC' },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async encrypt(content: string, channel: string): Promise<string> {
    const padded = pkcs7Pad(utf8ToBytes(content));
    const key = await this.importAesKey(channel);
    const iv = utf8ToBytes(this.iv);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: iv as BufferSource },
      key,
      padded as BufferSource,
    );
    return bytesToBase64(new Uint8Array(cipherBuf));
  }

  async decrypt(cipherBase64: string, channel: string): Promise<string> {
    const cipher = base64ToBytes(cipherBase64);
    if (!cipher || cipher.length === 0 || cipher.length % 16 !== 0) {
      return '';
    }
    try {
      const key = await this.importAesKey(channel);
      const iv = utf8ToBytes(this.iv);
      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: iv as BufferSource },
        key,
        cipher as BufferSource,
      );
      return bytesToUtf8(pkcs7Unpad(new Uint8Array(plainBuf)));
    } catch {
      return '';
    }
  }

  calHeader(channel: string, key: string): { key: string; resTime: number; reqSeq: number; channel: string; sign: string; version: string } {
    const resTime = Date.now();
    const reqSeq = Math.floor(Math.random() * 8999) + 100000;
    const version = '';
    const sign = md5Hex(`${key}${resTime}${reqSeq}${channel}${version}`);
    return {
      key,
      resTime,
      reqSeq,
      channel,
      sign,
      version,
    };
  }
}

// ---------------------------------------------------------------- client helpers

function randomChars(length: number): string {
  const charset =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let res = '';
  for (let i = 0; i < length; i++) {
    res += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return res;
}

function formatDateToBatchNo(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${y}${m}${day}${h}${min}${s}`;
}

// ---------------------------------------------------------------- client

class WoPanClient {
  private accessToken: string;
  private refreshTokenValue: string;
  private phone: string = '';
  private zoneURL: string = '';
  private classifyRuleData: ClassifyRuleData | null = null;
  private crypto: WoPanCrypto;

  constructor(accessToken: string, refreshToken: string) {
    this.accessToken = accessToken || '';
    this.refreshTokenValue = refreshToken || '';
    this.crypto = new WoPanCrypto(this.accessToken);
  }

  private setAccessToken(token: string): void {
    this.accessToken = token;
    this.crypto.setAccessToken(token);
  }

  private setRefreshToken(token: string): void {
    this.refreshTokenValue = token;
  }

  async request<T = any>(
    channel: string,
    key: string,
    param: Record<string, any> | null,
    other: Record<string, any> = {},
    retry: boolean = true,
  ): Promise<T> {
    const header = this.crypto.calHeader(channel, key);

    const body: Record<string, any> = { ...other };
    if (param !== null && param !== undefined) {
      const paramStr = JSON.stringify(param);
      body.param = await this.crypto.encrypt(paramStr, channel);
    }

    const headers: Record<string, string> = {
      Origin: 'https://pan.wo.cn',
      Referer: 'https://pan.wo.cn/',
      'User-Agent': DefaultUA,
      'Content-Type': 'application/json;charset=UTF-8',
    };
    if (this.accessToken) {
      headers['Accesstoken'] = this.accessToken;
    }

    const url = `${DefaultBaseURL}/${channel}/dispatcher`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ header, body }),
    });

    if (!res.ok) {
      throw new Error(
        `[WoPan] Request failed with HTTP status: ${res.status} ${res.statusText}`,
      );
    }

    const resJson: any = await res.json().catch(() => null);
    if (!resJson) {
      throw new Error(`[WoPan] Response is not valid JSON from ${key}`);
    }

    if (resJson.STATUS !== '200') {
      throw new Error(
        `[WoPan] Request failed with status: ${resJson.STATUS}, msg: ${resJson.MSG || ''}`,
      );
    }

    const rspCode = resJson.RSP?.RSP_CODE;
    if (rspCode !== '0000') {
      if (channel !== ChannelAPIUser && retry && rspCode === '9999') {
        await this.refreshToken();
        return this.request<T>(channel, key, param, other, false);
      }
      throw new Error(
        `[WoPan] Request failed with rsp_code: ${rspCode}, rsp_desc: ${resJson.RSP?.RSP_DESC || ''}`,
      );
    }

    let data = resJson.RSP?.DATA;
    if (data === undefined || data === null) {
      return {} as T;
    }

    if (typeof data === 'string') {
      let trimmed = data.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        trimmed = trimmed.slice(1, -1);
      }
      const decrypted = await this.crypto.decrypt(trimmed, channel);
      if (decrypted) {
        try {
          return JSON.parse(decrypted) as T;
        } catch {
          return trimmed as unknown as T;
        }
      }
      try {
        return JSON.parse(trimmed) as T;
      } catch {
        return trimmed as unknown as T;
      }
    }

    return data as T;
  }

  private requestApiUser<T = any>(
    key: string,
    param: Record<string, any> | null,
    other: Record<string, any> = {},
  ): Promise<T> {
    return this.request<T>(ChannelAPIUser, key, param, other);
  }

  private requestWoHome<T = any>(
    key: string,
    param: Record<string, any> | null,
    other: Record<string, any> = {},
  ): Promise<T> {
    return this.request<T>(ChannelWoHome, key, param, other);
  }

  async appRefreshToken(): Promise<{ access_token: string; refresh_token: string }> {
    return this.requestApiUser(
      KeyAppRefreshToken,
      {
        refreshToken: this.refreshTokenValue,
        clientSecret: DefaultClientSecret,
      },
      {
        clientId: DefaultClientID,
        secret: true,
      },
    );
  }

  async refreshToken(): Promise<void> {
    const resp = await this.appRefreshToken();
    if (!resp.access_token) {
      throw new Error('[WoPan] Failed to refresh token: empty access_token');
    }
    this.setAccessToken(resp.access_token);
    if (resp.refresh_token) {
      this.setRefreshToken(resp.refresh_token);
    }
  }

  async appQueryUser(): Promise<{ userId: string }> {
    return this.requestApiUser(
      KeyAppQueryUser,
      {
        accessToken: this.accessToken,
      },
      {
        clientId: DefaultClientID,
        secret: true,
      },
    );
  }

  async initPhone(): Promise<void> {
    if (this.phone) return;
    const user = await this.appQueryUser();
    if (user?.userId) {
      this.phone = user.userId;
    }
  }

  async initClassifyRule(): Promise<void> {
    if (this.classifyRuleData) return;
    const rules = await this.requestWoHome<ClassifyRuleData>(
      KeyClassifyRule,
      {},
      { key: true },
    ).catch(() => null);
    if (rules) {
      this.classifyRuleData = rules;
    }
  }

  async initZoneURL(): Promise<void> {
    if (this.zoneURL) return;
    const zone = await this.requestWoHome<{ url: string }>(
      KeyGetZoneInfo,
      { appId: DefaultAppID },
      { key: true },
    ).catch(() => null);
    this.zoneURL = zone?.url || DefaultZoneURL;
  }

  async familyUserCurrentEncode(): Promise<FamilyUserCurrentEncodeData> {
    return this.requestWoHome<FamilyUserCurrentEncodeData>(
      KeyFamilyUserCurrentEncode,
      { clientId: DefaultClientID },
      { secret: true },
    );
  }

  async initData(): Promise<void> {
    if (!this.accessToken && this.refreshTokenValue) {
      await this.refreshToken();
    }
    await this.initPhone().catch(() => {});
    await this.initClassifyRule().catch(() => {});
    await this.initZoneURL().catch(() => {});
  }

  getFileType(filename: string): string {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (!ext) return '5';
    if (this.classifyRuleData?.fileTypes?.[ext]) {
      return this.classifyRuleData.fileTypes[ext].type;
    }
    return '5';
  }

  async queryAllFiles(
    spaceType: string,
    parentDirectoryId: string,
    pageNum: number,
    pageSize: number,
    sortRule: number,
    familyId: string = '',
  ): Promise<QueryAllFilesData> {
    const param: Record<string, any> = {
      spaceType,
      parentDirectoryId,
      pageNum,
      pageSize,
      sortRule,
      clientId: DefaultClientID,
    };
    if (spaceType === SpaceTypeFamily && familyId) {
      param.familyId = familyId;
    }
    return this.requestWoHome<QueryAllFilesData>(KeyQueryAllFiles, param, {
      secret: true,
    });
  }

  async getDownloadUrlV2(fidList: string[]): Promise<GetDownloadUrlV2Data> {
    const param = {
      type: '1',
      fidList,
      clientId: DefaultClientID,
    };
    return this.requestWoHome<GetDownloadUrlV2Data>(
      KeyGetDownloadUrlV2,
      param,
      { secret: true },
    );
  }

  async createDirectory(
    spaceType: string,
    parentDirectoryId: string,
    directoryName: string,
    familyId: string = '',
  ): Promise<void> {
    const param: Record<string, any> = {
      spaceType,
      familyId,
      parentDirectoryId,
      directoryName,
      clientId: DefaultClientID,
    };
    await this.requestWoHome(KeyCreateDirectory, param, { secret: true });
  }

  async renameFileOrDirectory(
    spaceType: string,
    type: number, // 0: dir, 1: file
    id: string,
    name: string,
    familyId: string = '',
  ): Promise<void> {
    const fileType = type === 0 ? '0' : this.getFileType(name);
    const param: Record<string, any> = {
      spaceType,
      type,
      fileType,
      id,
      name,
      clientId: DefaultClientID,
    };
    if (spaceType === SpaceTypeFamily && familyId) {
      param.familyId = familyId;
    }
    await this.requestWoHome(KeyRenameFileOrDirectory, param, { secret: true });
  }

  async moveFile(
    dirList: string[],
    fileList: string[],
    targetDirId: string,
    sourceType: string,
    targetType: string,
    fromFamilyId: string = '',
    targetFamilyId: string = '',
  ): Promise<void> {
    const param: Record<string, any> = {
      targetDirId,
      sourceType,
      targetType,
      dirList,
      fileList,
      secret: false,
      clientId: DefaultClientID,
    };
    if (sourceType === SpaceTypeFamily && fromFamilyId) {
      param.fromFamilyId = fromFamilyId;
    }
    if (targetType === SpaceTypeFamily && targetFamilyId) {
      param.familyId = targetFamilyId;
    }
    await this.requestWoHome(KeyMoveFile, param, { secret: true });
  }

  async copyFile(
    dirList: string[],
    fileList: string[],
    targetDirId: string,
    sourceType: string,
    targetType: string,
    fromFamilyId: string = '',
    targetFamilyId: string = '',
  ): Promise<void> {
    const param: Record<string, any> = {
      targetDirId,
      sourceType,
      targetType,
      dirList,
      fileList,
      secret: false,
      clientId: DefaultClientID,
    };
    if (sourceType === SpaceTypeFamily && fromFamilyId) {
      param.fromFamilyId = fromFamilyId;
    }
    if (targetType === SpaceTypeFamily && targetFamilyId) {
      param.familyId = targetFamilyId;
    }
    await this.requestWoHome(KeyCopyFile, param, { secret: true });
  }

  async deleteFile(
    spaceType: string,
    dirList: string[],
    fileList: string[],
  ): Promise<void> {
    const param = {
      spaceType,
      vipLevel: '0',
      dirList,
      fileList,
      clientId: DefaultClientID,
    };
    await this.requestWoHome(KeyDeleteFile, param, { secret: true });
  }

  async upload2C(
    spaceType: string,
    fileName: string,
    fileBytes: Uint8Array,
    targetDirId: string,
    familyId: string = '',
  ): Promise<string> {
    await this.initZoneURL();
    const zoneURL = this.zoneURL || DefaultZoneURL;
    const uploadURL = `${zoneURL}/openapi/client/${KeyUpload2C}`;

    const fileSize = fileBytes.length;
    const totalPart = Math.max(1, Math.ceil(fileSize / DefaultPartSize));
    const batchNo = formatDateToBatchNo();

    const fileInfo: Record<string, any> = {
      spaceType,
      directoryId: targetDirId,
      batchNo,
      fileName,
      fileSize,
      fileType: this.getFileType(fileName),
    };
    if (spaceType === SpaceTypeFamily && familyId) {
      fileInfo.familyId = familyId;
    }

    const fileInfoStr = await this.crypto.encrypt(
      JSON.stringify(fileInfo),
      ChannelWoHome,
    );
    const uniqueId = `${Date.now()}_${randomChars(6)}`;

    let lastFid = '';

    for (let partIndex = 1; partIndex <= totalPart; partIndex++) {
      const offset = (partIndex - 1) * DefaultPartSize;
      const partSize =
        partIndex === totalPart ? fileSize - offset : DefaultPartSize;
      const chunkBytes = fileBytes.subarray(offset, offset + partSize);

      const formData = new FormData();
      formData.append('uniqueId', uniqueId);
      formData.append('accessToken', this.accessToken);
      formData.append('fileName', fileName);
      formData.append('psToken', 'undefined');
      formData.append('fileSize', String(fileSize));
      formData.append('totalPart', String(totalPart));
      formData.append('channel', ChannelWoCloud);
      formData.append('directoryId', targetDirId);
      formData.append('fileInfo', fileInfoStr);
      formData.append('partSize', String(partSize));
      formData.append('partIndex', String(partIndex));

      const blob = new Blob(
        [
          chunkBytes.buffer.slice(
            chunkBytes.byteOffset,
            chunkBytes.byteOffset + chunkBytes.byteLength,
          ) as ArrayBuffer,
        ],
        {
          type: 'application/octet-stream',
        },
      );
      formData.append('file', blob, fileName);

      const res = await fetch(uploadURL, {
        method: 'POST',
        headers: {
          Origin: 'https://pan.wo.cn',
          Referer: 'https://pan.wo.cn/',
          'User-Agent': DefaultUA,
        },
        body: formData,
      });

      if (!res.ok) {
        throw new Error(
          `[WoPan] Upload part ${partIndex}/${totalPart} failed with HTTP status: ${res.status}`,
        );
      }

      const resp: Upload2CResp = (await res.json().catch(() => ({}))) as Upload2CResp;
      if (resp.code !== '0000') {
        throw new Error(
          `[WoPan] Upload part ${partIndex}/${totalPart} failed: ${resp.code} ${resp.msg || ''}`,
        );
      }

      if (resp.data?.fid) {
        lastFid = resp.data.fid;
      }
    }

    return lastFid;
  }
}

// ---------------------------------------------------------------- driver helpers

function parseWoPanDate(str: string): string {
  if (!str) return new Date().toISOString();
  if (str.length >= 14) {
    const y = str.slice(0, 4);
    const m = str.slice(4, 6);
    const d = str.slice(6, 8);
    const h = str.slice(8, 10);
    const min = str.slice(10, 12);
    const s = str.slice(12, 14);
    const iso = `${y}-${m}-${d}T${h}:${min}:${s}+08:00`;
    const parsed = new Date(iso);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }
  try {
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  } catch {
    // fallthrough
  }
  return new Date().toISOString();
}

function wopanFileToObj(f: WoPanFile): Obj {
  const isDir = f.type === 0;
  const common = {
    name: f.name,
    size: isDir ? 0 : f.size || 0,
    modified: parseWoPanDate(f.createTime),
    thumb: f.thumbUrl || undefined,
    id: f.fid || f.id,
  };
  return isDir ? createDirObj(common) : createFileObj(common);
}

function normalizeAddition(a: any): Record<string, any> {
  const norm = { ...(a || {}) } as any;
  norm.root_folder_id = norm.root_folder_id || '0';
  norm.refresh_token = (norm.refresh_token || '').trim();
  norm.family_id = (norm.family_id || '').trim();
  norm.sort_rule = norm.sort_rule || 'name_asc';
  norm.access_token = (norm.access_token || '').trim();
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
    } else if (key.includes('time') || key.includes('modified') || key.includes('created')) {
      cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
    } else {
      cmp = String(a.name).localeCompare(String(b.name));
    }
    return asc ? cmp : -cmp;
  });
  return sorted;
}

// ---------------------------------------------------------------- driver

export class WoPanDriver implements Driver {
  private cfg: Record<string, any> = {};
  private client: WoPanClient = new WoPanClient('', '');
  private defaultFamilyId: string = '';
  private pathFileMapCache = new Map<string, WoPanFile>();
  private pathFolderIdCache = new Map<string, string>();

  config(): DriverConfig {
    return wopanConfig;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = normalizeAddition(cfg);
    this.client = new WoPanClient(this.cfg.access_token || '', this.cfg.refresh_token || '');
    this.pathFileMapCache = new Map<string, WoPanFile>();
    this.pathFolderIdCache = new Map<string, string>();

    await this.client.initData();
    const fml = await this.client.familyUserCurrentEncode().catch(() => null);
    if (fml?.defaultHomeId !== undefined && fml.defaultHomeId !== null) {
      this.defaultFamilyId = String(fml.defaultHomeId);
    }
  }

  private getSpaceType(): string {
    return this.cfg.family_id ? SpaceTypeFamily : SpaceTypePersonal;
  }

  private getFamilyId(): string {
    return this.cfg.family_id || this.defaultFamilyId;
  }

  private getSortRuleNum(): number {
    const rule = this.cfg.sort_rule || 'name_asc';
    return SortRules[rule] || SortRules.name_asc;
  }

  private getRootId(): string {
    return this.cfg.root_folder_id || '0';
  }

  private clearCache(): void {
    this.pathFileMapCache.clear();
    this.pathFolderIdCache.clear();
  }

  private async fetchFolderFiles(folderId: string): Promise<WoPanFile[]> {
    const allFiles: WoPanFile[] = [];
    let pageNum = 0;
    const pageSize = 100;
    while (true) {
      const data = await this.client.queryAllFiles(
        this.getSpaceType(),
        folderId,
        pageNum,
        pageSize,
        this.getSortRuleNum(),
        this.getFamilyId(),
      );
      const files = data?.files || [];
      allFiles.push(...files);
      if (files.length < pageSize) {
        break;
      }
      pageNum++;
    }
    return allFiles;
  }

  private async resolveFolderId(physicalPath: string): Promise<string> {
    const clean = physicalPath.split('/').filter(Boolean).join('/');
    if (!clean) return this.getRootId();
    if (this.pathFolderIdCache.has(clean)) {
      return this.pathFolderIdCache.get(clean)!;
    }

    const parts = clean.split('/');
    let currentFolderId = this.getRootId();

    for (let i = 0; i < parts.length; i++) {
      const rawPart = parts[i];
      const decodedPart = (() => {
        try {
          return decodeURIComponent(rawPart);
        } catch {
          return rawPart;
        }
      })();
      const subPath = parts.slice(0, i + 1).join('/');

      if (this.pathFolderIdCache.has(subPath)) {
        currentFolderId = this.pathFolderIdCache.get(subPath)!;
        continue;
      }

      const files = await this.fetchFolderFiles(currentFolderId);
      for (const f of files) {
        const childPath = parts.slice(0, i).concat(f.name).join('/');
        this.pathFileMapCache.set(childPath, f);
        if (f.type === 0) {
          this.pathFolderIdCache.set(childPath, f.id);
        }
      }

      const target = files.find(
        f =>
          f.type === 0 &&
          (f.name === rawPart || f.name === decodedPart || f.id === rawPart),
      );
      if (!target) {
        throw new Error(
          `[WoPan] Directory '${rawPart}' not found in path '${physicalPath}'`,
        );
      }
      currentFolderId = target.id;
      this.pathFolderIdCache.set(subPath, currentFolderId);
    }

    return currentFolderId;
  }

  private async resolveWoPanFile(physicalPath: string): Promise<WoPanFile | null> {
    const clean = physicalPath.split('/').filter(Boolean).join('/');
    if (!clean) return null;
    if (this.pathFileMapCache.has(clean)) {
      return this.pathFileMapCache.get(clean)!;
    }

    const parts = clean.split('/');
    const fileName = parts.pop()!;
    const decodedFileName = (() => {
      try {
        return decodeURIComponent(fileName);
      } catch {
        return fileName;
      }
    })();
    const parentPath = parts.join('/');
    const parentFolderId = await this.resolveFolderId(parentPath);

    const files = await this.fetchFolderFiles(parentFolderId);
    for (const f of files) {
      const childPath = parts.concat(f.name).join('/');
      this.pathFileMapCache.set(childPath, f);
      if (f.type === 0) {
        this.pathFolderIdCache.set(childPath, f.id);
      }
    }

    return (
      files.find(
        f =>
          f.name === fileName ||
          f.name === decodedFileName ||
          f.id === fileName ||
          f.fid === fileName,
      ) || null
    );
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const folderId = await this.resolveFolderId(path);
    const files = await this.fetchFolderFiles(folderId);

    // Update path caches for children
    const cleanDir = path.split('/').filter(Boolean).join('/');
    for (const f of files) {
      const childPath = cleanDir ? `${cleanDir}/${f.name}` : f.name;
      this.pathFileMapCache.set(childPath, f);
      if (f.type === 0) {
        this.pathFolderIdCache.set(childPath, f.id);
      }
    }

    const content = files.map(wopanFileToObj);
    return {
      content: sortItems(content, this.cfg.order_by, this.cfg.order_direction),
      total: content.length,
    };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const clean = path.split('/').filter(Boolean).join('/');
    if (!clean) {
      return createDirObj({
        name: 'root',
        modified: new Date().toISOString(),
        id: this.getRootId(),
      });
    }

    const file = await this.resolveWoPanFile(path);
    if (!file) {
      const folderId = await this.resolveFolderId(path).catch(() => null);
      if (folderId) {
        const parts = clean.split('/');
        const name = parts[parts.length - 1] || 'root';
        return createDirObj({
          name,
          modified: new Date().toISOString(),
          id: folderId,
        });
      }
      throw new Error(`[WoPan] File not found: ${path}`);
    }

    return wopanFileToObj(file);
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const file = await this.resolveWoPanFile(path);
    if (!file) {
      throw new Error(`[WoPan] File not found: ${path}`);
    }
    if (file.type === 0 || !file.fid) {
      throw new Error(`[WoPan] Cannot get link for directory: ${path}`);
    }
    const dl = await this.client.getDownloadUrlV2([file.fid]);
    if (!dl?.list?.[0]?.downloadUrl) {
      throw new Error(`[WoPan] Failed to obtain download URL for ${file.name}`);
    }
    return { url: dl.list[0].downloadUrl };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop() || '新文件夹';
    const parentPath = parts.join('/');
    const parentId = await this.resolveFolderId(parentPath);
    await this.client.createDirectory(
      this.getSpaceType(),
      parentId,
      name,
      this.getFamilyId(),
    );
    this.clearCache();
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const file = await this.resolveWoPanFile(path);
    if (!file) {
      throw new Error(`[WoPan] Item not found for rename: ${path}`);
    }
    await this.client.renameFileOrDirectory(
      this.getSpaceType(),
      file.type,
      file.id,
      newName,
      this.getFamilyId(),
    );
    this.clearCache();
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const file = await this.resolveWoPanFile(path);
    if (!file) {
      throw new Error(`[WoPan] Item not found for deletion: ${path}`);
    }
    const dirList: string[] = [];
    const fileList: string[] = [];
    if (file.type === 0) {
      dirList.push(file.id);
    } else {
      fileList.push(file.id);
    }
    await this.client.deleteFile(this.getSpaceType(), dirList, fileList);
    this.clearCache();
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const file = await this.resolveWoPanFile(src);
    if (!file) {
      throw new Error(`[WoPan] Source item not found for move: ${src}`);
    }
    const dstFolderId = await this.resolveFolderId(
      dst.substring(0, dst.lastIndexOf('/')) || '/',
    );
    const dirList: string[] = [];
    const fileList: string[] = [];
    if (file.type === 0) {
      dirList.push(file.id);
    } else {
      fileList.push(file.id);
    }
    await this.client.moveFile(
      dirList,
      fileList,
      dstFolderId,
      this.getSpaceType(),
      this.getSpaceType(),
      this.getFamilyId(),
      this.getFamilyId(),
    );
    this.clearCache();
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const file = await this.resolveWoPanFile(src);
    if (!file) {
      throw new Error(`[WoPan] Source item not found for copy: ${src}`);
    }
    const dstFolderId = await this.resolveFolderId(
      dst.substring(0, dst.lastIndexOf('/')) || '/',
    );
    const dirList: string[] = [];
    const fileList: string[] = [];
    if (file.type === 0) {
      dirList.push(file.id);
    } else {
      fileList.push(file.id);
    }
    await this.client.copyFile(
      dirList,
      fileList,
      dstFolderId,
      this.getSpaceType(),
      this.getSpaceType(),
      this.getFamilyId(),
      this.getFamilyId(),
    );
    this.clearCache();
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop() || 'upload';
    const parentPath = parts.join('/');
    const parentId = await this.resolveFolderId(parentPath);
    await this.client.upload2C(
      this.getSpaceType(),
      name,
      new Uint8Array(file),
      parentId,
      this.getFamilyId(),
    );
    this.clearCache();
  }
}

registerDriver(WoPanDriver, wopanConfig, wopanAdditional);
