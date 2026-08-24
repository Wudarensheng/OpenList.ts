/**
 * Download / Proxy routes
 * Matches AList's /d/ (direct link) and /p/ (proxy) endpoints.
 * - GET /d/<path>  -> 302 redirect to the driver's direct link (or proxy if web_proxy enabled)
 * - GET /p/<path>  -> stream the file through this worker
 */

import { Env } from '../types';
import { getStorageForPath, getRelativePath } from './fs';
import { getDriverInstance } from '../drivers/registry';
import { getCachedLink, cacheLink, acquireLock, releaseLock } from '../cache';

export async function handleDownloadRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith('/d/')) {
    const rawPath = decodePath(path.substring(3));
    return handleDirect(rawPath, request, env);
  }

  if (path.startsWith('/p/')) {
    const rawPath = decodePath(path.substring(3));
    return handleProxy(rawPath, request, env);
  }

  return new Response('Not Found', { status: 404 });
}

function decodePath(p: string): string {
  const decoded = decodeURIComponent(p);
  return decoded.startsWith('/') ? decoded : '/' + decoded;
}

async function getStorage(rawPath: string, env: Env): Promise<any> {
  const storage = await getStorageForPath(rawPath, env);
  if (!storage) return null;
  return storage;
}

// Resolve a download link for a file, using the D1 link cache to avoid
// re-hitting the storage provider on every download of the same file.
// Singleflight ensures concurrent requests share one provider call.
async function getLink(storage: any, rawPath: string, env: Env): Promise<{ url: string; header?: Record<string, string> }> {
  const cached = await getCachedLink(storage.id, rawPath, env);
  if (cached) return cached;

  const lockKey = `dlink:${storage.id}:${rawPath}`;
  const acquired = await acquireLock(lockKey, 30, env);
  if (acquired) {
    try {
      const addition = JSON.parse(storage.addition);
      const driver = await getDriverInstance(storage.driver, addition);
      const relativePath = getRelativePath(rawPath, storage.mount_path);
      const link = await driver.link(relativePath, addition);
      const cacheExpiration = storage.cache_expiration || 30;
      await cacheLink(storage.id, rawPath, link, cacheExpiration * 60, env);
      return link;
    } finally {
      await releaseLock(lockKey, env);
    }
  }

  // Another request is generating the link; wait briefly and read from cache.
  await new Promise(resolve => setTimeout(resolve, 500));
  const retry = await getCachedLink(storage.id, rawPath, env);
  if (retry) return retry;

  // Fallback: generate without caching (lock contention timed out).
  const addition = JSON.parse(storage.addition);
  const driver = await getDriverInstance(storage.driver, addition);
  const relativePath = getRelativePath(rawPath, storage.mount_path);
  return driver.link(relativePath, addition);
}

// GET /d/<path>: 302 to direct link, or proxy when web_proxy is enabled
async function handleDirect(rawPath: string, request: Request, env: Env): Promise<Response> {
  const storage = await getStorage(rawPath, env);
  if (!storage) return new Response('Not Found', { status: 404 });

  // If the storage is configured to proxy, stream through this worker
  if (storage.web_proxy) {
    return handleProxy(rawPath, request, env);
  }

  const link = await getLink(storage, rawPath, env);

  // If the driver returned custom headers, a plain 302 cannot carry them -> proxy instead
  if (link.header && Object.keys(link.header).length > 0) {
    return proxyLink(link, rawPath, request);
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

// GET /p/<path>: stream the file through this worker
async function handleProxy(rawPath: string, request: Request, env: Env): Promise<Response> {
  const storage = await getStorage(rawPath, env);
  if (!storage) return new Response('Not Found', { status: 404 });

  const link = await getLink(storage, rawPath, env);

  return proxyLink(link, rawPath, request);
}

// Fetch the remote URL and stream it back with download/preview headers
async function proxyLink(link: { url: string; header?: Record<string, string> }, rawPath: string, request: Request): Promise<Response> {
  const isHead = request.method === 'HEAD';
  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  const headers: Record<string, string> = { ...(link.header || {}) };
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;
  const userAgent = request.headers.get('User-Agent');
  if (userAgent) headers['User-Agent'] = userAgent;

  // Presigned URLs are typically only valid for GET. A HEAD request to the
  // upstream would be rejected (403) by providers like B2, so for HEAD we
  // issue a ranged GET upstream and drop the body.
  let upstream: Response;
  let syntheticRange = false;
  if (isHead) {
    const headHeaders = { ...headers };
    if (!headHeaders['Range']) {
      headHeaders['Range'] = 'bytes=0-0';
      syntheticRange = true;
    }
    upstream = await fetch(link.url, {
      method: 'GET',
      headers: headHeaders,
      redirect: 'follow',
    });
  } else {
    upstream = await fetch(link.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
    });
  }

  const filename = rawPath.split('/').pop() || 'file';
  const contentType = upstream.headers.get('Content-Type') || 'application/octet-stream';

  const outHeaders = new Headers();
  outHeaders.set('Content-Type', contentType);
  if (upstream.headers.get('Content-Range')) {
    outHeaders.set('Content-Range', upstream.headers.get('Content-Range')!);
    // For HEAD probes using "bytes=0-0", Content-Range looks like
    // "bytes 0-0/<total>". Report the full size as Content-Length.
    const cr = upstream.headers.get('Content-Range')!;
    const total = cr.split('/')[1];
    if (total && total !== '*') {
      outHeaders.set('Content-Length', total);
    }
  } else if (upstream.headers.get('Content-Length')) {
    outHeaders.set('Content-Length', upstream.headers.get('Content-Length')!);
  }
  if (upstream.headers.get('Accept-Ranges')) {
    outHeaders.set('Accept-Ranges', upstream.headers.get('Accept-Ranges')!);
  }
  outHeaders.set('Referrer-Policy', 'no-referrer');
  outHeaders.set('Cache-Control', 'max-age=0, no-cache, no-store, must-revalidate');

  // RFC 6266: filename must be ASCII; non-ASCII goes in filename*
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_');
  const disposition = type === 'preview'
    ? 'inline'
    : `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  outHeaders.set('Content-Disposition', disposition);

  let status = upstream.status === 206 ? 206 : upstream.ok ? 200 : upstream.status;
  if (isHead && syntheticRange && status === 206) {
    // A HEAD probe with a synthetic range returns 206 upstream; expose it as
    // 200 with the full Content-Length so clients can size the file.
    status = 200;
  }
  return new Response(isHead ? null : upstream.body, { status, headers: outHeaders });
}
