/**
 * EdgeOne Makers Function adapter for OpenList.ts.
 *
 * Catch-all route: paths that do not match a static asset in the output
 * directory are handled here. The backend logic lives in
 * `dist-node/server-node.js`, produced by the build command (`node build.js`,
 * configured in edgeone.json).
 *
 * EdgeOne has no D1 binding — set `USE_D1=false` and `PG_ADDRS` in the
 * project environment variables. `context.request` is already a Web-standard
 * Request, so this adapter forwards it straight to `handleFetch`.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

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

// dist-node/server-node.js is CommonJS; load it through require for safety.
const require = createRequire(import.meta.url);
const { handleFetch, createEnv } = require('../dist-node/server-node.js');
const env = createEnv();

export async function onRequest(context) {
  try {
    return await handleFetch(context.request, env);
  } catch (err) {
    console.error('[openlist-ts] edgeone function error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
