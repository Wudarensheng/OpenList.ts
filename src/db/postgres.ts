/**
 * PostgreSQL compatibility layer (also used for Cloudflare Hyperdrive).
 *
 * Runs on postgres.js, a pure-JS driver that works across platforms
 * (Workers, Node, Deno, Bun) and accepts a Hyperdrive connection string.
 *
 * Every statement is translated from the SQLite/D1 dialect by `toPostgresSql`,
 * so business code stays backend-agnostic.
 */

import postgres from 'postgres';
import { Database, DbResult, DbStatement, TABLE_PRIMARY_KEYS } from './types';
import { toPostgresSql } from './sqlite';

/** Minimal executor surface shared by the pool and a transaction. */
type Executor = {
  unsafe(query: string, params?: unknown[]): Promise<unknown[]>;
};

/**
 * Whether TLS is configured for the connection. postgres.js negotiates SSL
 * from (in priority order) the options object, the connection string's
 * `?sslmode=` parameter, then the `PGSSL` env var; default is plaintext.
 */
function tlsConfigured(connectionString: string): boolean {
  const queryIdx = connectionString.indexOf('?');
  const hasSslmode =
    queryIdx !== -1 && /(?:^|&)sslmode=/i.test(connectionString.slice(queryIdx + 1));
  if (hasSslmode) return true;
  return typeof process !== 'undefined' && !!process.env?.PGSSL;
}

function buildResult(rows: unknown[], originalSql: string): DbResult {
  let lastRowId: number | undefined;
  const m = originalSql.match(/^\s*INSERT\s+INTO\s+(\w+)/i);
  if (m) {
    const pks = TABLE_PRIMARY_KEYS[m[1].toLowerCase()];
    const firstRow = rows[0] as Record<string, unknown> | undefined;
    const pk = pks && pks.length > 0 ? pks[0] : undefined;
    const raw = pk && firstRow ? firstRow[pk] : undefined;
    if (raw !== undefined && raw !== null) {
      const num = Number(raw);
      lastRowId = Number.isNaN(num) ? undefined : num;
    }
  }
  return {
    success: true,
    meta: { last_row_id: lastRowId, changes: rows.length, duration: 0 },
    results: rows,
  };
}

class PgStatement implements DbStatement {
  private params: unknown[] = [];

  constructor(
    private readonly exe: Executor,
    private readonly pgSql: string,
    private readonly originalSql: string
  ) {}

  bind(...params: unknown[]): DbStatement {
    this.params = params;
    return this;
  }

  async run(): Promise<DbResult> {
    const rows = await this.exe.unsafe(this.pgSql, this.params);
    return buildResult(rows, this.originalSql);
  }

  async first(colName?: string): Promise<unknown> {
    const rows = await this.exe.unsafe(this.pgSql, this.params);
    const row = rows[0] ?? null;
    if (row && colName) {
      return (row as Record<string, unknown>)[colName];
    }
    return row;
  }

  async all(): Promise<{ results: unknown[]; success: boolean }> {
    const rows = await this.exe.unsafe(this.pgSql, this.params);
    return { results: rows, success: true };
  }

  /** Execute inside a transaction (used by Database.batch). */
  async runOn(exe: Executor): Promise<DbResult> {
    const rows = await exe.unsafe(this.pgSql, this.params);
    return buildResult(rows, this.originalSql);
  }
}

export class PostgresAdapter implements Database {
  private readonly sql: postgres.Sql;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, {
      max: 1,
      prepare: false, // required in serverless / multi-isolate environments
      // Fail fast instead of hanging: without this, a dropped/unreachable
      // network path keeps postgres.js retrying and serverless platforms
      // (e.g. EdgeOne Cloud Functions with maxDuration 60s) kill the function
      // with an opaque "invocation timeout". 10s surfaces a real CONNECT_TIMEOUT.
      connect_timeout: 10,
      // int8 (OID 20, e.g. COUNT(*)) arrives as a string by default; normalize
      // to number so `(countRow as any)?.total || 0` keeps working.
      types: {
        bigint: {
          to: 20,
          from: [20],
          parse: (x: string) => Number(x),
          serialize: (x: number) => String(x),
        },
      },
      // postgres.js defaults to plaintext (`ssl: false`). Neon / Supabase
      // *transaction poolers* (e.g. `*.pooler.supabase.com:6543`) require TLS
      // and reject plaintext connections, yet their sample connection strings
      // often omit `?sslmode=`. Default to TLS unless the string (or PGSSL)
      // already picks a mode explicitly, so pooler URLs connect out of the box.
      //
      // Use `ssl: 'require'` (encrypt, skip cert verification) rather than
      // `ssl: true`: Supabase/Neon pooler cert chains contain a self-signed
      // certificate, so full verification fails with SELF_SIGNED_CERT_IN_CHAIN.
      // Callers who want verification can set `?sslmode=verify-full` explicitly.
      ...(tlsConfigured(connectionString) ? {} : { ssl: 'require' as const }),
    });
  }

  prepare(sql: string): DbStatement {
    return new PgStatement(this.sql as unknown as Executor, toPostgresSql(sql), sql);
  }

  /** Execute a batch atomically inside a single transaction (mimics D1.batch). */
  async batch(stmts: DbStatement[]): Promise<DbResult[]> {
    return this.sql.begin(async tx => {
      const out: DbResult[] = [];
      for (const stmt of stmts) {
        out.push(await (stmt as PgStatement).runOn(tx as unknown as Executor));
      }
      return out;
    }) as unknown as Promise<DbResult[]>;
  }
}
