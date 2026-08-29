/**
 * Database abstraction layer - shared interface.
 *
 * All business code talks to this interface (via `env.DB`), never to a
 * concrete backend. The API surface mirrors Cloudflare D1 so existing code
 * keeps working unchanged; the PostgreSQL adapter translates the SQLite-flavored
 * SQL internally.
 *
 * This module deliberately imports NO Cloudflare-specific types so the
 * abstraction layer stays portable across platforms (Workers, Node, Deno, Bun).
 */

// ---------------------------------------------------------------------------
// statement / result
// ---------------------------------------------------------------------------

export interface DbResult {
  success: boolean;
  meta: {
    /** Last inserted row id (integer primary key tables only). */
    last_row_id?: number;
    changes?: number;
    duration?: number;
  };
  results?: unknown[];
}

export interface DbStatement {
  bind(...params: unknown[]): DbStatement;
  run(): Promise<DbResult>;
  first(colName?: string): Promise<unknown>;
  all(): Promise<{ results: unknown[]; success: boolean }>;
}

export interface Database {
  prepare(sql: string): DbStatement;
  batch(stmts: DbStatement[]): Promise<DbResult[]>;
}

// ---------------------------------------------------------------------------
// D1 duck type (structural, avoids depending on @cloudflare/workers-types)
// ---------------------------------------------------------------------------

export interface D1Like {
  prepare(sql: string): unknown;
  batch(stmts: unknown[]): Promise<unknown[]>;
}

// ---------------------------------------------------------------------------
// table metadata used by the SQLite -> PostgreSQL translator
// ---------------------------------------------------------------------------

/** Primary key column(s) per table, in declaration order. */
export const TABLE_PRIMARY_KEYS: Record<string, string[]> = {
  users: ['id'],
  settings: ['key'],
  storages: ['id'],
  files: ['id'],
  file_cache: ['path', 'storage_id'],
  file_links: ['storage_id', 'path'],
  request_locks: ['key'],
  shares: ['id'],
  login_attempts: ['ip'],
  invalid_tokens: ['token_hash'],
  tasks: ['id'],
  metas: ['id'],
  sso_states: ['state'],
};
