/**
 * EdgeOne Cloud Function adapter for /api/* routes.
 *
 * Workaround: the root cloud-functions/[[default]].js was timing out on the
 * EdgeOne platform (CLOUD_FUNCTION_INVOCATION_TIMEOUT) even though the app
 * code itself works (verified via /dbdiag running the same handleFetch).
 * Routing /api/** to this dedicated file bypasses the problematic catch-all.
 *
 * Uses the exact same pattern as dbdiag.js (require + export default), which
 * is proven to work in EdgeOne Cloud Functions.
 */
'use strict';

const { handleFetch, createEnv } = require('../../dist-node/server-node.js');
const env = createEnv();

export default async function onRequest(context) {
  try {
    return await handleFetch(context.request, env);
  } catch (err) {
    console.error('[openlist-ts] edgeone api function error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
}
