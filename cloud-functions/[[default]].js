/**
 * EdgeOne Makers Function adapter for OpenList.ts.
 *
 * Catch-all route: paths that do not match a static asset in the output
 * directory are handled here. The backend logic lives in
 * `dist-node/server-node.js`, produced by the build command (`node build.js`,
 * configured in edgeone.json).
 *
 * IMPORTANT: keep this file in the exact same shape as dbdiag.js /
 * api/[[default]].js. It must (1) NOT use `__dirname` (undefined in ESM, the
 * previous version threw at module load on EdgeOne) and (2) use `export
 * default onRequest` (EdgeOne Cloud Functions expect a default export).
 *
 * EdgeOne has no D1 binding — set `USE_D1=false` and `PG_ADDRS` in the
 * project environment variables. `context.request` is already a Web-standard
 * Request, so this adapter forwards it straight to `handleFetch`.
 */
'use strict';

const { handleFetch, createEnv } = require('../dist-node/server-node.js');
const env = createEnv();

export default async function onRequest(context) {
  try {
    return await handleFetch(context.request, env);
  } catch (err) {
    console.error('[openlist-ts] edgeone function error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
