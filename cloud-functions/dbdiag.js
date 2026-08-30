/**
 * EdgeOne Cloud Functions 网络自测（诊断用，排查后可删除）。
 *
 * 从 Cloud Functions 内部测试到 PostgreSQL 数据库的网络连通性，
 * 区分「DNS 解析卡住」还是「TCP 连不上/被防火墙丢弃」。
 *
 * 路由: <你的域名>/dbdiag
 * 需要: 环境变量 PG_ADDRS（与主应用同一个）
 */
'use strict';

const dns = require('node:dns');
const net = require('node:net');
const { URL } = require('node:url');

let postgres = null;
try {
  postgres = require('postgres');
} catch {
  // postgres 未安装时跳过数据库协议测试
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' TIMEOUT ' + ms + 'ms')), ms)),
  ]);
}

function parsePg(urlStr) {
  try {
    const u = new URL(urlStr);
    return { host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1) };
  } catch (e) {
    return { error: String(e) };
  }
}

function lookupHost(host, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'DNS_TIMEOUT' }), timeoutMs);
    dns.lookup(host, (err, address) => {
      clearTimeout(timer);
      if (err) return resolve({ ok: false, error: 'DNS_ERROR: ' + err.code + ' ' + err.message });
      resolve({ ok: true, address });
    });
  });
}

function tcpConnect(host, port, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'TCP_TIMEOUT' }), timeoutMs);
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true, error: null }));
    socket.once('timeout', () => finish({ ok: false, error: 'TCP_SOCKET_TIMEOUT' }));
    socket.once('error', (err) => finish({ ok: false, error: 'TCP_ERROR: ' + err.code + ' ' + err.message }));
    socket.connect(port, host);
  });
}

export default async function onRequest(context) {
  const started = Date.now();
  const out = { ok: false, step: 'init', ms: 0, pg_addrs: false, details: {} };

  const urlStr = process.env.PG_ADDRS || (context.env && context.env.PG_ADDRS);
  if (!urlStr) {
    out.error = '环境变量 PG_ADDRS 未设置';
  } else {
    out.pg_addrs = true;
    const parsed = parsePg(urlStr);
    if (parsed.error) {
      out.error = 'PG_ADDRS 解析失败: ' + parsed.error;
    } else {
      out.details.parsed = { host: parsed.host, port: parsed.port, database: parsed.database };

      out.step = 'dns';
      const d = await lookupHost(parsed.host);
      out.details.dns = d;
      if (!d.ok) {
        out.error = 'DNS 解析失败/超时（主机名在云端解析不了）';
      } else {
        out.step = 'tcp';
        const t = await tcpConnect(parsed.host, parsed.port);
        out.details.tcp = t;
        if (!t.ok) {
          out.error = 'TCP 连不上 ' + parsed.host + ':' + parsed.port +
            '（可能是数据库 IP 白名单/防火墙/端口不通）';
        } else {
          out.step = 'pg';
          // 用与应用相同的配置实际执行一次查询（TLS + 连接 + 协议层验证）
          if (!postgres) {
            out.error = '网络层连通正常，但 postgres 模块不可用，无法做协议层测试';
          } else {
            const sql = postgres(urlStr, {
              max: 1,
              prepare: false,
              connect_timeout: 10,
              // 与应用一致：无 sslmode 时加密但不校验证书
              ssl: /(?:^|&)sslmode=/i.test((urlStr.match(/\?([^#]*)/) || ['', ''])[1])
                ? undefined
                : 'require',
            });
            try {
              const r = await sql.unsafe('SELECT 1 AS ok');
              out.details.pgSelect = r;
              const t2 = await sql.unsafe(
                "SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public'"
              );
              out.details.pgTables = t2;

              // 带参数的查询（走 extended protocol + Describe）——这是应用实际使用的路径
              const t0 = Date.now();
              const t3 = await withTimeout(
                sql.unsafe('SELECT 1 AS ok WHERE $1::int = 1', [1]),
                15000, 'pgParam'
              );
              out.details.pgParamMs = Date.now() - t0;
              out.details.pgParam = t3;
              const t4 = await withTimeout(
                sql.unsafe('SELECT key, value FROM settings WHERE flag = $1::int LIMIT 1', [0]),
                15000, 'pgSettings'
              );
              out.details.pgSettingsQuery = t4;

              out.ok = true;
              out.step = 'done';
              out.error = '数据库查询成功，public schema 下表数量: ' + (t2 && t2[0] && t2[0].tables);
            } catch (e) {
              out.error = '数据库协议层失败: ' + (e && e.message ? e.message : e);
            } finally {
              await sql.end().catch(() => {});
            }
          }
        }
      }
    }
  }

  out.ms = Date.now() - started;
  return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json' } });
}
