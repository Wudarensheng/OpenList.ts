import { ContextLike, Env } from './types';
import { handleRequest } from './router';
import { initializeDatabase } from './models/init';
import { createDatabase } from './db';

let initialized = false;
let initPromise: Promise<void> | null = null;

async function ensureInitialized(env: Env): Promise<void> {
  if (initialized) return;
  // Single-flight: concurrent cold-start requests share the same init instead
  // of each running initializeDatabase, which would serialize on the pool and
  // blow past the platform timeout.
  if (!initPromise) {
    initPromise = (async () => {
      // Route all database operations through the abstraction layer
      // (D1, PostgreSQL or Hyperdrive depending on USE_D1 / PG_ADDRS).
      (env as any).DB = createDatabase(env);
      await initializeDatabase(env);
      initialized = true;
    })().catch(err => {
      initPromise = null; // allow retry on a later request
      throw err;
    });
  }
  await initPromise;
}

export default {
  async fetch(request: Request, env: Env, ctx: ContextLike): Promise<Response> {
    await ensureInitialized(env);
    return handleRequest(request, env, ctx);
  },
};
