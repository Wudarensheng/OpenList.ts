/**
 * Sharing routes
 * Matches OpenList's sharing feature:
 * - /api/share/*          management (list/get/create/update/delete/enable/disable)
 * - /api/fs/list|get      with a share path (/<sid>/<subpath>) -> share browsing
 * - /sd/<sid>/<path>      share download (302 or proxy)
 *
 * A share references one or more real storage paths (`files`). Browsing the
 * share maps a virtual path under the share to the real storage path.
 */

import { Env } from '../types';
import { jsonResponse, corsPreflight, STREAM_CORS_HEADERS } from '../utils/response';
import { getStorageForPath, getRelativePath } from './fs';
import { getDriverInstance } from '../drivers/registry';
import { getCachedLink, cacheLink, acquireLock, releaseLock } from '../cache';
import { getAuthUser, can, PERM } from '../utils/auth';

// Random share ID generation (8 chars, grown on collision)
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const VALID_ID_RE = /^[\w\u4e00-\u9fff-]+$/;

// Office/PDF files are opened by in-app viewers that fetch the raw bytes from
// the same origin, and inline-previewed with type=preview (Content-Disposition
// inline). This must stay in sync with fs.ts isDocPreviewName().
const DOC_PREVIEW_EXTS = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'pdf']);

function isDocPreviewName(name: string): boolean {
  const ext = (name || '').split('.').pop()?.toLowerCase() || '';
  return DOC_PREVIEW_EXTS.has(ext);
}

function randomId(len: number): string {
  let s = '';
  const arr = crypto.getRandomValues(new Uint8Array(len));
  for (const b of arr) s += ID_CHARS[b % ID_CHARS.length];
  return s;
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function fixAndCleanPath(p: string): string {
  if (!p) return '/';
  let cleaned = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!cleaned.startsWith('/')) cleaned = '/' + cleaned;
  while (cleaned.length > 1 && cleaned.endsWith('/')) cleaned = cleaned.slice(0, -1);
  return cleaned;
}

export function isSubPath(parent: string, child: string): boolean {
  const p = fixAndCleanPath(parent);
  const c = fixAndCleanPath(child);
  if (p === '/') return true;
  return c === p || c.startsWith(p + '/');
}

export interface Share {
  id: string;
  files: string[];
  expires: string | null;
  pwd: string;
  accessed: number;
  max_accessed: number;
  creator_id: number;
  disabled: boolean;
  remark: string;
  readme: string;
  header: string;
  order_by: string;
  order_direction: string;
  extract_folder: string;
  creator_name?: string;
  creator_role?: number;
}

function rowToShare(row: any): Share {
  let files: string[] = [];
  try {
    const parsed = JSON.parse((row as any).files || '[]');
    files = Array.isArray(parsed) ? parsed : [];
  } catch {
    files = [];
  }
  return {
    id: (row as any).id,
    files,
    expires: (row as any).expires || null,
    pwd: (row as any).pwd || '',
    accessed: (row as any).accessed || 0,
    max_accessed: (row as any).max_accessed || 0,
    creator_id: (row as any).creator_id || 0,
    disabled: (row as any).disabled === 1,
    remark: (row as any).remark || '',
    readme: (row as any).readme || '',
    header: (row as any).header || '',
    order_by: (row as any).order_by || 'name',
    order_direction: (row as any).order_direction || 'asc',
    extract_folder: (row as any).extract_folder || 'front',
  };
}

async function getUserRow(env: Env, id: number): Promise<any | null> {
  try {
    return await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  } catch {
    return null;
  }
}

async function loadShare(env: Env, sid: string): Promise<Share | null> {
  try {
    const row = await env.DB.prepare('SELECT * FROM shares WHERE id = ?').bind(sid).first();
    if (!row) return null;
    const share = rowToShare(row);
    const creator = await getUserRow(env, share.creator_id);
    if (creator) {
      share.creator_name = creator.username;
      share.creator_role = creator.role;
    }
    return share;
  } catch {
    return null;
  }
}

// Check whether a share id exists (regardless of validity).
export async function shareExists(env: Env, sid: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare('SELECT id FROM shares WHERE id = ?').bind(sid).first();
    return !!row;
  } catch {
    return false;
  }
}

export function shareValid(s: Share): boolean {
  if (s.disabled) return false;
  if (s.max_accessed > 0 && s.accessed >= s.max_accessed) return false;
  if (s.files.length === 0) return false;
  if (s.expires) {
    const t = Date.parse(s.expires);
    if (!isNaN(t) && t < Date.now()) return false;
  }
  return true;
}

function shareVerify(s: Share, pwd: string | null | undefined): boolean {
  return s.pwd === '' || s.pwd === (pwd || '');
}

// Map a virtual path inside the share to the real storage path.
// Single-file shares map everything under that file. Multi-file shares use the
// first path segment to select which shared root the child belongs to.
export function getShareUnwrapPath(s: Share, path: string): string {
  if (s.files.length === 0) {
    throw new Error('cannot get actual path of an invalid sharing');
  }
  const p = fixAndCleanPath(path);
  if (s.files.length === 1) {
    return fixAndCleanPath(s.files[0] === '/' ? p : `${s.files[0]}${p === '/' ? '' : p}`);
  }
  if (p === '/') {
    throw new Error('cannot get actual path of a sharing root path');
  }
  const rest = p.slice(1); // strip leading '/'
  const [child, ...tail] = rest.split('/');
  let matched = '';
  for (const c of s.files) {
    if (c !== '/' && child === c.split('/').pop()) {
      matched = c;
      break;
    }
  }
  if (!matched) {
    throw new Error(`failed find child [${child}] of sharing [${s.id}]`);
  }
  const tailPath = tail.join('/');
  return fixAndCleanPath(tailPath ? `${matched}/${tailPath}` : matched);
}

/* ---------------------------------------------------------------------------
 * Share management (requires auth)
 * ------------------------------------------------------------------------- */

export async function handleShareRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Require a logged-in user for management operations
  const user = await getAuthUser(request, env);
  if (!user) {
    return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
  }
  if (!can(user, PERM.SHARE)) {
    return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
  }

  if (path === '/api/share/list' && method === 'GET') {
    return handleListShares(request, env, user);
  }
  if (path === '/api/share/get' && method === 'GET') {
    return handleGetShare(request, env, user);
  }
  if (path === '/api/share/create' && method === 'POST') {
    return handleCreateShare(request, env, user);
  }
  if (path === '/api/share/update' && method === 'POST') {
    return handleUpdateShare(request, env, user);
  }
  if (path === '/api/share/delete' && method === 'POST') {
    return handleDeleteShare(request, env, user);
  }
  if (path === '/api/share/enable' && method === 'POST') {
    return handleSetEnableShare(request, env, user, false);
  }
  if (path === '/api/share/disable' && method === 'POST') {
    return handleSetEnableShare(request, env, user, true);
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}

function shareToResp(s: Share): Record<string, any> {
  return {
    id: s.id,
    files: s.files,
    expires: s.expires,
    pwd: s.pwd,
    accessed: s.accessed,
    max_accessed: s.max_accessed,
    disabled: s.disabled,
    remark: s.remark,
    readme: s.readme,
    header: s.header,
    order_by: s.order_by,
    order_direction: s.order_direction,
    extract_folder: s.extract_folder,
    creator: s.creator_name || '',
    creator_role: s.creator_role ?? 0,
  };
}

async function handleListShares(request: Request, env: Env, user: any): Promise<Response> {
  try {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const perPage = parseInt(url.searchParams.get('per_page') || '0');
    const offset = perPage > 0 ? (page - 1) * perPage : 0;

    let shares: Share[] = [];
    if (user.role === 2) {
      const rows = await env.DB.prepare('SELECT * FROM shares ORDER BY created_at DESC').all();
      shares = (rows.results || []).map(rowToShare);
    } else {
      const rows = await env.DB.prepare(
        'SELECT * FROM shares WHERE creator_id = ? ORDER BY created_at DESC'
      ).bind(user.id).all();
      shares = (rows.results || []).map(rowToShare);
    }

    // Attach creator info
    const sharesWithCreator: any[] = [];
    for (const s of shares) {
      const creator = await getUserRow(env, s.creator_id);
      sharesWithCreator.push({
        ...shareToResp(s),
        creator: creator?.username || '',
        creator_role: creator?.role ?? 0,
      });
    }

    let content = sharesWithCreator;
    const total = content.length;
    if (perPage > 0) {
      content = content.slice(offset, offset + perPage);
    }

    return jsonResponse({ code: 200, message: 'success', data: { content, total } });
  } catch (error: any) {
    console.error('List shares error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleGetShare(request: Request, env: Env, user: any): Promise<Response> {
  const url = new URL(request.url);
  const sid = url.searchParams.get('id') || '';
  const share = await loadShare(env, sid);
  if (!share || (user.role !== 2 && share.creator_id !== user.id)) {
    return jsonResponse({ code: 404, message: 'Share not found' }, 404);
  }
  return jsonResponse({ code: 200, message: 'success', data: shareToResp(share) });
}

async function parseShareBody(request: Request): Promise<any> {
  const body = await request.json();
  return body as any;
}

async function handleCreateShare(request: Request, env: Env, user: any): Promise<Response> {
  try {
    const body = await parseShareBody(request);
    const files = Array.isArray(body.files) ? body.files.map(fixAndCleanPath) : [];
    if (files.length === 0 || (files.length === 1 && files[0] === '/')) {
      return jsonResponse({ code: 400, message: 'must add at least 1 object' }, 400);
    }
    if (body.id) {
      if (!VALID_ID_RE.test(body.id) || [...body.id].length > 64) {
        return jsonResponse({ code: 400, message: 'invalid share id' }, 400);
      }
    }

    const id = body.id || randomId(8);
    const share: Share = {
      id,
      files,
      expires: body.expires ? new Date(body.expires).toISOString() : null,
      pwd: body.pwd || '',
      accessed: body.accessed || 0,
      max_accessed: body.max_accessed || 0,
      creator_id: user.id,
      disabled: !!body.disabled,
      remark: body.remark || '',
      readme: body.readme || '',
      header: body.header || '',
      order_by: body.order_by || 'name',
      order_direction: body.order_direction || 'asc',
      extract_folder: body.extract_folder || 'front',
    };

    // Check ID collision
    const existing = await env.DB.prepare('SELECT id FROM shares WHERE id = ?').bind(id).first();
    if (existing) {
      return jsonResponse({ code: 400, message: 'Share id already exists' }, 400);
    }

    await env.DB.prepare(
      `INSERT INTO shares (id, files, expires, pwd, accessed, max_accessed, creator_id, disabled, remark, readme, header, order_by, order_direction, extract_folder)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      share.id,
      JSON.stringify(share.files),
      share.expires,
      share.pwd,
      share.accessed,
      share.max_accessed,
      share.creator_id,
      share.disabled ? 1 : 0,
      share.remark,
      share.readme,
      share.header,
      share.order_by,
      share.order_direction,
      share.extract_folder
    ).run();

    share.creator_name = user.username;
    share.creator_role = user.role;
    return jsonResponse({ code: 200, message: 'success', data: shareToResp(share) });
  } catch (error: any) {
    console.error('Create share error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleUpdateShare(request: Request, env: Env, user: any): Promise<Response> {
  try {
    const body = await parseShareBody(request);
    const share = await loadShare(env, body.id || '');
    if (!share || (user.role !== 2 && share.creator_id !== user.id)) {
      return jsonResponse({ code: 404, message: 'Share not found' }, 404);
    }

    const files = Array.isArray(body.files) ? body.files.map(fixAndCleanPath) : share.files;
    if (files.length === 0 || (files.length === 1 && files[0] === '/')) {
      return jsonResponse({ code: 400, message: 'must add at least 1 object' }, 400);
    }

    const updated: Share = {
      ...share,
      files,
      expires: body.expires !== undefined ? (body.expires ? new Date(body.expires).toISOString() : null) : share.expires,
      pwd: body.pwd !== undefined ? body.pwd || '' : share.pwd,
      accessed: body.accessed !== undefined ? body.accessed : share.accessed,
      max_accessed: body.max_accessed !== undefined ? body.max_accessed : share.max_accessed,
      disabled: body.disabled !== undefined ? !!body.disabled : share.disabled,
      remark: body.remark !== undefined ? body.remark : share.remark,
      readme: body.readme !== undefined ? body.readme : share.readme,
      header: body.header !== undefined ? body.header : share.header,
      order_by: body.order_by || share.order_by,
      order_direction: body.order_direction || share.order_direction,
      extract_folder: body.extract_folder || share.extract_folder,
    };

    // Optional custom ID change
    if (body.new_id && body.new_id !== updated.id) {
      if (!VALID_ID_RE.test(body.new_id) || [...body.new_id].length > 64) {
        return jsonResponse({ code: 400, message: 'invalid share id' }, 400);
      }
      const clash = await env.DB.prepare('SELECT id FROM shares WHERE id = ?').bind(body.new_id).first();
      if (clash) {
        return jsonResponse({ code: 400, message: 'Share id already exists' }, 400);
      }
      await env.DB.prepare('UPDATE shares SET id = ? WHERE id = ?').bind(body.new_id, updated.id).run();
      updated.id = body.new_id;
    }

    await env.DB.prepare(
      `UPDATE shares SET files=?, expires=?, pwd=?, accessed=?, max_accessed=?, disabled=?, remark=?, readme=?, header=?, order_by=?, order_direction=?, extract_folder=? WHERE id=?`
    ).bind(
      JSON.stringify(updated.files),
      updated.expires,
      updated.pwd,
      updated.accessed,
      updated.max_accessed,
      updated.disabled ? 1 : 0,
      updated.remark,
      updated.readme,
      updated.header,
      updated.order_by,
      updated.order_direction,
      updated.extract_folder,
      updated.id
    ).run();

    updated.creator_name = share.creator_name;
    updated.creator_role = share.creator_role;
    return jsonResponse({ code: 200, message: 'success', data: shareToResp(updated) });
  } catch (error: any) {
    console.error('Update share error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleDeleteShare(request: Request, env: Env, user: any): Promise<Response> {
  const url = new URL(request.url);
  const sid = url.searchParams.get('id') || '';
  const share = await loadShare(env, sid);
  if (!share || (user.role !== 2 && share.creator_id !== user.id)) {
    return jsonResponse({ code: 404, message: 'Share not found' }, 404);
  }
  await env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(sid).run();
  return jsonResponse({ code: 200, message: 'success' });
}

async function handleSetEnableShare(request: Request, env: Env, user: any, disabled: boolean): Promise<Response> {
  const url = new URL(request.url);
  const sid = url.searchParams.get('id') || '';
  const share = await loadShare(env, sid);
  if (!share || (user.role !== 2 && share.creator_id !== user.id)) {
    return jsonResponse({ code: 404, message: 'Share not found' }, 404);
  }
  await env.DB.prepare('UPDATE shares SET disabled = ? WHERE id = ?').bind(disabled ? 1 : 0, sid).run();
  return jsonResponse({ code: 200, message: 'success' });
}

/* ---------------------------------------------------------------------------
 * Share browsing (public) - used by /api/fs/list and /api/fs/get
 * A path like "/<sid>/<subpath>" resolves against the share.
 * ------------------------------------------------------------------------- */

// Extract { sid, sharePath } from a request path.
// The path is the share id as the first segment, e.g. /abc123/sub/dir.
export function parseSharePath(path: string): { sid: string; sharePath: string } | null {
  const p = fixAndCleanPath(path);
  if (p === '/') return null;
  const rest = p.slice(1);
  const [sid, ...tail] = rest.split('/');
  if (!sid || !VALID_ID_RE.test(sid)) return null;
  return { sid, sharePath: tail.length ? `/${tail.join('/')}` : '/' };
}

// Load + validate a share for public access, checking pwd.
export async function getPublicShare(env: Env, sid: string, pwd?: string): Promise<Share | null> {
  const share = await loadShare(env, sid);
  if (!share) return null;
  if (!shareValid(share)) return null;
  if (!shareVerify(share, pwd)) return null;
  return share;
}

// Resolve a share virtual path to { storage, realPath }.
export async function resolveSharePath(env: Env, sid: string, sharePath: string, pwd?: string): Promise<{ storage: any; realPath: string } | null> {
  const share = await getPublicShare(env, sid, pwd);
  if (!share) return null;
  try {
    const realPath = getShareUnwrapPath(share, sharePath);
    const storage = await getStorageForPath(realPath, env);
    if (!storage) return null;
    return { storage, realPath };
  } catch {
    return null;
  }
}

// Public share list (used by /api/fs/list when path starts with a share id)
export async function listShare(env: Env, sid: string, sharePath: string, pwd: string | undefined, origin: string): Promise<{ content: any[]; readme: string; header: string } | null> {
  const share = await getPublicShare(env, sid, pwd);
  if (!share) return null;

  // Count access
  await env.DB.prepare('UPDATE shares SET accessed = accessed + 1 WHERE id = ?').bind(sid).run();

  const items: any[] = [];

  // Single-share at its root: if it's a directory, list its contents;
  // if it's a single file, return that file.
  if (share.files.length === 1 && sharePath === '/') {
    try {
      const realPath = getShareUnwrapPath(share, sharePath);
      const storage = await getStorageForPath(realPath, env);
      if (storage) {
        const addition = JSON.parse(storage.addition);
        const driver = await getDriverInstance(storage.driver, addition);
        const relativePath = getRelativePath(realPath, storage.mount_path);
        const obj = await driver.get(relativePath, addition);
        if (obj.is_dir) {
          const result = await driver.list(relativePath, addition);
          const objs = Array.isArray(result.content) ? result.content : [];
          for (const o of objs) {
            items.push(objToShareItem(o, realPath, share, sid, sharePath, origin));
          }
        } else {
          items.push(objToShareItem(obj, realPath, share, sid, sharePath, origin));
        }
      }
    } catch (e) {
      // ignore
    }
  } else if (share.files.length === 1 || sharePath !== '/') {
    // Single-file share inside a dir, or navigating into a subpath: list the real dir.
    try {
      const realPath = getShareUnwrapPath(share, sharePath);
      const storage = await getStorageForPath(realPath, env);
      if (storage) {
        const addition = JSON.parse(storage.addition);
        const driver = await getDriverInstance(storage.driver, addition);
        const relativePath = getRelativePath(realPath, storage.mount_path);
        const result = await driver.list(relativePath, addition);
        const objs = Array.isArray(result.content) ? result.content : [];
        for (const obj of objs) {
          items.push(objToShareItem(obj, realPath, share, sid, sharePath, origin));
        }
      }
    } catch (e) {
      // ignore
    }
  } else {
    // Multi-file share at root: list each shared root's top-level object
    for (const f of share.files) {
      if (f === '/') continue;
      const storage = await getStorageForPath(f, env);
      if (!storage) continue;
      try {
        const addition = JSON.parse(storage.addition);
        const driver = await getDriverInstance(storage.driver, addition);
        const relativePath = getRelativePath(f, storage.mount_path);
        const obj = await driver.get(relativePath, addition);
        items.push(objToShareItem(obj, f, share, sid, sharePath, origin));
      } catch {
        continue;
      }
    }
  }

  // Apply sorting
  const { order_by, order_direction } = share;
  items.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let cmp = 0;
    if (order_by === 'size') cmp = a.size - b.size;
    else if (order_by === 'modified') cmp = (a.modified || '').localeCompare(b.modified || '');
    else cmp = (a.name || '').localeCompare(b.name || '');
    return order_direction === 'desc' ? -cmp : cmp;
  });

  return { content: items, readme: share.readme || '', header: share.header || '' };
}

function objToShareItem(obj: any, realPath: string, share: Share, sid: string, sharePath: string, origin: string): any {
  const fileName = obj.name || realPath.split('/').pop() || '';
  // Virtual path within the share: for the root of a multi-file share, the
  // item path is /sid/<name>; inside a folder it is /sid/<sharePath>/<name>.
  const base = sharePath === '/' ? `/${sid}` : `/${sid}${sharePath}`;
  return {
    name: fileName,
    size: obj.size || 0,
    is_dir: obj.is_dir,
    modified: obj.modified || new Date().toISOString(),
    created: obj.created || obj.modified || new Date().toISOString(),
    sign: '',
    thumb: obj.thumb || '',
    type: obj.is_dir ? 1 : getShareFileType(fileName),
    hashinfo: obj.hash_info || '',
    hash_info: {},
    // share download path (absolute so in-app/external viewers can use it)
    raw_url: `${origin}/sd/${sid}/${sharePath === '/' ? '' : sharePath.slice(1)}${fileName}${isDocPreviewName(fileName) ? '?type=preview' : ''}`,
    readme: '',
    header: '',
    provider: 'unknown',
    related: [],
    // used by frontend to build /sd/ links
    inner_path: '',
  };
}

function getShareFileType(name: string): number {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'];
  const videoExts = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm'];
  const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma'];
  const textExts = ['txt', 'md'];
  if (imageExts.includes(ext)) return 5;
  if (videoExts.includes(ext)) return 2;
  if (audioExts.includes(ext)) return 3;
  if (textExts.includes(ext)) return 4;
  return 0;
}

// Public share get (used by /api/fs/get)
export async function getShareFile(env: Env, sid: string, sharePath: string, pwd: string | undefined, origin: string): Promise<any | null> {
  const share = await getPublicShare(env, sid, pwd);
  if (!share) return null;

  await env.DB.prepare('UPDATE shares SET accessed = accessed + 1 WHERE id = ?').bind(sid).run();

  // Root of the share
  if (sharePath === '/') {
    return {
      name: sid,
      size: 0,
      is_dir: true,
      modified: new Date().toISOString(),
      created: new Date().toISOString(),
      sign: '',
      thumb: '',
      type: 1,
      hashinfo: '',
      hash_info: {},
      raw_url: '',
      readme: share.readme || '',
      header: share.header || '',
      provider: 'unknown',
      related: [],
    };
  }

  try {
    const realPath = getShareUnwrapPath(share, sharePath);
    const storage = await getStorageForPath(realPath, env);
    if (!storage) return null;
    const addition = JSON.parse(storage.addition);
    const driver = await getDriverInstance(storage.driver, addition);
    const relativePath = getRelativePath(realPath, storage.mount_path);
    const obj = await driver.get(relativePath, addition);
    const fileName = obj.name || realPath.split('/').pop() || '';
    return {
      name: fileName,
      size: obj.size || 0,
      is_dir: obj.is_dir,
      modified: obj.modified || new Date().toISOString(),
      created: obj.created || obj.modified || new Date().toISOString(),
      sign: '',
      thumb: obj.thumb || '',
      type: obj.is_dir ? 1 : getShareFileType(fileName),
      hashinfo: obj.hash_info || '',
      hash_info: {},
      raw_url: obj.is_dir ? '' : `${origin}/sd/${sid}/${sharePath.slice(1)}${isDocPreviewName(fileName) ? '?type=preview' : ''}`,
      readme: share.readme || '',
      header: share.header || '',
      provider: 'unknown',
      related: [],
    };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Share download - /sd/<sid>/<path>
 * ------------------------------------------------------------------------- */

export async function handleShareDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight for cross-origin in-app viewers (pdf.js etc.).
  if (request.method === 'OPTIONS' && path.startsWith('/sd/')) return corsPreflight();

  const pwd = url.searchParams.get('pwd') || undefined;
  const type = url.searchParams.get('type') || '';

  // path is like /sd/<sid>/<subpath>
  const rest = path.replace(/^\/sd\//, '');
  const [rawSid, ...tail] = rest.split('/');
  // URL path segments are percent-encoded; decode them for matching.
  const sid = safeDecodeURIComponent(rawSid);
  const sharePath = tail.length ? `/${tail.map(safeDecodeURIComponent).join('/')}` : '/';

  const share = await getPublicShare(env, sid, pwd);
  if (!share) {
    return new Response('Share not found or invalid', { status: 404 });
  }

  if (sharePath === '/' && share.files.length !== 1) {
    return new Response('cannot get sharing root link', { status: 400 });
  }

  let realPath: string;
  try {
    realPath = getShareUnwrapPath(share, sharePath);
  } catch (e: any) {
    return new Response(e.message || 'invalid share path', { status: 400 });
  }

  const storage = await getStorageForPath(realPath, env);
  if (!storage) {
    return new Response('Storage not found', { status: 404 });
  }

  // Reuse the download link logic (cache + singleflight)
  const link = await getShareLink(storage, realPath, env);

  // If the driver returned custom headers or storage is configured to proxy,
  // stream through the worker.
  if (storage.web_proxy || (link.header && Object.keys(link.header).length > 0)) {
    return proxyShareLink(link, realPath, request, type);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: link.url,
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'max-age=0, no-cache, no-store, must-revalidate',
    },
  });
}

async function getShareLink(storage: any, realPath: string, env: Env): Promise<{ url: string; header?: Record<string, string> }> {
  const cached = await getCachedLink(storage.id, realPath, env);
  if (cached) return cached;

  const lockKey = `dlink:${storage.id}:${realPath}`;
  const acquired = await acquireLock(lockKey, 30, env);
  if (acquired) {
    try {
      const addition = JSON.parse(storage.addition);
      const driver = await getDriverInstance(storage.driver, addition);
      const relativePath = getRelativePath(realPath, storage.mount_path);
      const link = await driver.link(relativePath, addition);
      const cacheExpiration = storage.cache_expiration || 30;
      await cacheLink(storage.id, realPath, link, cacheExpiration * 60, env);
      return link;
    } finally {
      await releaseLock(lockKey, env);
    }
  }

  await new Promise(resolve => setTimeout(resolve, 500));
  const retry = await getCachedLink(storage.id, realPath, env);
  if (retry) return retry;

  const addition = JSON.parse(storage.addition);
  const driver = await getDriverInstance(storage.driver, addition);
  const relativePath = getRelativePath(realPath, storage.mount_path);
  return driver.link(relativePath, addition);
}

async function proxyShareLink(link: { url: string; header?: Record<string, string> }, realPath: string, request: Request, type: string): Promise<Response> {
  const isHead = request.method === 'HEAD';
  const headers: Record<string, string> = { ...(link.header || {}) };
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;
  const userAgent = request.headers.get('User-Agent');
  if (userAgent) headers['User-Agent'] = userAgent;

  let upstream: Response;
  let syntheticRange = false;
  if (isHead) {
    const hh = { ...headers };
    if (!hh['Range']) {
      hh['Range'] = 'bytes=0-0';
      syntheticRange = true;
    }
    upstream = await fetchFollowingRedirects(link.url, hh);
  } else {
    upstream = await fetchFollowingRedirects(link.url, headers);
  }

  const filename = realPath.split('/').pop() || 'file';
  const contentType = upstream.headers.get('Content-Type') || 'application/octet-stream';
  const outHeaders = new Headers();
  outHeaders.set('Content-Type', contentType);
  if (upstream.headers.get('Content-Range')) {
    outHeaders.set('Content-Range', upstream.headers.get('Content-Range')!);
    const total = upstream.headers.get('Content-Range')!.split('/')[1];
    if (total && total !== '*') outHeaders.set('Content-Length', total);
  } else if (upstream.headers.get('Content-Length')) {
    outHeaders.set('Content-Length', upstream.headers.get('Content-Length')!);
  }
  if (upstream.headers.get('Accept-Ranges')) {
    outHeaders.set('Accept-Ranges', upstream.headers.get('Accept-Ranges')!);
  }
  outHeaders.set('Referrer-Policy', 'no-referrer');
  outHeaders.set('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate');
  // Allow cross-origin in-browser viewers (pdf.js etc.) to fetch the file.
  for (const [k, v] of Object.entries(STREAM_CORS_HEADERS)) {
    outHeaders.set(k, v);
  }

  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_');
  const disposition = type === 'preview'
    ? 'inline'
    : `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  outHeaders.set('Content-Disposition', disposition);

  let status = upstream.status === 206 ? 206 : upstream.ok ? 200 : upstream.status;
  if (isHead && syntheticRange && status === 206) status = 200;
  return new Response(isHead ? null : upstream.body, { status, headers: outHeaders });
}

// Follow redirects manually, stripping Authorization/Cookie on cross-origin
// hops (e.g. a WebDAV/Basic-auth link that 302s to a presigned storage URL).
async function fetchFollowingRedirects(url: string, headers: Record<string, string>): Promise<Response> {
  let current = url;
  let currentHeaders = headers;
  let upstream = await fetch(current, { method: 'GET', headers: currentHeaders, redirect: 'manual' });

  let hops = 0;
  const redirectStatus = [301, 302, 303, 307, 308];
  while (redirectStatus.includes(upstream.status) && hops < 5) {
    const loc = upstream.headers.get('location');
    if (!loc) break;
    const next = new URL(loc, current);
    if (next.origin !== new URL(current).origin) {
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(currentHeaders)) {
        if (!/^authorization$/i.test(k) && !/^cookie$/i.test(k)) filtered[k] = v;
      }
      currentHeaders = filtered;
    }
    current = next.toString();
    upstream = await fetch(current, { method: 'GET', headers: currentHeaders, redirect: 'manual' });
    hops++;
  }
  return upstream;
}
