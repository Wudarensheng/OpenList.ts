import { Env } from './types';
import { handleRequest } from './router';
import { initializeDatabase } from './models/init';
import { createDatabase } from './db';

let initialized = false;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Initialize database on first request
    if (!initialized) {
      // Route all database operations through the abstraction layer
      // (D1, PostgreSQL or Hyperdrive depending on USE_D1 / PG_ADDRS).
      (env as any).DB = createDatabase(env);
      await initializeDatabase(env);
      initialized = true;
    }
    
    return handleRequest(request, env, ctx);
  },
};
