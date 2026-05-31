import { Env } from '../types';

export async function handleStorageRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/admin/storage/list' && request.method === 'GET') {
    return handleListStorages(request, env);
  }

  if (path === '/api/admin/storage/get' && request.method === 'GET') {
    return handleGetStorage(request, env);
  }

  if (path === '/api/admin/storage/create' && request.method === 'POST') {
    return handleCreateStorage(request, env);
  }

  if (path === '/api/admin/storage/update' && request.method === 'POST') {
    return handleUpdateStorage(request, env);
  }

  if (path === '/api/admin/storage/delete' && request.method === 'POST') {
    return handleDeleteStorage(request, env);
  }

  if (path === '/api/admin/storage/enable' && request.method === 'POST') {
    return handleEnableStorage(request, env);
  }

  if (path === '/api/admin/storage/disable' && request.method === 'POST') {
    return handleDisableStorage(request, env);
  }

  if (path === '/api/admin/storage/load_all' && request.method === 'POST') {
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
function transformStorage(row: any): any {
  return {
    id: row.id,
    mount_path: row.mount_path,
    order: row.order_num ?? 0,
    driver: row.driver,
    status: row.status || 'work',
    addition: row.addition || '{}',
    remark: row.remark || '',
    modified: row.modified,
    order_by: row.order_by || 'name',
    order_direction: row.order_direction || '',
    extract_folder: row.extract_folder || 'front',
    web_proxy: !!row.web_proxy,
    webdav_policy: row.webdav_policy || '302_redirect',
    disabled: !!row.disabled,
    disable_index: !!row.disable_index,
    enable_sign: !!row.enable_sign,
    cache_expiration: row.cache_expiration ?? 30,
    down_proxy_url: row.down_proxy_url || '',
    proxy_range: !!row.proxy_range,
    disable_proxy_sign: !!row.disable_proxy_sign,
  };
}

async function handleListStorages(request: Request, env: Env): Promise<Response> {
  try {
    const storages = await env.DB.prepare(
      'SELECT * FROM storages ORDER BY order_num ASC'
    ).all();

    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        content: storages.results.map(transformStorage),
        total: storages.results.length
      }
    });
  } catch (error) {
    console.error('List storages error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleGetStorage(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return jsonResponse({ code: 400, message: 'Storage ID is required' }, 400);
    }

    const storage = await env.DB.prepare(
      'SELECT * FROM storages WHERE id = ?'
    ).bind(id).first();

    if (!storage) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    return jsonResponse({
      code: 200,
      message: 'success',
      data: transformStorage(storage)
    });
  } catch (error) {
    console.error('Get storage error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleCreateStorage(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;

    if (!body.mount_path || !body.driver || !body.addition) {
      return jsonResponse({ code: 400, message: 'mount_path, driver, and addition are required' }, 400);
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM storages WHERE mount_path = ?'
    ).bind(body.mount_path).first();

    if (existing) {
      return jsonResponse({ code: 400, message: 'Mount path already exists' }, 400);
    }

    const addition = typeof body.addition === 'string' ? body.addition : JSON.stringify(body.addition);

    const result = await env.DB.prepare(
      `INSERT INTO storages (mount_path, order_num, driver, cache_expiration, status, addition, remark, modified, disabled, disable_index, enable_sign, order_by, order_direction, extract_folder, web_proxy, webdav_policy, proxy_range, down_proxy_url, disable_proxy_sign) 
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      body.mount_path,
      body.order ?? 0,
      body.driver,
      body.cache_expiration ?? 30,
      'work',
      addition,
      body.remark || '',
      body.disabled ? 1 : 0,
      body.disable_index ? 1 : 0,
      body.enable_sign ? 1 : 0,
      body.order_by || 'name',
      body.order_direction || '',
      body.extract_folder || 'front',
      body.web_proxy ? 1 : 0,
      body.webdav_policy || '302_redirect',
      body.proxy_range ? 1 : 0,
      body.down_proxy_url || '',
      body.disable_proxy_sign ? 1 : 0
    ).run();

    return jsonResponse({
      code: 200,
      message: 'success',
      data: { id: result.meta.last_row_id }
    });
  } catch (error) {
    console.error('Create storage error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleUpdateStorage(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;

    if (!body.id) {
      return jsonResponse({ code: 400, message: 'Storage ID is required' }, 400);
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM storages WHERE id = ?'
    ).bind(body.id).first();

    if (!existing) {
      return jsonResponse({ code: 404, message: 'Storage not found' }, 404);
    }

    if (body.mount_path) {
      const pathTaken = await env.DB.prepare(
        'SELECT id FROM storages WHERE mount_path = ? AND id != ?'
      ).bind(body.mount_path, body.id).first();

      if (pathTaken) {
        return jsonResponse({ code: 400, message: 'Mount path already exists' }, 400);
      }
    }

    const addition = body.addition ? (typeof body.addition === 'string' ? body.addition : JSON.stringify(body.addition)) : null;

    await env.DB.prepare(
      `UPDATE storages SET 
        mount_path = COALESCE(?, mount_path),
        order_num = COALESCE(?, order_num),
        driver = COALESCE(?, driver),
        cache_expiration = COALESCE(?, cache_expiration),
        addition = COALESCE(?, addition),
        remark = COALESCE(?, remark),
        modified = datetime('now'),
        disabled = COALESCE(?, disabled),
        disable_index = COALESCE(?, disable_index),
        enable_sign = COALESCE(?, enable_sign),
        order_by = COALESCE(?, order_by),
        order_direction = COALESCE(?, order_direction),
        extract_folder = COALESCE(?, extract_folder),
        web_proxy = COALESCE(?, web_proxy),
        webdav_policy = COALESCE(?, webdav_policy),
        proxy_range = COALESCE(?, proxy_range),
        down_proxy_url = COALESCE(?, down_proxy_url),
        disable_proxy_sign = COALESCE(?, disable_proxy_sign)
       WHERE id = ?`
    ).bind(
      body.mount_path,
      body.order,
      body.driver,
      body.cache_expiration,
      addition,
      body.remark,
      body.disabled !== undefined ? (body.disabled ? 1 : 0) : null,
      body.disable_index !== undefined ? (body.disable_index ? 1 : 0) : null,
      body.enable_sign !== undefined ? (body.enable_sign ? 1 : 0) : null,
      body.order_by,
      body.order_direction,
      body.extract_folder,
      body.web_proxy !== undefined ? (body.web_proxy ? 1 : 0) : null,
      body.webdav_policy,
      body.proxy_range !== undefined ? (body.proxy_range ? 1 : 0) : null,
      body.down_proxy_url,
      body.disable_proxy_sign !== undefined ? (body.disable_proxy_sign ? 1 : 0) : null,
      body.id
    ).run();

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Update storage error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleDeleteStorage(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    let id = url.searchParams.get('id');

    if (!id) {
      try {
        const body = await request.json() as any;
        id = body.id;
      } catch {}
    }

    if (!id) {
      return jsonResponse({ code: 400, message: 'Storage ID is required' }, 400);
    }

    await env.DB.prepare('DELETE FROM file_cache WHERE storage_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM files WHERE storage_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM storages WHERE id = ?').bind(id).run();

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Delete storage error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleEnableStorage(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return jsonResponse({ code: 400, message: 'Storage ID is required' }, 400);
    }

    await env.DB.prepare(
      'UPDATE storages SET disabled = 0, modified = datetime("now") WHERE id = ?'
    ).bind(id).run();

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Enable storage error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleDisableStorage(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return jsonResponse({ code: 400, message: 'Storage ID is required' }, 400);
    }

    await env.DB.prepare(
      'UPDATE storages SET disabled = 1, modified = datetime("now") WHERE id = ?'
    ).bind(id).run();

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Disable storage error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}
