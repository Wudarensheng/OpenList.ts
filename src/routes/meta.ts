/**
 * Meta admin routes (port of OpenList's server/handles/meta.go).
 * /api/admin/meta/list|get|create|update|delete
 */

import { Env } from '../types';
import { jsonResponse } from '../utils/response';
import { Meta, getMetaById, validHide } from '../utils/meta';

export async function handleMetaRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/admin/meta/list' && request.method === 'GET') {
    return handleListMetas(request, env);
  }
  if (path === '/api/admin/meta/get' && request.method === 'GET') {
    return handleGetMeta(request, env);
  }
  if (path === '/api/admin/meta/create' && request.method === 'POST') {
    return handleCreateMeta(request, env);
  }
  if (path === '/api/admin/meta/update' && request.method === 'POST') {
    return handleUpdateMeta(request, env);
  }
  if (path === '/api/admin/meta/delete' && request.method === 'POST') {
    return handleDeleteMeta(request, env);
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}

function rowToApi(row: any): any {
  const parseIds = (s: string | null): number[] => {
    try {
      const v = JSON.parse(s || '[]');
      return Array.isArray(v) ? v.map(Number) : [];
    } catch {
      return [];
    }
  };
  return {
    id: row.id,
    path: row.path,
    read_users: parseIds(row.read_users),
    read_users_sub: !!row.read_users_sub,
    write_users: parseIds(row.write_users),
    write_users_sub: !!row.write_users_sub,
    password: row.password || '',
    p_sub: !!row.p_sub,
    write: !!row.write,
    w_sub: !!row.w_sub,
    hide: row.hide || '',
    h_sub: !!row.h_sub,
    readme: row.readme || '',
    r_sub: !!row.r_sub,
    header: row.header || '',
    header_sub: !!row.header_sub,
  };
}

async function handleListMetas(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const perPage = Math.max(0, parseInt(url.searchParams.get('per_page') || '0'));

    const rows = await env.DB.prepare('SELECT * FROM metas ORDER BY id ASC').all();
    const all = (rows.results || []).map(rowToApi);
    const total = all.length;

    let content = all;
    if (perPage > 0) {
      const offset = (page - 1) * perPage;
      content = all.slice(offset, offset + perPage);
    }

    return jsonResponse({ code: 200, message: 'success', data: { content, total } });
  } catch (error) {
    console.error('List metas error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleGetMeta(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = parseInt(url.searchParams.get('id') || '');
    if (!id) {
      return jsonResponse({ code: 400, message: 'Meta ID is required' }, 400);
    }
    const meta = await getMetaById(id, env);
    if (!meta) {
      return jsonResponse({ code: 404, message: 'Meta not found' }, 404);
    }
    const row = await env.DB.prepare('SELECT * FROM metas WHERE id = ?').bind(id).first();
    return jsonResponse({ code: 200, message: 'success', data: rowToApi(row) });
  } catch (error) {
    console.error('Get meta error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

function bodyToMeta(body: any): any {
  const num = (v: any, d: number) => (v === undefined || v === null ? d : Number(v));
  const bool = (v: any, d = false) => (v === undefined || v === null ? d : !!v);
  const ids = (v: any): number[] => (Array.isArray(v) ? v.map(Number) : []);
  return {
    path: (body.path || '').toString(),
    read_users: JSON.stringify(ids(body.read_users)),
    read_users_sub: bool(body.read_users_sub) ? 1 : 0,
    write_users: JSON.stringify(ids(body.write_users)),
    write_users_sub: bool(body.write_users_sub) ? 1 : 0,
    password: (body.password || '').toString(),
    p_sub: bool(body.p_sub) ? 1 : 0,
    write: bool(body.write) ? 1 : 0,
    w_sub: bool(body.w_sub) ? 1 : 0,
    hide: (body.hide || '').toString(),
    h_sub: bool(body.h_sub) ? 1 : 0,
    readme: (body.readme || '').toString(),
    r_sub: bool(body.r_sub) ? 1 : 0,
    header: (body.header || '').toString(),
    header_sub: bool(body.header_sub) ? 1 : 0,
  };
}

async function handleCreateMeta(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    if (!body.path) {
      return jsonResponse({ code: 400, message: 'path is required' }, 400);
    }
    if (!body.path.startsWith('/')) {
      return jsonResponse({ code: 400, message: 'path must start with /' }, 400);
    }
    const badHide = validHide((body.hide || '').toString());
    if (badHide) {
      return jsonResponse({ code: 400, message: `${badHide} is illegal` }, 400);
    }
    const m = bodyToMeta(body);
    const existing = await env.DB.prepare('SELECT id FROM metas WHERE path = ?').bind(m.path).first();
    if (existing) {
      return jsonResponse({ code: 409, message: 'Meta already exists for this path' }, 409);
    }
    const result = await env.DB.prepare(
      `INSERT INTO metas (path, read_users, read_users_sub, write_users, write_users_sub, password, p_sub, write, w_sub, hide, h_sub, readme, r_sub, header, header_sub)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      m.path, m.read_users, m.read_users_sub, m.write_users, m.write_users_sub,
      m.password, m.p_sub, m.write, m.w_sub, m.hide, m.h_sub,
      m.readme, m.r_sub, m.header, m.header_sub
    ).run();
    return jsonResponse({ code: 200, message: 'success', data: { id: result.meta.last_row_id } });
  } catch (error) {
    console.error('Create meta error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleUpdateMeta(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const id = Number(body.id);
    if (!id) {
      return jsonResponse({ code: 400, message: 'Meta ID is required' }, 400);
    }
    const existing = await env.DB.prepare('SELECT id FROM metas WHERE id = ?').bind(id).first();
    if (!existing) {
      return jsonResponse({ code: 404, message: 'Meta not found' }, 404);
    }
    const badHide = validHide((body.hide || '').toString());
    if (badHide) {
      return jsonResponse({ code: 400, message: `${badHide} is illegal` }, 400);
    }
    const m = bodyToMeta(body);
    if (m.path) {
      const clash = await env.DB.prepare('SELECT id FROM metas WHERE path = ? AND id != ?').bind(m.path, id).first();
      if (clash) {
        return jsonResponse({ code: 409, message: 'Meta already exists for this path' }, 409);
      }
    }
    await env.DB.prepare(
      `UPDATE metas SET path=?, read_users=?, read_users_sub=?, write_users=?, write_users_sub=?, password=?, p_sub=?, write=?, w_sub=?, hide=?, h_sub=?, readme=?, r_sub=?, header=?, header_sub=? WHERE id=?`
    ).bind(
      m.path, m.read_users, m.read_users_sub, m.write_users, m.write_users_sub,
      m.password, m.p_sub, m.write, m.w_sub, m.hide, m.h_sub,
      m.readme, m.r_sub, m.header, m.header_sub, id
    ).run();
    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Update meta error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleDeleteMeta(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    let id = url.searchParams.get('id');
    if (!id) {
      try {
        const body = await request.json() as any;
        id = (body as any).id;
      } catch {}
    }
    if (!id) {
      return jsonResponse({ code: 400, message: 'Meta ID is required' }, 400);
    }
    await env.DB.prepare('DELETE FROM metas WHERE id = ?').bind(id).run();
    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Delete meta error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}
