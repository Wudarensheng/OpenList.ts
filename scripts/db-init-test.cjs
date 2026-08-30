#!/usr/bin/env node
/**
 * 本地运行真实数据库初始化（诊断用）。
 *
 * 与云端 Cloud Functions 走完全相同的代码路径：
 *   createDatabase(USE_D1=false) + initializeDatabase()
 *
 * 用法:
 *   PG_ADDRS=postgres://user:pass@host:port/dbname node scripts/db-init-test.cjs
 *
 * 结果:
 *   - 成功 -> 表已建好，说明连接串 + TLS + SQL 翻译都没问题，问题在云端环境
 *   - 失败 -> 打印真实错误（CONNECT_TIMEOUT / 认证失败 / 证书 / SQL 语法等）
 */
'use strict';

const { createDatabase } = require('../dist-node/db/index.js');
const { initializeDatabase } = require('../dist-node/models/init.js');

const url = process.env.PG_ADDRS;
if (!url) {
  console.error('[init-test] PG_ADDRS 环境变量未设置');
  process.exit(2);
}

async function main() {
  const env = {
    DB: createDatabase({ USE_D1: 'false', PG_ADDRS: url, HYPERDRIVE: undefined }),
    ENVIRONMENT: 'production',
    USE_D1: 'false',
    PG_ADDRS: url,
  };

  console.log('[init-test] 开始初始化数据库...');
  const started = Date.now();
  try {
    await initializeDatabase(env);
    console.log('[init-test] ✅ 初始化成功，耗时', Date.now() - started, 'ms');
    console.log('[init-test] 表已创建。若云端仍无表，说明云端函数环境/网络与本地不同。');
  } catch (err) {
    console.log('[init-test] ❌ 初始化失败，耗时', Date.now() - started, 'ms');
    console.log('[init-test] 错误:', err && err.message ? err.message : err);
    if (err && err.message && /CONNECT_TIMEOUT/i.test(err.message)) {
      console.log('[init-test] 提示: 连接超时（网络到 5432 不通或 TLS 握手卡住）');
    } else if (err && err.message && /password|auth/i.test(err.message)) {
      console.log('[init-test] 提示: 认证失败，检查用户名/密码');
    } else if (err && err.message && /certificate|ssl|cert/i.test(err.message)) {
      console.log('[init-test] 提示: 证书/TLS 问题');
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[init-test] 未预期错误:', err);
  process.exit(1);
});
