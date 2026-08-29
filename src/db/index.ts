/**
 * Database abstraction layer entry point.
 *
 * This is the single control point ("总控制函数") for choosing which database
 * backend backs `env.DB`:
 *
 *   USE_D1 = "true" (default)  -> D1 adapter (Cloudflare)
 *   USE_D1 = "false"           -> PostgreSQL adapter; connection string comes
 *                                 from the Hyperdrive binding first (Cloudflare),
 *                                 otherwise from the PG_ADDRS environment var
 *                                 (any platform, cross-cloud).
 *
 * Every database operation in the codebase flows through the returned
 * `Database` interface.
 */

import type { Env } from '../types';
import { D1Adapter } from './d1';
import { PostgresAdapter } from './postgres';

export type { Database, DbResult, DbStatement } from './types';
export { TABLE_PRIMARY_KEYS } from './types';

export function createDatabase(env: Env) {
  const useD1 = env.USE_D1 !== 'false'; // default to D1 to preserve existing behavior

  if (useD1) {
    if (!env.DB) {
      throw new Error('USE_D1=true but no D1 binding (DB) is configured');
    }
    return new D1Adapter(env.DB);
  }

  const connectionString = env.HYPERDRIVE?.connectionString || env.PG_ADDRS;
  if (!connectionString) {
    throw new Error('USE_D1=false but neither HYPERDRIVE binding nor PG_ADDRS is configured');
  }
  return new PostgresAdapter(connectionString);
}
