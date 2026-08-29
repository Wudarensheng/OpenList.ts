/**
 * D1 compatibility layer.
 *
 * Thin pass-through adapter so every database call goes through the shared
 * `Database` interface while D1 keeps executing the native SQLite SQL.
 */

import { Database, DbResult, DbStatement, D1Like } from './types';

export class D1Adapter implements Database {
  constructor(private readonly db: D1Like) {}

  prepare(sql: string): DbStatement {
    return this.db.prepare(sql) as unknown as DbStatement;
  }

  batch(stmts: DbStatement[]): Promise<DbResult[]> {
    return this.db.batch(stmts as unknown[]) as Promise<DbResult[]>;
  }
}
