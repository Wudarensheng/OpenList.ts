#!/usr/bin/env node
/**
 * Database connection diagnostic for PostgreSQL mode.
 *
 * Tells you definitively whether the problem is:
 *   1) cannot connect to the database, or
 *   2) connected but tables were never initialized.
 *
 * Replicates the exact connection options used by src/db/postgres.ts
 * (max:1, prepare:false, bigint normalization, TLS default when the
 * connection string does not specify sslmode).
 *
 * Usage:
 *   PG_ADDRS=postgres://user:pass@host:port/dbname node scripts/db-diagnose.cjs
 *
 * (On Windows: set PG_ADDRS in the environment or use your normal env var,
 *  then just run `node scripts/db-diagnose.cjs`.)
 */
'use strict';

const postgres = require('postgres');

const url = process.env.PG_ADDRS;
if (!url) {
  console.error('[diag] PG_ADDRS 环境变量未设置');
  console.error('[diag] 例如: PG_ADDRS=postgres://user:pass@host:5432/dbname node scripts/db-diagnose.cjs');
  process.exit(2);
}

// Mirror src/db/postgres.ts TLS fallback.
function tlsConfigured(connectionString) {
  const queryIdx = connectionString.indexOf('?');
  const hasSslmode =
    queryIdx !== -1 && /(?:^|&)sslmode=/i.test(connectionString.slice(queryIdx + 1));
  if (hasSslmode) return true;
  return !!process.env.PGSSL;
}

function redacted(u) {
  try {
    const parsed = new URL(u);
    parsed.password = '***';
    return parsed.toString();
  } catch {
    return u;
  }
}

const TABLES = [
  'users', 'settings', 'storages', 'files', 'file_cache', 'file_links',
  'request_locks', 'shares', 'login_attempts', 'invalid_tokens', 'tasks',
  'metas', 'sso_states',
];

async function main() {
  console.log('[diag] 目标:', redacted(url));
  console.log('[diag] sslmode 已显式指定:', tlsConfigured(url) ? '是' : '否(将默认走 TLS)');

  const sql = postgres(url, {
    max: 1,
    prepare: false,
    types: {
      bigint: {
        to: 20,
        from: [20],
        parse: (x) => Number(x),
        serialize: (x) => String(x),
      },
    },
    ...(tlsConfigured(url) ? {} : { ssl: 'require' }), // encrypt, skip cert verify
  });

  // 1) Connection test
  try {
    const rows = await sql.unsafe('SELECT 1 AS ok');
    console.log('[diag] ✅ 数据库连接成功 (SELECT 1 =', rows[0] && rows[0].ok, ')');
  } catch (err) {
    console.log('[diag] ❌ 数据库连接失败 —— 问题在“连不上数据库”');
    console.log('[diag] 错误:', err && err.message ? err.message : String(err));
    if (err && err.message && /ssl|certificate|tls|TLS/i.test(err.message)) {
      console.log('[diag] 提示: 看起来是 TLS/证书问题。若你的库用自签名证书，');
      console.log('[diag]        可在连接串里加 ?sslmode=require 跳过证书校验。');
    } else if (err && err.message && /password|auth|password authentication/i.test(err.message)) {
      console.log('[diag] 提示: 认证失败，请检查用户名/密码。');
    } else if (err && err.message && /connect|ECONNREFUSED|timed out|timeout/i.test(err.message)) {
      console.log('[diag] 提示: 网络不通或地址/端口错误，请检查 host:port 与防火墙。');
    }
    await sql.end().catch(() => {});
    process.exit(1);
  }

  // 2) Table existence test
  const tableList = TABLES.join("','");
  let rows;
  try {
    rows = await sql.unsafe(
      `SELECT t.table_name FROM information_schema.tables t
       WHERE t.table_schema = 'public' AND t.table_name IN ('${tableList}')`
    );
  } catch (err) {
    console.log('[diag] ❌ 查询表清单失败:', err.message);
    await sql.end().catch(() => {});
    process.exit(1);
  }

  const existing = new Set(rows.map((r) => r.table_name));
  const missing = TABLES.filter((t) => !existing.has(t));

  if (missing.length === 0) {
    console.log('[diag] ✅ 全部 13 张表已存在，数据库已初始化');
    console.log('[diag] 结论: 连接和初始化都没问题，问题应出在应用启动/其他环节。');
  } else {
    console.log('[diag] ❌ 数据库已连上，但以下表不存在 —— 问题在“没初始化数据库”');
    console.log('[diag] 缺失:', missing.join(', '));
    console.log('[diag] 已存在:', existing.size > 0 ? [...existing].join(', ') : '(无)');
    console.log('[diag] 解决: 启动应用时 src/server.ts 会调用 initializeDatabase 建表;');
    console.log('[diag]        或确认启动的是最新代码(含“database initialized”日志)。');
  }

  await sql.end().catch(() => {});
}

main().catch((err) => {
  console.error('[diag] 未预期错误:', err);
  process.exit(1);
});
