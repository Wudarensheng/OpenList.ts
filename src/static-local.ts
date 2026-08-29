/**
 * Local static-file provider for non-Cloudflare platforms.
 *
 * Reads `./public` using the host runtime's native file API only
 * (Bun.file / Deno.readFile). Deliberately avoids any `node:*` import so the
 * module stays portable; on Node the caller should configure STATIC_BASE or
 * serve `public/` with an external static server instead.
 */

import type { AssetProvider } from './types';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.xml': 'text/xml',
  '.webmanifest': 'application/manifest+json',
};

function mimeOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

export function createLocalAssets(rootDir: string): AssetProvider {
  return {
    async fetch(request: Request): Promise<Response> {
      const g = globalThis as any;
      const url = new URL(request.url);
      let rel = url.pathname.replace(/^\/+/, '');
      if (!rel) rel = 'index.html';
      const filePath = `${rootDir}/${rel}`;

      // Bun
      if (g.Bun && typeof g.Bun.file === 'function') {
        const file = g.Bun.file(filePath);
        if (typeof file.exists === 'function' && (await file.exists())) {
          return new Response(file, { headers: { 'Content-Type': mimeOf(filePath) } });
        }
        return new Response('Not Found', { status: 404 });
      }

      // Deno
      if (g.Deno && typeof g.Deno.readFile === 'function') {
        try {
          const data: Uint8Array = await g.Deno.readFile(filePath);
          return new Response(data, { headers: { 'Content-Type': mimeOf(filePath) } });
        } catch {
          return new Response('Not Found', { status: 404 });
        }
      }

      // Node: no standard file API without node:fs.
      return new Response('Not Found', { status: 404 });
    },
  };
}
