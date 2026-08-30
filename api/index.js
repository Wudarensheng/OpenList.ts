/**
 * Vercel Function adapter for OpenList.ts.
 *
 * The backend logic lives in `dist-node/server-node.js`, produced by the
 * build command (`node build.js`, configured in vercel.json). This file only
 * adapts Vercel's Node request/response to the Web-standard `Request` /
 * `Response` pair expected by the app's `handleFetch`.
 *
 * Vercel has no D1 binding — set `USE_D1=false` and `PG_ADDRS` in the project
 * environment variables. Static assets under `dist-node/public` are served
 * directly by Vercel; all other paths are rewritten here by vercel.json.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

function resolvePublicDir() {
  const candidates = [
    process.env.PUBLIC_DIR,
    path.join(process.cwd(), 'dist-node', 'public'),
    path.join(__dirname, 'dist-node', 'public'),
    path.join(__dirname, '..', 'dist-node', 'public'),
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

const { handleFetch, createEnv } = require('../dist-node/server-node.js');
const env = createEnv();

module.exports = async function handler(req, res) {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const url = new URL(req.url || '/', `${proto}://${req.headers.host || 'localhost'}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) headers.append(k, x);
      else headers.set(k, v);
    }
    const init = { method: req.method || 'GET', headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = Readable.toWeb(req);
      init.duplex = 'half';
    }
    const request = new Request(url, init);
    const response = await handleFetch(request, env);
    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);
    if (response.body) {
      const stream = Readable.fromWeb(response.body);
      stream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error('[openlist-ts] vercel function error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    } else {
      res.end();
    }
  }
};
