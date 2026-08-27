import { Env, SettingItem } from '../types';
import { jsonResponse } from '../utils/response';

export async function handleSettingRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/admin/setting/list' && request.method === 'GET') {
    return handleListSettings(request, env);
  }

  if (path === '/api/admin/setting/get' && request.method === 'GET') {
    return handleGetSetting(request, env);
  }

  if (path === '/api/admin/setting/save' && request.method === 'POST') {
    return handleSaveSettings(request, env);
  }

  if (path === '/api/admin/setting/delete' && request.method === 'POST') {
    return handleDeleteSetting(request, env);
  }

  if (path === '/api/admin/setting/default' && request.method === 'POST') {
    return handleDefaultSettings(request, env);
  }

  if (path === '/api/admin/setting/reset_token' && request.method === 'POST') {
    return handleResetToken(request, env);
  }

  if (path === '/api/admin/setting/set_aria2' && request.method === 'POST') {
    return handleSetAria2(request, env);
  }

  if (path === '/api/admin/setting/set_qbit' && request.method === 'POST') {
    return handleSetQbittorrent(request, env);
  }

  if (path === '/api/admin/setting/set_transmission' && request.method === 'POST') {
    return handleSetTransmission(request, env);
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}



// Transform DB row to frontend format
function transformSetting(row: any): any {
  return {
    key: row.key,
    value: row.value || '',
    help: row.help || '',
    type: row.type || 'string',
    options: row.options || '',
    group: row.group_id ?? 0,
    flag: row.flag ?? 0,
  };
}

async function handleListSettings(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const group = url.searchParams.get('group');

    let query = 'SELECT * FROM settings';
    let params: any[] = [];

    if (group !== null && group !== '') {
      query += ' WHERE group_id = ?';
      params.push(parseInt(group));
    }

    query += ' ORDER BY group_id ASC, index_num ASC';

    const stmt = params.length > 0
      ? env.DB.prepare(query).bind(...params)
      : env.DB.prepare(query);

    const settings = await stmt.all();

    return jsonResponse({
      code: 200,
      message: 'success',
      data: settings.results.map(transformSetting)
    });
  } catch (error) {
    console.error('List settings error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleGetSetting(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');

    if (!key) {
      return jsonResponse({ code: 400, message: 'Setting key is required' }, 400);
    }

    const setting = await env.DB.prepare(
      'SELECT * FROM settings WHERE key = ?'
    ).bind(key).first();

    if (!setting) {
      return jsonResponse({ code: 404, message: 'Setting not found' }, 404);
    }

    return jsonResponse({
      code: 200,
      message: 'success',
      data: transformSetting(setting)
    });
  } catch (error) {
    console.error('Get setting error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleSaveSettings(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;

    // The frontend sends the settings array directly or as { items: [...] }
    const items = Array.isArray(body) ? body : (body.items || [body]);

    for (const item of items) {
      if (!item.key) continue;

      await env.DB.prepare(
        `INSERT OR REPLACE INTO settings (key, value, help, type, options, group_id, flag, index_num) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        item.key,
        item.value || '',
        item.help || '',
        item.type || 'string',
        item.options || '',
        item.group ?? 0,
        item.flag ?? 0,
        item.index ?? 0
      ).run();
    }

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Save settings error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleDeleteSetting(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    let key = url.searchParams.get('key');

    if (!key) {
      try {
        const body = await request.json() as any;
        key = body.key;
      } catch {}
    }

    if (!key) {
      return jsonResponse({ code: 400, message: 'Setting key is required' }, 400);
    }

    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Delete setting error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleDefaultSettings(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const group = url.searchParams.get('group');

    const defaults: Record<string, any[]> = {
      '1': [ // SITE
        { key: 'site_title', value: 'OpenList', help: 'Site title', type: 'string', group: 1 },
        { key: 'site_description', value: 'A file list program', help: 'Site description', type: 'string', group: 1 },
      ],
    };

    const defaultItems = defaults[group || ''] || [];

    return jsonResponse({
      code: 200,
      message: 'success',
      data: defaultItems
    });
  } catch (error) {
    console.error('Default settings error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

// POST /api/admin/setting/reset_token - rotate the private token/sign secret.
// This invalidates all previously issued session tokens.
async function handleResetToken(request: Request, env: Env): Promise<Response> {
  try {
    const token = randomToken(32);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO settings (key, value, help, type, options, group_id, flag, index_num) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind('token', token, 'Sign/Token secret (do not expose)', 'string', '', 4, 1, 0).run();
    const { invalidateSecretCache } = await import('../utils/auth');
    invalidateSecretCache();
    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Reset token error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

// POST /api/admin/setting/set_aria2 - configure aria2 RPC
async function handleSetAria2(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const uri = body.uri || '';
    const secret = body.secret || '';
    await saveSetting(env, 'aria2_uri', uri);
    await saveSetting(env, 'aria2_secret', secret);

    if (!uri) return jsonResponse({ code: 200, message: 'success' });
    try {
      const version = await testAria2(uri, secret);
      return jsonResponse({ code: 200, message: 'success', data: version });
    } catch (e: any) {
      return jsonResponse({ code: 500, message: e.message || 'Failed to connect to aria2' }, 500);
    }
  } catch (error) {
    console.error('Set aria2 error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

// POST /api/admin/setting/set_qbit - configure qBittorrent
async function handleSetQbittorrent(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const url = body.url || '';
    const seedtime = body.seedtime || '0';
    await saveSetting(env, 'qbittorrent_url', url);
    await saveSetting(env, 'qbittorrent_seedtime', seedtime);
    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Set qBittorrent error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

// POST /api/admin/setting/set_transmission - configure Transmission
async function handleSetTransmission(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const uri = body.uri || '';
    const seedtime = body.seedtime || '0';
    await saveSetting(env, 'transmission_uri', uri);
    await saveSetting(env, 'transmission_seedtime', seedtime);
    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Set Transmission error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function saveSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO settings (key, value, help, type, options, group_id, flag, index_num)
     VALUES (?, ?, '', 'string', '', 5, 1, 0)`
  ).bind(key, value).run();
}

async function testAria2(uri: string, secret: string): Promise<string> {
  const params: any[] = [];
  if (secret) params.push(`token:${secret}`);
  params.push([]);
  const res = await fetch(uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'openlist', method: 'aria2.getVersion', params }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (data.error) throw new Error(data.error.message || 'aria2 connection failed');
  return data.result?.version || 'ok';
}

function randomToken(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const arr = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of arr) s += chars[b % chars.length];
  return s;
}
