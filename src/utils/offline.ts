/**
 * Offline download support.
 *
 * The Worker itself is stateless/short-lived, so "offline download" is
 * implemented by handing the URL/magnet off to an external download manager
 * (aria2 RPC, qBittorrent Web API or Transmission RPC) that is reachable over
 * HTTP. The created task is tracked in D1 and reported through the regular
 * /api/task/offline_download endpoints.
 *
 * Note: the "download then transfer to storage" pipeline that the Go server
 * runs locally is not available on Workers; the external tool keeps the file.
 */

import { Env } from '../types';
import { jsonResponse } from '../utils/response';
import { getStorageForPath, getRelativePath } from '../routes/fs';

export const TaskState = {
  Pending: 0,
  Running: 1,
  Canceling: 2,
  Canceled: 3,
  Errored: 4,
  Failing: 5,
  Failed: 6,
  Succeeded: 7,
  WaitingRetry: 8,
  BeforeRetry: 9,
} as const;

async function getSetting(env: Env, key: string): Promise<string> {
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    return (row as any)?.value || '';
  } catch {
    return '';
  }
}

async function insertTask(env: Env, body: any, user: any): Promise<number> {
  const extra = JSON.stringify({ tool: body.tool, url: body.url, path: body.path, name: body.name || '' });
  const result = await env.DB.prepare(
    'INSERT INTO tasks (type, name, state, status, progress, extra, creator_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind('offline_download', body.name || 'offline download', 1, 'running', 0, extra, user.id).run();
  return Number(result.meta.last_row_id);
}

async function updateTask(env: Env, id: number, state: number, status: string, error = ''): Promise<void> {
  await env.DB.prepare(
    "UPDATE tasks SET state = ?, status = ?, error = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(state, status, error, id).run();
}

// ---------------------------------------------------------------------------
// tool clients
// ---------------------------------------------------------------------------

async function addAria2(url: string, env: Env): Promise<void> {
  const uri = await getSetting(env, 'aria2_uri');
  const secret = await getSetting(env, 'aria2_secret');
  if (!uri) throw new Error('aria2 is not configured');
  const params: any[] = [];
  if (secret) params.push(`token:${secret}`);
  params.push([url]);
  const res = await fetch(uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'openlist', method: 'aria2.addUri', params }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `aria2 addUri failed (${res.status})`);
  }
}

async function addQbittorrent(url: string, env: Env): Promise<void> {
  const base = (await getSetting(env, 'qbittorrent_url')).trim();
  if (!base) throw new Error('qBittorrent is not configured');

  let apiBase = base.replace(/\/+$/, '');
  let username = '';
  let password = '';
  // Credentials may be embedded in the URL: http://user:pass@host:port
  const m = apiBase.match(/^(https?:\/\/)([^:@/]+):([^@/]+)@(.+)$/);
  if (m) {
    username = decodeURIComponent(m[2]);
    password = decodeURIComponent(m[3]);
    apiBase = m[1] + m[4];
  }

  let cookie = '';
  if (username || password) {
    const loginRes = await fetch(`${apiBase}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      redirect: 'follow',
    });
    const setCookie = loginRes.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    if (!loginRes.ok && loginRes.status !== 200) {
      throw new Error(`qBittorrent login failed (${loginRes.status})`);
    }
  }

  const addRes = await fetch(`${apiBase}/api/v2/torrents/add`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: `urls=${encodeURIComponent(url)}`,
    redirect: 'follow',
  });
  if (!addRes.ok && addRes.status !== 200) {
    throw new Error(`qBittorrent add failed (${addRes.status})`);
  }
}

async function addTransmission(url: string, env: Env): Promise<void> {
  const uri = (await getSetting(env, 'transmission_uri')).trim();
  if (!uri) throw new Error('Transmission is not configured');
  const base = uri.replace(/\/+$/, '');

  // Obtain a session id (required by Transmission RPC).
  const probe = await fetch(`${base}/transmission/rpc`, { method: 'GET' });
  const sessionId = probe.headers.get('X-Transmission-Session-Id') || '';
  const res = await fetch(`${base}/transmission/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { 'X-Transmission-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify({ method: 'torrent-add', arguments: { filename: url } }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.result !== 'success') {
    throw new Error(data.result || `Transmission add failed (${res.status})`);
  }
}

async function addToTool(tool: string, url: string, env: Env): Promise<void> {
  switch (tool) {
    case 'aria2':
      return addAria2(url, env);
    case 'qBittorrent':
    case 'qbittorrent':
      return addQbittorrent(url, env);
    case 'Transmission':
    case 'transmission':
      return addTransmission(url, env);
    default:
      throw new Error(`unsupported offline download tool: ${tool}`);
  }
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

export async function handleOfflineDownloadAdd(request: Request, env: Env, user: any): Promise<Response> {
  try {
    const body = await request.json() as any;
    const tool = body.tool;
    // The frontend sends `urls` (array); API clients may send a single `url`.
    const urls: string[] = Array.isArray(body.urls) && body.urls.length
      ? body.urls.map(String)
      : (body.url ? [String(body.url)] : []);
    const path = body.path || '/';
    const name = body.name || '';

    if (!tool) return jsonResponse({ code: 400, message: 'tool is required' }, 400);
    if (urls.length === 0) return jsonResponse({ code: 400, message: 'urls is required' }, 400);

    // The destination path must belong to a configured storage.
    const storage = await getStorageForPath(path, env);
    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }
    void getRelativePath; // (reserved for future transfer support)

    const taskId = await insertTask(env, { ...body, urls }, user);

    try {
      for (const u of urls) {
        await addToTool(tool, u, env);
      }
      await updateTask(env, taskId, TaskState.Succeeded, 'succeeded');
      return jsonResponse({
        code: 200,
        message: 'success',
        data: { id: taskId, type: 'offline_download', name, state: TaskState.Succeeded, status: 'succeeded', progress: 1, error: '' }
      });
    } catch (e: any) {
      await updateTask(env, taskId, TaskState.Errored, 'errored', e.message || 'failed');
      return jsonResponse({ code: 500, message: e.message || 'Failed to add offline download' }, 500);
    }
  } catch (e: any) {
    console.error('Add offline download error:', e);
    return jsonResponse({ code: 500, message: e.message || 'Internal Server Error' }, 500);
  }
}
