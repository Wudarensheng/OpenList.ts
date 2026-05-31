import { Env, SettingItem } from '../types';

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
    return jsonResponse({ code: 200, message: 'success' });
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
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
