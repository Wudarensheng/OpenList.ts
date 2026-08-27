/**
 * WebDAV handler
 * Referenced from OpenList's server/webdav (golang.org/x/net/webdav).
 * Implements the WebDAV protocol over the existing drivers so cloud drives
 * can be mounted locally (Windows Explorer, macOS Finder, rclone, ...).
 *
 * Endpoint: /dav/<path> with HTTP Basic Auth (OpenList username/password).
 *
 * Supported methods: OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE,
 * MOVE, COPY, LOCK, UNLOCK, PROPPATCH (best-effort).
 */

import { Env } from '../types';
import { getStorageForPath, getRelativePath } from './fs';
import { getDriverInstance } from '../drivers/registry';
import { getCachedLink, cacheLink, acquireLock, releaseLock } from '../cache';
import { verifyPassword } from '../utils/auth';

const NS_DAV = 'DAV:';
const NS_MICROSOFT = 'urn:schemas-microsoft-com:';
const NS_OFFICE = 'urn:schemas-microsoft-com:office:office';
const NS_EXCEL = 'urn:schemas-microsoft-com:office:excel';
const NS_POWERSHELL = 'http://schemas.microsoft.com/powershell/2004/04';
const NS_ACL = 'http://schemas.microsoft.com/management/2010/01/ACL';

function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function formatDate(d: Date): string {
  // RFC1123-ish HTTP date for creationdate/getlastmodified
  return d.toUTCString();
}

function iso8601(d: Date): string {
  // ISO8601 for getlastmodified alternate
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

// Basic Auth helper
function basicAuth(request: Request): { username: string; password: string } | null {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

// Verify Basic Auth against the users table.
async function authenticate(request: Request, env: Env): Promise<any | null> {
  const creds = basicAuth(request);
  if (!creds) return null;
  const user = await env.DB.prepare(
    'SELECT * FROM users WHERE username = ? AND disabled = 0'
  ).bind(creds.username).first();
  if (!user) return null;
  // WebDAV clients send the raw password in Basic auth.
  if (!(await verifyPassword((user as any).password, { raw: creds.password }))) {
    // Some clients hash the password client-side first.
    const staticValue = creds.password;
    if (!(await verifyPassword((user as any).password, { staticHashValue: staticValue }))) {
      return null;
    }
  }
  return user;
}

// Resolve a /dav/<path> URL path to { storage, realPath }.
// The storage mount root maps to a WebDAV virtual root; a single storage is
// mounted at "/dav/". Multiple storages appear as subfolders.
async function resolvePath(davPath: string, env: Env): Promise<{ storage: any; realPath: string } | null> {
  // davPath is the path after /dav, e.g. "/" or "/backblaze/photo.jpg"
  const storage = await getStorageForPath(davPath, env);
  if (!storage) return null;
  const realPath = getRelativePath(davPath, storage.mount_path);
  return { storage, realPath };
}

async function getDriver(storage: any): Promise<any> {
  const addition = JSON.parse(storage.addition);
  return getDriverInstance(storage.driver, addition);
}

// Driver error -> HTTP status
function errStatus(err: any, fallback = 500): number {
  const msg = String(err?.message || '');
  if (msg.includes('Not found') || msg.includes('not found') || msg.includes('404')) return 404;
  if (msg.includes('permission') || msg.includes('403')) return 403;
  if (msg.includes('already')) return 405;
  return fallback;
}

// Convert an Obj to WebDAV properties
function objToProps(path: string, obj: any): string {
  const name = obj.name || path.split('/').pop() || '';
  const size = obj.is_dir ? 0 : (obj.size || 0);
  const modified = obj.modified ? new Date(obj.modified) : new Date();
  const href = escapeHref(path);
  const isDir = !!obj.is_dir;

  const props = `
      <d:resourcetype>${isDir ? '<d:collection/>' : ''}</d:resourcetype>
      <d:getcontentlength>${size}</d:getcontentlength>
      <d:getlastmodified>${formatDate(modified)}</d:getlastmodified>
      <d:creationdate>${iso8601(modified)}</d:creationdate>
      <d:getetag>"${isDir ? 'dir' : size}-${name}"</d:getetag>
      <d:displayname>${xmlEscape(name)}</d:displayname>
      <d:getcontenttype>${isDir ? 'httpd/unix-directory' : mimeType(name)}</d:getcontenttype>
      <d:lockdiscovery/>
      <d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock>
      <d:getcontentlanguage>en</d:getcontentlanguage>
      <d:ishidden>false</d:ishidden>
      <d:iscollection>${isDir ? 'true' : 'false'}</d:iscollection>`;

  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function escapeHref(p: string): string {
  const encoded = p.split('/').map(seg => encodeURIComponent(seg)).join('/');
  if (p === '/') return '/';
  return encoded;
}

function mimeType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav',
    mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
    txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    zip: 'application/zip', apk: 'application/vnd.android.package-archive',
  };
  return map[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------- main handler

export async function handleWebDavRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;

  // Auth (except OPTIONS which Windows sends without credentials first)
  const user = await authenticate(request, env);
  if (!user) {
    if (method === 'OPTIONS') {
      // allow preflight
    } else {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="openlist"' },
      });
    }
  }

  // davPath = path after /dav. URL path segments are percent-encoded;
  // decode them so Chinese/space filenames resolve correctly.
  const rawPath = url.pathname.replace(/^\/dav/, '') || '/';
  const decoded = safeDecode(rawPath);
  const davPath = decoded.startsWith('/') ? decoded : '/' + decoded;

  switch (method) {
    case 'OPTIONS':
      return handleOptions();
    case 'PROPFIND':
      return handlePropfind(request, davPath, env);
    case 'GET':
    case 'HEAD':
      return handleGet(request, davPath, env);
    case 'PUT':
      return handlePut(request, davPath, env);
    case 'MKCOL':
      return handleMkcol(davPath, env);
    case 'DELETE':
      return handleDelete(davPath, env);
    case 'MOVE':
      return handleMove(request, davPath, env);
    case 'COPY':
      return handleCopy(request, davPath, env);
    case 'LOCK':
      return handleLock(request);
    case 'UNLOCK':
      return handleUnlock();
    case 'PROPPATCH':
      return new Response(null, { status: 200 });
    default:
      return new Response(null, { status: 405 });
  }
}

function handleOptions(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      'Allow': 'OPTIONS, LOCK, GET, HEAD, POST, DELETE, PROPPATCH, COPY, MOVE, UNLOCK, PROPFIND, PUT, MKCOL',
      'DAV': '1, 2',
      'MS-Author-Via': 'DAV',
      'Content-Length': '0',
    },
  });
}

// ---------------------------------------------------------------- PROPFIND

async function handlePropfind(request: Request, davPath: string, env: Env): Promise<Response> {
  // Determine depth
  const depthHeader = request.headers.get('Depth') || '1';
  const depth = depthHeader === '0' ? 0 : 1; // "infinity" is too heavy; treat as 1

  const resolved = await resolvePath(davPath, env);
  const basePath = davPath;

  // If path doesn't resolve to a storage, and it's the virtual root listing
  // all storages.
  if (!resolved) {
    if (davPath === '/') {
      // List all storages as top-level folders
      const storages = await env.DB.prepare(
        'SELECT * FROM storages WHERE disabled = 0 ORDER BY order_num ASC'
      ).all();
      const entries = (storages.results || []).map((s: any) => {
        const mount = s.mount_path === '/' ? '' : s.mount_path.replace(/^\//, '');
        return {
          name: mount || s.driver,
          is_dir: true,
          modified: new Date(s.modified || Date.now()).toISOString(),
        };
      });
      const body = buildMultiStatus('/', entries, depth);
      return xmlResponse(body);
    }
    return new Response('Not Found', { status: 404 });
  }

  const { storage } = resolved;
  const driver = await getDriver(storage);
  const addition = JSON.parse(storage.addition);
  const relativePath = resolved.realPath;

  try {
    // Get the object itself
    let obj: any;
    try {
      obj = await driver.get(relativePath, addition);
    } catch {
      obj = { name: davPath.split('/').pop() || davPath, is_dir: true, size: 0, modified: new Date().toISOString() };
    }

    // Build the list of items to report
    const items: Array<{ path: string; obj: any }> = [];
    // The storage mount root appears at its mount path; virtual root at "/"
    const mountLabel = storage.mount_path === '/' ? '' : storage.mount_path.replace(/^\//, '');

    if (davPath === '/') {
      // Root: list storages
      const storages = await env.DB.prepare(
        'SELECT * FROM storages WHERE disabled = 0 ORDER BY order_num ASC'
      ).all();
      const entries = (storages.results || []).map((s: any) => ({
        path: `/${s.mount_path === '/' ? '' : s.mount_path.replace(/^\//, '')}`,
        obj: { name: s.mount_path.replace(/^\//, '') || s.driver, is_dir: true, size: 0, modified: new Date(s.modified || Date.now()).toISOString() },
      }));
      // root itself
      items.push({ path: '/', obj: { name: '/', is_dir: true, size: 0, modified: new Date().toISOString() } });
      if (depth === 1) items.push(...entries);
      return xmlResponse(buildMultiStatusList(items));
    }

    // Non-root: report the target and its children (depth 1)
    items.push({ path: davPath, obj });
    if (depth === 1 && obj.is_dir !== false) {
      const list = await driver.list(relativePath, addition);
      const content = Array.isArray(list.content) ? list.content : [];
      for (const child of content) {
        const childPath = davPath === '/' ? `/${child.name}` : `${davPath}/${child.name}`;
        items.push({ path: childPath, obj: child });
      }
    }

    return xmlResponse(buildMultiStatusList(items));
  } catch (err: any) {
    return new Response('Internal Server Error', { status: errStatus(err) });
  }
}

function buildMultiStatus(basePath: string, entries: Array<{ name: string; is_dir: boolean; modified: string }>, depth: number): string {
  const items: Array<{ path: string; obj: any }> = [];
  items.push({ path: basePath, obj: { name: basePath === '/' ? '/' : basePath.split('/').pop(), is_dir: true, size: 0, modified: new Date().toISOString() } });
  if (depth === 1) {
    for (const e of entries) {
      items.push({
        path: basePath === '/' ? `/${e.name}` : `${basePath}/${e.name}`,
        obj: { ...e, modified: e.modified },
      });
    }
  }
  return buildMultiStatusList(items);
}

function buildMultiStatusList(items: Array<{ path: string; obj: any }>): string {
  const responses = items.map(it => {
    // Ensure trailing slash on dirs
    let href = it.path || '/';
    if (!href.startsWith('/')) href = '/' + href;
    const obj = it.obj || {};
    const isDir = obj.is_dir === true || obj.is_dir === 1;
    if (isDir && !href.endsWith('/')) href += '/';
    // Path for properties uses the WebDAV path (under /dav)
    return objToProps(href, { ...obj, is_dir: isDir });
  }).join('');

  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">${responses}
</D:multistatus>`;
}

function xmlResponse(body: string): Response {
  return new Response(body, {
    status: 207,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'DAV': '1, 2',
    },
  });
}

// ---------------------------------------------------------------- GET/HEAD

async function handleGet(request: Request, davPath: string, env: Env): Promise<Response> {
  const resolved = await resolvePath(davPath, env);
  if (!resolved) return new Response('Not Found', { status: 404 });
  const { storage } = resolved;

  const driver = await getDriver(storage);
  const addition = JSON.parse(storage.addition);

  // Check if it's a directory
  try {
    const obj = await driver.get(resolved.realPath, addition);
    if (obj.is_dir) {
      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'httpd/unix-directory', 'Content-Length': '0' },
        });
      }
      return new Response('Method Not Allowed', { status: 405 });
    }
  } catch {
    return new Response('Not Found', { status: 404 });
  }

  // Get download link and redirect (302)
  const link = await getDriverLink(storage, resolved.realPath, env);
  return new Response(null, {
    status: 302,
    headers: {
      Location: link.url,
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'max-age=0, no-cache, no-store, must-revalidate',
    },
  });
}

// Reuse the download link cache logic from download.ts
async function getDriverLink(storage: any, realPath: string, env: Env): Promise<{ url: string; header?: Record<string, string> }> {
  const cached = await getCachedLink(storage.id, realPath, env);
  if (cached) return cached;

  const lockKey = `dlink:${storage.id}:${realPath}`;
  const acquired = await acquireLock(lockKey, 30, env);
  if (acquired) {
    try {
      const addition = JSON.parse(storage.addition);
      const driver = await getDriverInstance(storage.driver, addition);
      // realPath is already relative to the storage mount (resolvePath did the
      // mount-strip); passing it through getRelativePath again would corrupt
      // the path.
      const link = await driver.link(realPath, addition);
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
  return driver.link(realPath, addition);
}

// ---------------------------------------------------------------- PUT

async function handlePut(request: Request, davPath: string, env: Env): Promise<Response> {
  const resolved = await resolvePath(davPath, env);
  if (!resolved) return new Response('Not Found', { status: 404 });
  const { storage } = resolved;

  const driver = await getDriver(storage);
  const addition = JSON.parse(storage.addition);
  const fileBuffer = await request.arrayBuffer();
  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

  try {
    await driver.put(resolved.realPath, fileBuffer, contentType, addition);
    return new Response(null, { status: 201 });
  } catch (err: any) {
    return new Response(err.message || 'Internal Server Error', { status: errStatus(err, 500) });
  }
}

// ---------------------------------------------------------------- MKCOL

async function handleMkcol(davPath: string, env: Env): Promise<Response> {
  const parentPath = davPath.substring(0, davPath.lastIndexOf('/')) || '/';
  const dirName = davPath.substring(davPath.lastIndexOf('/') + 1);
  const resolved = await resolvePath(parentPath, env);
  if (!resolved) return new Response('Not Found', { status: 404 });

  const driver = await getDriver(resolved.storage);
  const addition = JSON.parse(resolved.storage.addition);
  // driver.mkdir expects the target path
  const targetPath = resolved.realPath === '/' ? `/${dirName}` : `${resolved.realPath}/${dirName}`;

  try {
    await driver.mkdir(targetPath, addition);
    return new Response(null, { status: 201 });
  } catch (err: any) {
    return new Response(err.message || 'Internal Server Error', { status: errStatus(err, 405) });
  }
}

// ---------------------------------------------------------------- DELETE

async function handleDelete(davPath: string, env: Env): Promise<Response> {
  const resolved = await resolvePath(davPath, env);
  if (!resolved) return new Response('Not Found', { status: 404 });

  const driver = await getDriver(resolved.storage);
  const addition = JSON.parse(resolved.storage.addition);
  try {
    await driver.remove(resolved.realPath, addition);
    return new Response(null, { status: 204 });
  } catch (err: any) {
    return new Response(err.message || 'Internal Server Error', { status: errStatus(err, 500) });
  }
}

// ---------------------------------------------------------------- MOVE / COPY

async function handleMove(request: Request, davPath: string, env: Env): Promise<Response> {
  const destHeader = request.headers.get('Destination');
  if (!destHeader) return new Response('Bad Request', { status: 400 });
  const dest = safeDecode(new URL(destHeader).pathname.replace(/^\/dav/, '')) || '/';

  const src = await resolvePath(davPath, env);
  const dst = await resolvePath(dest, env);
  if (!src || !dst) return new Response('Not Found', { status: 404 });

  const driver = await getDriver(src.storage);
  const addition = JSON.parse(src.storage.addition);
  try {
    await driver.move(src.realPath, dst.realPath, addition);
    return new Response(null, { status: 201 });
  } catch (err: any) {
    return new Response(err.message || 'Internal Server Error', { status: errStatus(err, 500) });
  }
}

async function handleCopy(request: Request, davPath: string, env: Env): Promise<Response> {
  const destHeader = request.headers.get('Destination');
  if (!destHeader) return new Response('Bad Request', { status: 400 });
  const dest = safeDecode(new URL(destHeader).pathname.replace(/^\/dav/, '')) || '/';

  const src = await resolvePath(davPath, env);
  const dst = await resolvePath(dest, env);
  if (!src || !dst) return new Response('Not Found', { status: 404 });

  const driver = await getDriver(src.storage);
  const addition = JSON.parse(src.storage.addition);
  try {
    await driver.copy(src.realPath, dst.realPath, addition);
    return new Response(null, { status: 201 });
  } catch (err: any) {
    return new Response(err.message || 'Internal Server Error', { status: errStatus(err, 500) });
  }
}

// ---------------------------------------------------------------- LOCK / UNLOCK

// Simple in-memory lock store (per-isolate; fine for personal use).
const locks = new Map<string, { token: string; owner: string; expires: number }>();

function handleLock(request: Request): Response {
  const url = new URL(request.url);
  const path = url.pathname;
  const token = `opaquelocktoken:${crypto.randomUUID()}`;
  const owner = `<D:href>${xmlEscape(path)}</D:href>`;
  const timeout = request.headers.get('Timeout') || 'Infinite, Second-3600';
  const expiry = Date.now() + 3600 * 1000;
  locks.set(path, { token, owner, expires: expiry });

  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>infinity</D:depth>
      <D:owner>${owner}</D:owner>
      <D:timeout>${timeout}</D:timeout>
      <D:locktoken><D:href>${token}</D:href></D:locktoken>
      <D:lockroot><D:href>${xmlEscape(path)}</D:href></D:lockroot>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Lock-Token': `<${token}>`,
      'DAV': '1, 2',
    },
  });
}

function handleUnlock(): Response {
  return new Response(null, { status: 204 });
}
