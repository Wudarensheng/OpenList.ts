/**
 * Netlify Function adapter for OpenList.ts.
 *
 * The backend logic lives in `dist-node/server-node.js`, produced by the
 * build command (`npm install && node build.js`, configured in netlify.toml).
 * This file only adapts Netlify's function event to the Web-standard
 * `Request` / `Response` pair expected by the app's `handleFetch`.
 *
 * Netlify has no D1 binding — set `USE_D1=false` and `PG_ADDRS` in the site
 * environment variables. Static assets under `dist-node/public` are served
 * directly by Netlify; all other paths reach this function via netlify.toml.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolvePublicDir() {
  const candidates = [
    process.env.PUBLIC_DIR,
    path.join(process.cwd(), 'dist-node', 'public'),
    path.join(__dirname, '..', '..', 'dist-node', 'public'),
    path.join(__dirname, 'dist-node', 'public'),
    path.join(__dirname, 'public'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.statSync(path.join(p, 'index.html')).isFile()) return p;
    } catch {
      // try next candidate
    }
  }
  return null;
}

process.env.PUBLIC_DIR = resolvePublicDir() || '';

const { handleFetch, createEnv } = require('../../dist-node/server-node.js');
const env = createEnv();

exports.handler = async (event) => {
  try {
    const host = event.headers.host || 'localhost';
    const query = event.rawQuery ? `?${event.rawQuery}` : '';
    const url = `https://${host}${event.path || '/'}${query}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(event.headers || {})) {
      if (v !== undefined) headers.set(k, v);
    }
    const init = { method: event.httpMethod || 'GET', headers };
    if (event.body) {
      init.body = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : event.body;
    }
    const request = new Request(url, init);
    const response = await handleFetch(request, env);
    const outHeaders = {};
    for (const [k, v] of response.headers.entries()) outHeaders[k] = v;
    const buf = Buffer.from(await response.arrayBuffer());
    return {
      statusCode: response.status,
      headers: outHeaders,
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('[openlist-ts] netlify function error:', err);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};
