/**
 * Cross-platform entry point for running OpenList.ts OUTSIDE Cloudflare Workers.
 *
 * Serves the exact same request handler as the Worker, using only Web-standard
 * Request/Response semantics on the host runtime:
 *
 *   - Bun:   bun run src/server.ts
 *   - Deno:  deno run --allow-net --allow-read --allow-env src/server.ts
 *
 * No `node:*` imports are used. Node has no built-in standard `serve` API, so
 * it is not launched here; wrap `handleFetch` with node:http yourself if you
 * must run on Node (the printed error shows how).
 *
 * Requirements (no D1 binding exists off Cloudflare):
 *   USE_D1=false  +  PG_ADDRS=postgres://user:pass@host:5432/dbname
 * Optional: STATIC_BASE=https://... (external static server), PORT (default 3000).
 */

import { createDatabase } from './db';
import { handleRequest } from './router';
import { createLocalAssets } from './static-local';
import { initializeDatabase } from './models/init';
import type { ContextLike } from './types';

function readEnv(name: string): string | undefined {
  const g = globalThis as any;
  if (g.Deno && typeof g.Deno.env?.get === 'function') {
    try {
      return g.Deno.env.get(name);
    } catch {
      // ignore
    }
  }
  return g.process?.env?.[name];
}

export async function main(): Promise<void> {
  const useD1 = (readEnv('USE_D1') ?? 'false').toLowerCase() === 'true';
  const pgAddrs = readEnv('PG_ADDRS');

  const db = createDatabase({
    USE_D1: useD1 ? 'true' : 'false',
    PG_ADDRS: pgAddrs,
    HYPERDRIVE: undefined,
  } as any);

  const env = {
    DB: db,
    ENVIRONMENT: 'production',
    ASSETS: undefined,
    USE_D1: useD1 ? 'true' : 'false',
    PG_ADDRS: pgAddrs,
    HYPERDRIVE: undefined,
    STATIC_BASE: readEnv('STATIC_BASE'),
    LOCAL_STATIC: createLocalAssets('public'),
  } as any;

  // Create tables / seed default data (same as the Worker entry). Without this
  // the PostgreSQL database is only connected but never initialized, so every
  // query fails on missing tables.
  await initializeDatabase(env);
  console.log('[openlist-ts] database initialized');

  const handleFetch = (request: Request) => handleRequest(request, env, {} as ContextLike);

  const port = Number(readEnv('PORT') || 3000);
  const g = globalThis as any;

  if (g.Bun && typeof g.Bun.serve === 'function') {
    g.Bun.serve({ port, fetch: handleFetch });
    console.log(`[openlist-ts] listening on http://localhost:${port}`);
    return;
  }

  if (g.Deno && typeof g.Deno.serve === 'function') {
    g.Deno.serve({ port, handler: handleFetch });
    console.log(`[openlist-ts] listening on http://localhost:${port}`);
    return;
  }

  console.error(
    '[openlist-ts] No standard server API detected.\n' +
      'Run with Bun or Deno, or wrap the fetch handler with node:http yourself:\n' +
      '  import http from "node:http";\n' +
      '  http.createServer((req, res) => { ...req -> Request, then write Response... }).listen(port);'
  );
}

main().catch(err => {
  console.error('[openlist-ts] failed to start:', err);
});
