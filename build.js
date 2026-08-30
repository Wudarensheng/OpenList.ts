#!/usr/bin/env node
/**
 * build.js — Node.js build entry for OpenList.ts.
 *
 * Usage (cloud-function vendors, CI, or any Node environment):
 *
 *     node build.js
 *
 * What it does:
 *   1. Releases the embedded Node.js entry (`src/server-node.ts`) into the
 *      source tree.
 *   2. Compiles the whole project — core + the released node entry — to
 *      CommonJS under `dist-node/` using the project's TypeScript
 *      devDependency (`ts.transpileModule`, syntax-only, no type deps).
 *   3. Copies `public/` into `dist-node/` and writes `dist-node/package.json`
 *      so the folder is a self-contained Node deployment.
 *   4. Removes `src/server-node.ts` again, so the core codebase never carries
 *      any node-specific code.
 *
 * The core codebase (`src/`) deliberately contains zero `node:*` imports. This
 * script is the only node-specific piece of the repository — it is the single
 * place that adds the Node.js entry. The node entry code lives inside the
 * embedded block below (between the NODE_ENTRY markers); build.js extracts it
 * verbatim, so no escaping issues can occur.
 *
 * Output entry: dist-node/server-node.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const ENTRY_REL = 'src/server-node.ts';
const OUT_REL = 'dist-node';

// Marker strings include the comment syntax so they can never collide with the
// constant definitions above when build.js searches its own source. They appear
// exactly twice in this file (in these definitions and in the embedded block
// below); `lastIndexOf` guarantees extraction targets the embedded block.
const ENTRY_START = '/* ====== NODE_ENTRY_START ======';
const ENTRY_END = '====== NODE_ENTRY_END ====== */';

main();

function main() {
  const ts = loadTypeScript();
  const entryPath = path.join(ROOT, ENTRY_REL);

  // 1. Release the embedded node entry into the source tree.
  const entrySource = extractNodeEntry();
  fs.writeFileSync(entryPath, entrySource, 'utf8');
  console.log('[build.js] released node entry -> ' + ENTRY_REL);

  try {
    // 2. Compile core + node entry to CommonJS under dist-node/.
    const files = compileNode(ts);

    // 3. Make dist-node/ self-contained.
    copyPublic();
    writePackageJson();

    console.log('[build.js] built ' + files.length + ' modules -> ' + OUT_REL + '/');
    console.log('[build.js] node entry: ' + OUT_REL + '/server-node.js');
    console.log(
      '[build.js] run with: node ' + OUT_REL +
      '/server-node.js   (env: PORT, USE_D1, PG_ADDRS, STATIC_BASE, PUBLIC_DIR, HOST)'
    );
  } finally {
    // 4. Cleanup: keep the core codebase node-free.
    fs.rmSync(entryPath, { force: true });
  }
}

function extractNodeEntry() {
  const src = fs.readFileSync(__filename, 'utf8');
  const start = src.lastIndexOf(ENTRY_START);
  const end = src.lastIndexOf(ENTRY_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('[build.js] embedded node entry markers not found in build.js');
  }
  let code = src.slice(start + ENTRY_START.length, end);
  // The start marker sits on a `/* ... */` comment line; drop that line.
  const nl = code.indexOf('\n');
  if (nl >= 0) code = code.slice(nl + 1);
  code = code.replace(/^\n+/, '').replace(/\n+$/, '');
  return code + '\n';
}

function loadTypeScript() {
  let ts;
  try {
    ts = require('typescript');
  } catch {
    try {
      ts = require(path.join(ROOT, 'node_modules', 'typescript'));
    } catch {
      throw new Error(
        '[build.js] typescript not found. Run `npm install` / `pnpm install` first ' +
        '(typescript is a devDependency of this project).'
      );
    }
  }
  return ts;
}

function compileNode(ts) {
  const srcDir = path.join(ROOT, 'src');
  const outDir = path.join(ROOT, OUT_REL);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // Syntax-only transpile: no type resolution is needed, so the build cannot
  // fail on CF vs Node global type differences. The compiled modules still
  // mirror the src/ layout, so relative requires resolve at runtime.
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
    isolatedModules: true,
  };

  const files = collectSourceFiles(srcDir);
  const written = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const result = ts.transpileModule(source, {
      compilerOptions: options,
      fileName: file,
      reportDiagnostics: true,
    });
    const errors = (result.diagnostics || []).filter(
      d => d.category === ts.DiagnosticCategory.Error
    );
    if (errors.length > 0) {
      for (const d of errors) {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        console.error('[build.js] TS error: ' + msg);
      }
      throw new Error('[build.js] failed to compile ' + path.relative(ROOT, file));
    }

    const rel = path.relative(srcDir, file).replace(/\.tsx?$/, '.js');
    const outFile = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, result.outputText, 'utf8');
    written.push(rel);
  }
  return written;
}

function collectSourceFiles(srcDir) {
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        // Skip tests and the Bun/Deno cross-platform entry (the node build
        // ships its own server-node entry instead).
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
        if (entry.name === 'worker-test.ts') continue;
        if (entry.name === 'server.ts') continue;
        files.push(full);
      }
    }
  };
  walk(srcDir);
  return files;
}

function copyPublic() {
  const src = path.join(ROOT, 'public');
  const dest = path.join(ROOT, OUT_REL, 'public');
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.mkdirSync(dest, { recursive: true });
  }
}

function writePackageJson() {
  const pkg = {
    name: 'openlist-ts-node',
    version: '1.0.0',
    private: true,
    description: 'OpenList.ts Node.js build (generated by build.js)',
    main: 'server-node.js',
    engines: { node: '>=18' },
  };
  fs.writeFileSync(
    path.join(ROOT, OUT_REL, 'package.json'),
    JSON.stringify(pkg, null, 2) + '\n',
    'utf8'
  );
}

/* ====== NODE_ENTRY_START ======
// Node.js entry for OpenList.ts — generated by build.js at build time.
//
// build.js extracts this block, writes it to src/server-node.ts, compiles the
// project to dist-node/ (CommonJS), then deletes the source file again so the
// core codebase never carries node-specific code.
//
// Entry: dist-node/server-node.js
//   - `node dist-node/server-node.js` starts a plain HTTP server.
//   - `handleFetch(request, env)` is exported for serverless wrappers.
//   - `createServer()` is exported for custom host code.
//
// Runtime requirements (Node >= 18, same as the cross-platform entry):
//   USE_D1=false (default)  +  PG_ADDRS=postgres://user:pass@host:5432/dbname
//   Optional: PUBLIC_DIR (default <outDir>/public), STATIC_BASE, PORT (3000),
//   HOST (0.0.0.0)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { createDatabase } from './db';
import { initializeDatabase } from './models/init';
import { handleRequest } from './router';
import type { AssetProvider, ContextLike, Env } from './types';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.xml': 'text/xml',
  '.webmanifest': 'application/manifest+json',
};

function mimeOf(p: string): string {
  const dot = p.lastIndexOf('.');
  const ext = dot >= 0 ? p.slice(dot).toLowerCase() : '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// Local static-file provider backed by node:fs. The core router
// (src/routes/static.ts) falls back to env.LOCAL_STATIC when no ASSETS
// binding or STATIC_BASE is configured.
function createLocalAssets(rootDir: string): AssetProvider {
  const base = path.resolve(rootDir);
  return {
    async fetch(request: Request): Promise<Response> {
      let rel: string;
      try {
        const url = new URL(request.url);
        rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      } catch {
        return new Response('Bad Request', { status: 400 });
      }
      if (!rel) rel = 'index.html';
      const resolved = path.resolve(base, rel);
      if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        const data = await fs.promises.readFile(resolved);
        return new Response(new Uint8Array(data), {
          headers: { 'Content-Type': mimeOf(resolved) },
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    },
  };
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}

let initialized = false;

// Drop-in for the worker fetch handler: takes a Web-standard Request and
// returns a Web-standard Response. Safe to call from any serverless wrapper.
export async function handleFetch(request: Request, env: Env): Promise<Response> {
  if (!initialized) {
    if (!(env as any).DB) {
      (env as any).DB = createDatabase(env);
    }
    await initializeDatabase(env);
    initialized = true;
  }
  return handleRequest(request, env, {} as ContextLike);
}

export function createEnv(): Env {
  const useD1 = (readEnv('USE_D1') ?? 'false').toLowerCase() === 'true';
  const pgAddrs = readEnv('PG_ADDRS');
  const publicDir = readEnv('PUBLIC_DIR') || path.join(__dirname, 'public');
  return {
    DB: undefined as any,
    ENVIRONMENT: 'production',
    ASSETS: undefined,
    USE_D1: useD1 ? 'true' : 'false',
    PG_ADDRS: pgAddrs,
    HYPERDRIVE: undefined,
    STATIC_BASE: readEnv('STATIC_BASE'),
    LOCAL_STATIC: createLocalAssets(publicDir),
  } as any;
}

function toRequest(req: http.IncomingMessage): Request {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', proto + '://' + host);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, value);
    }
  }
  const init: any = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

function writeResponse(res: http.ServerResponse, response: Response): void {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  if (response.body) {
    const stream = Readable.fromWeb(response.body as any);
    stream.pipe(res);
  } else {
    res.end();
  }
}

export function createServer(): http.Server {
  const env = createEnv();
  return http.createServer((req, res) => {
    let request: Request;
    try {
      request = toRequest(req);
    } catch (err) {
      console.error('[openlist-ts] bad request:', err);
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }
    handleFetch(request, env)
      .then(response => writeResponse(res, response))
      .catch(err => {
        console.error('[openlist-ts] request failed:', err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Internal Server Error');
        } else {
          res.end();
        }
      });
  });
}

export function main(): void {
  const port = Number(readEnv('PORT') || 3000);
  const host = readEnv('HOST') || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    console.log('[openlist-ts] node server listening on http://' + host + ':' + port);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}
====== NODE_ENTRY_END ====== */
