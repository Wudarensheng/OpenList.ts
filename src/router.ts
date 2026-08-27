import { Env } from './types';
import { handleApiRequest } from './routes/api';
import { handleStaticFile } from './routes/static';
import { handleDownloadRequest } from './routes/download';
import { handleShareDownload } from './routes/share';
import { handleWebDavRequest } from './routes/webdav';

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // WebDAV (must come before the generic OPTIONS preflight)
  if (path.startsWith('/dav')) {
    return handleWebDavRequest(request, env);
  }

  // Health check
  if (path === '/ping') {
    return new Response('pong', { status: 200 });
  }

  // robots.txt from settings
  if (path === '/robots.txt') {
    return handleRobotsTxt(env);
  }

  // favicon redirect
  if (path === '/favicon.ico') {
    return handleFavicon(env);
  }

  // iOS app install plist (/i/<link_name>.plist)
  if (path.startsWith('/i/') && path.endsWith('.plist')) {
    return handlePlist(path);
  }

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    });
  }

  // Handle API requests
  if (path.startsWith('/api/')) {
    return handleApiRequest(request, env);
  }

  // Handle manifest.json
  if (path === '/manifest.json') {
    return handleManifest();
  }

  // Handle direct link / proxy download routes (/d/<path>, /p/<path>)
  // and archive inner-file downloads (/ad/<path>, /ap/<path>, /ae/<path>)
  if (path.startsWith('/d/') || path.startsWith('/p/') || path.startsWith('/ad/') || path.startsWith('/ap/') || path.startsWith('/ae/')) {
    return handleDownloadRequest(request, env);
  }

  // Handle share download routes (/sd/<sid>/<path>)
  if (path.startsWith('/sd/')) {
    return handleShareDownload(request, env);
  }

  // Handle static files
  return handleStaticFile(request, env);
}

async function handleRobotsTxt(env: Env): Promise<Response> {
  try {
    const row = await env.DB.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).bind('robots_txt').first();
    const content = (row as any)?.value || 'User-agent: *\nAllow: /';
    return new Response(content, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } catch {
    return new Response('User-agent: *\nAllow: /', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function handleFavicon(env: Env): Promise<Response> {
  try {
    const row = await env.DB.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).bind('favicon').first();
    const favicon = (row as any)?.value || '';
    if (favicon) {
      return Response.redirect(favicon, 302);
    }
  } catch {
    // ignore
  }
  // Serve the bundled favicon if present, otherwise 204
  return new Response(null, { status: 204 });
}

// /i/<link_name>.plist - generate an iOS app install manifest (OpenList's Plist).
function handlePlist(path: string): Response {
  const linkNameB64 = path.slice(3, -6); // strip /i/ and .plist (6 chars)
  // URL-safe base64 variant used by the frontend (matches Go's utils.SafeAtob)
  let b64 = linkNameB64.replace(/-/g, '+').replace(/_/g, '/').replace(/\./g, '=');
  const padLen = b64.length % 4;
  if (padLen) b64 += '='.repeat(4 - padLen);
  let decoded: string;
  try {
    decoded = atob(b64);
  } catch {
    return new Response('malformed link', { status: 400 });
  }
  const parts = decoded.split('/');
  if (parts.length !== 2) {
    return new Response('malformed link', { status: 400 });
  }
  const linkStr = decodeURIComponent(parts[0]);
  const fullName = decodeURIComponent(parts[1]);
  let name = fullName;
  let identifier = `org.oplist.${fullName}`;
  if (fullName.includes('@')) {
    const ss = fullName.split('@');
    name = ss.slice(0, -1).join('@');
    identifier = ss[ss.length - 1];
  }
  const url = linkStr.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
    <dict>
        <key>items</key>
        <array>
            <dict>
                <key>assets</key>
                <array>
                    <dict>
                        <key>kind</key>
                        <string>software-package</string>
                        <key>url</key>
                        <string><![CDATA[${url}]]></string>
                    </dict>
                </array>
                <key>metadata</key>
                <dict>
                    <key>bundle-identifier</key>
					<string>${xmlEscape(identifier)}</string>
					<key>bundle-version</key>
                    <string>4.4</string>
                    <key>kind</key>
                    <string>software</string>
                    <key>title</key>
                    <string>${xmlEscape(name)}</string>
                </dict>
            </dict>
        </array>
    </dict>
</plist>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml;charset=utf-8' } });
}

function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function handleManifest(): Response {
  return new Response(JSON.stringify({
    name: 'OpenList',
    short_name: 'OpenList',
    description: 'A file list program',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1890ff',
    icons: [
      {
        src: '/images/logo.png',
        sizes: '192x192',
        type: 'image/png'
      },
      {
        src: '/images/logo.png',
        sizes: '512x512',
        type: 'image/png'
      }
    ]
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
