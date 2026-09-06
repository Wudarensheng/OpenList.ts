/**
 * Mega (mega.nz) Driver — read-oriented, SDK-free mega API
 * Ported from openlistnext (github.com/Polonium-salts/openlistnext)
 * drivers/mega (driver.ts + util.ts + types.ts).
 *
 * The reference util reimplements the small subset of the mega HTTP API it
 * needs on top of crypto-js. crypto-js is used there only for UTF-8 / Base64
 * conversions, so this port replaces it with dependency-free TextEncoder /
 * btoa helpers (identical semantics, incl. URL-safe unpadded base64). No AES
 * is performed by the reference for list/get/link/mkdir/move/delete; this
 * port reproduces that structure exactly — endpoints, commands and request
 * shapes are unchanged.
 *
 * Upload is not implemented by the reference driver (it only logs), so this
 * driver keeps no_upload = true and put() throws. rename/copy are also
 * unimplemented in the reference and kept as logged no-ops.
 */

import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

export const megaConfig: DriverConfig = {
  name: 'Mega',
  label: 'Mega.nz',
  local_sort: true,
  only_proxy: true,
  no_cache: false,
  no_upload: true,
  default_root: '/',
};

export const megaAdditional: DriverItem[] = [
  { name: 'email', type: 'string', default: '', options: '', required: true, help: 'Login email' },
  { name: 'password', type: 'string', default: '', options: '', required: true, help: 'Login password' },
  { name: 'two_fa_code', type: 'string', default: '', options: '', required: false, help: 'Two-factor auth code' },
  { name: 'two_fa_secret', type: 'string', default: '', options: '', required: false, help: 'Two-factor auth secret' },
  { name: 'move_to_trash', type: 'bool', default: 'true', options: '', required: false, help: 'Move deleted items to trash' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,size,modified', required: false, help: 'Sort field' },
  { name: 'order_direction', type: 'select', default: 'asc', options: 'asc,desc', required: false, help: 'Sort direction' },
];

// ---------------------------------------------------------------- types

interface MegaNodeItem {
  id: string; // handle 'h'
  parent_id?: string; // 'p'
  name: string;
  size: number;
  is_dir: boolean;
  modified: string;
  type: number; // 0=file, 1=folder, 2=root, 3=inbox, 4=trash
  raw_url?: string;
  key?: string;
}

// ---------------------------------------------------------------- helpers

function cleanPath(p: string): string {
  const s = '/' + (p || '').split('/').filter(Boolean).join('/');
  return s === '/' ? '/' : s;
}

/** Parent directory of a (possibly item-level) path; '/' for the root. */
function dirnameOf(p: string): string {
  const clean = cleanPath(p);
  const idx = clean.lastIndexOf('/');
  return idx <= 0 ? '/' : clean.substring(0, idx);
}

/** UTF-8 encode then URL-safe unpadded base64 (replaces strToWords + wordsToB64). */
function bytesToB64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL-safe unpadded base64 -> bytes (replaces b64ToWords, then UTF-8 decode). */
function b64UrlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) {
    b64 += '=';
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function sortItems(items: Obj[], orderBy?: string, orderDirection?: string): Obj[] {
  const asc = orderDirection !== 'desc';
  const key = String(orderBy || 'name').toLowerCase();
  return [...items].sort((a, b) => {
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
}

// ---------------------------------------------------------------- api client

export class MegaDriver implements Driver {
  private cfg: Record<string, any> = {};
  private sid = '';
  private seq = Math.floor(Math.random() * 0x10000000);
  private nodes: Map<string, MegaNodeItem> = new Map();
  private rootId = '';

  config(): DriverConfig {
    return megaConfig;
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) % 0x10000000;
    return this.seq;
  }

  private async request<T = any>(body: any[]): Promise<T> {
    const seq = this.nextSeq();
    let url = `https://g.api.mega.co.nz/cs?id=${seq}`;
    if (this.sid) {
      url += `&sid=${this.sid}`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Mega API HTTP error: ${res.status}`);
    }

    const json = (await res.json()) as any;
    if (typeof json === 'number' && json < 0) {
      throw new Error(`Mega API error code: ${json}`);
    }
    return json as T;
  }

  async init(cfg: Record<string, any>): Promise<void> {
    this.cfg = cfg;
    this.nodes.clear();
    this.rootId = '';
    this.sid = '';
    this.seq = Math.floor(Math.random() * 0x10000000);

    if (!this.cfg.email || !this.cfg.password) {
      throw new Error('Mega email and password are required');
    }

    const email = String(this.cfg.email).toLowerCase();
    const userHash = bytesToB64Url(new TextEncoder().encode(email));

    // Step 1: user challenge 'us'
    const res = await this.request<any[]>([
      {
        a: 'us',
        user: email,
        uh: userHash,
      },
    ]);

    const authResp = res[0];
    if (typeof authResp === 'number' && authResp < 0) {
      throw new Error(`Mega authentication failed: ${authResp}`);
    }

    this.sid = authResp.sid || '';
    await this.fetchNodes();
  }

  private async fetchNodes(): Promise<void> {
    if (!this.sid) return;

    const res = await this.request<any[]>([{ a: 'f', c: 1 }]);
    const filesResp = res[0];
    if (filesResp?.f && Array.isArray(filesResp.f)) {
      this.nodes.clear();
      for (const node of filesResp.f) {
        // Node type: 0=file, 1=folder, 2=root, 3=inbox, 4=trash
        const isDir = node.t === 1 || node.t === 2 || node.t === 3 || node.t === 4;
        if (node.t === 2) {
          this.rootId = node.h;
        }

        let name = 'unnamed';
        if (node.a) {
          try {
            // Decrypt attribute string
            const decrypted = this.decryptAttributes(node.a);
            if (decrypted?.n) {
              name = decrypted.n;
            }
          } catch {
            name = node.h;
          }
        }

        const item: MegaNodeItem = {
          id: node.h,
          parent_id: node.p,
          name,
          size: node.s || 0,
          is_dir: isDir,
          modified: node.ts
            ? new Date(node.ts * 1000).toISOString()
            : new Date().toISOString(),
          type: node.t,
          key: node.k,
        };
        this.nodes.set(node.h, item);
      }
    }
  }

  private decryptAttributes(attrB64: string): { n?: string } | null {
    try {
      const bytes = b64UrlToBytes(attrB64);
      const text = utf8Decode(bytes);
      if (text.startsWith('MEGA{')) {
        const jsonStr = text.substring(4);
        return JSON.parse(jsonStr);
      }
    } catch {
      // Ignored
    }
    return null;
  }

  getChildren(parentId?: string): MegaNodeItem[] {
    const targetParent = parentId || this.rootId;
    const result: MegaNodeItem[] = [];
    for (const node of this.nodes.values()) {
      if (node.parent_id === targetParent) {
        result.push(node);
      }
    }
    return result;
  }

  getNode(handle: string): MegaNodeItem | undefined {
    return this.nodes.get(handle);
  }

  getRootId(): string {
    return this.rootId;
  }

  private async getDownloadLink(handle: string): Promise<string> {
    const res = await this.request<any[]>([{ a: 'g', g: 1, n: handle }]);
    const data = res[0];
    if (data?.g) {
      return data.g;
    }
    throw new Error(`Failed to get download URL for node ${handle}`);
  }

  private async createFolder(name: string, parentId?: string): Promise<string> {
    const pid = parentId || this.rootId;
    const attrJson = JSON.stringify({ n: name });
    const attrB64 = bytesToB64Url(new TextEncoder().encode(`MEGA${attrJson}`));

    const res = await this.request<any[]>([
      {
        a: 'p',
        t: pid,
        n: [
          {
            h: 'xxxxxxxx',
            t: 1,
            a: attrB64,
            k: 'dummy_key',
          },
        ],
      },
    ]);
    await this.fetchNodes();
    return res[0]?.f?.[0]?.h || '';
  }

  private async deleteNode(handle: string): Promise<void> {
    await this.request<any[]>([{ a: 'd', n: handle }]);
    this.nodes.delete(handle);
  }

  private async moveNode(handle: string, targetParentId: string): Promise<void> {
    await this.request<any[]>([{ a: 'm', n: handle, t: targetParentId }]);
    const node = this.nodes.get(handle);
    if (node) {
      node.parent_id = targetParentId;
    }
  }

  private async getQuota(): Promise<{ total: number; used: number }> {
    const res = await this.request<any[]>([{ a: 'uq', strg: 1 }]);
    const data = res[0];
    return {
      total: data?.mstrg || 0,
      used: data?.cstrg || 0,
    };
  }

  private resolveNodeByPath(p: string): MegaNodeItem | null {
    const clean = cleanPath(p);
    if (clean === '/') {
      return {
        id: this.getRootId(),
        name: 'root',
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        type: 2,
      };
    }

    const parts = clean.split('/').filter(Boolean);
    let currentId = this.getRootId();
    let currentNode: MegaNodeItem | null = null;

    for (const part of parts) {
      const children = this.getChildren(currentId);
      const found = children.find((c) => c.name === part);
      if (!found) return null;
      currentNode = found;
      currentId = found.id;
    }

    return currentNode;
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private nodeToObj(n: MegaNodeItem): Obj {
    const common = {
      name: n.name,
      size: n.size || 0,
      modified: n.modified || this.nowIso(),
      id: n.id,
    };
    return n.is_dir ? createDirObj(common) : createFileObj(common);
  }

  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    const node = this.resolveNodeByPath(path);
    if (!node || !node.is_dir) {
      return { content: [], total: 0 };
    }

    const children = this.getChildren(node.id);
    const items: Obj[] = children.map((c) => this.nodeToObj(c));
    const sorted = sortItems(items, this.cfg.order_by, this.cfg.order_direction);
    return { content: sorted, total: sorted.length };
  }

  async get(path: string, cfg: Record<string, any>): Promise<Obj> {
    const node = this.resolveNodeByPath(path);
    if (!node) {
      throw new Error(`Node not found: ${path}`);
    }
    return this.nodeToObj(node);
  }

  async link(path: string, cfg: Record<string, any>): Promise<LinkResult> {
    const node = this.resolveNodeByPath(path);
    if (!node || node.is_dir) {
      throw new Error(`Cannot get link for non-file: ${path}`);
    }
    const url = await this.getDownloadLink(node.id);
    return { url };
  }

  async mkdir(path: string, cfg: Record<string, any>): Promise<void> {
    const clean = cleanPath(path);
    const parentPath = clean.substring(0, clean.lastIndexOf('/')) || '/';
    const dirName = clean.substring(clean.lastIndexOf('/') + 1);

    const parentNode = this.resolveNodeByPath(parentPath);
    if (!parentNode || !parentNode.is_dir) {
      throw new Error(`Parent folder not found: ${parentPath}`);
    }

    await this.createFolder(dirName, parentNode.id);
  }

  async rename(path: string, newName: string, cfg: Record<string, any>): Promise<void> {
    const node = this.resolveNodeByPath(path);
    if (!node) {
      throw new Error('Node not found');
    }
    // Rename via attr update
    console.warn(`[Mega] rename ${path} to ${newName}`);
  }

  async move(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    const dstNode = this.resolveNodeByPath(dirnameOf(dst));
    if (!dstNode || !dstNode.is_dir) {
      throw new Error('Destination folder not found');
    }

    const srcNode = this.resolveNodeByPath(src);
    if (srcNode) {
      await this.moveNode(srcNode.id, dstNode.id);
    }
  }

  async copy(src: string, dst: string, cfg: Record<string, any>): Promise<void> {
    console.warn(`[Mega] copy not supported natively from ${src} to ${dst}`);
  }

  async remove(path: string, cfg: Record<string, any>): Promise<void> {
    const node = this.resolveNodeByPath(path);
    if (node) {
      await this.deleteNode(node.id);
    }
  }

  async put(path: string, file: ArrayBuffer, contentType: string, cfg: Record<string, any>): Promise<void> {
    throw new Error('Mega upload is not implemented');
  }

  private async getDetails(): Promise<{ total_space?: number; used_space?: number }> {
    try {
      const quota = await this.getQuota();
      return {
        total_space: quota.total,
        used_space: quota.used,
      };
    } catch {
      return {};
    }
  }
}

registerDriver(MegaDriver, megaConfig, megaAdditional);
