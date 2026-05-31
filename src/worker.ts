import { Env } from './types';
import { handleRequest } from './router';
import { initializeDatabase } from './models/init';

let initialized = false;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Initialize database on first request
    if (!initialized) {
      await initializeDatabase(env);
      initialized = true;
    }
    
    return handleRequest(request, env, ctx);
  },
};
