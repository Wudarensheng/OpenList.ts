import { Env, User } from '../types';
import { jsonResponse } from '../utils/response';

export async function handleUserRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/admin/user/list' && request.method === 'GET') {
    return handleListUsers(request, env);
  }

  if (path === '/api/admin/user/get' && request.method === 'GET') {
    return handleGetUser(request, env);
  }

  if (path === '/api/admin/user/create' && request.method === 'POST') {
    return handleCreateUser(request, env);
  }

  if (path === '/api/admin/user/update' && request.method === 'POST') {
    return handleUpdateUser(request, env);
  }

  if (path === '/api/admin/user/delete' && request.method === 'POST') {
    return handleDeleteUser(request, env);
  }

  if (path === '/api/admin/user/sshkey/list' && request.method === 'GET') {
    return jsonResponse({ code: 200, message: 'success', data: { content: [], total: 0 } });
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}



// Transform DB row to frontend format
function transformUser(row: any): any {
  return {
    id: row.id,
    username: row.username,
    role: row.role ?? 0,
    disabled: !!row.disabled,
    base_path: row.base_path || '/',
    permission: row.permission ?? 0,
    sso_id: row.sso_id || '',
    allow_ldap: !!row.allow_ldap,
    otp: !!row.otp_secret,
    created_at: row.created_at,
  };
}

async function handleListUsers(request: Request, env: Env): Promise<Response> {
  try {
    const users = await env.DB.prepare(
      'SELECT * FROM users ORDER BY id ASC'
    ).all();

    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        content: users.results.map(transformUser),
        total: users.results.length
      }
    });
  } catch (error) {
    console.error('List users error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleGetUser(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return jsonResponse({ code: 400, message: 'User ID is required' }, 400);
    }

    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE id = ?'
    ).bind(id).first();

    if (!user) {
      return jsonResponse({ code: 404, message: 'User not found' }, 404);
    }

    return jsonResponse({
      code: 200,
      message: 'success',
      data: transformUser(user)
    });
  } catch (error) {
    console.error('Get user error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleCreateUser(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;

    if (!body.username || !body.password) {
      return jsonResponse({ code: 400, message: 'Username and password are required' }, 400);
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM users WHERE username = ?'
    ).bind(body.username).first();

    if (existing) {
      return jsonResponse({ code: 400, message: 'Username already exists' }, 400);
    }

    const result = await env.DB.prepare(
      'INSERT INTO users (username, password, role, disabled, base_path, permission) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(
      body.username,
      body.password,
      body.role ?? 0,
      body.disabled ? 1 : 0,
      body.base_path || '/',
      body.permission ?? 0
    ).run();

    return jsonResponse({
      code: 200,
      message: 'success',
      data: { id: result.meta.last_row_id }
    });
  } catch (error) {
    console.error('Create user error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleUpdateUser(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;

    if (!body.id) {
      return jsonResponse({ code: 400, message: 'User ID is required' }, 400);
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM users WHERE id = ?'
    ).bind(body.id).first();

    if (!existing) {
      return jsonResponse({ code: 404, message: 'User not found' }, 404);
    }

    if (body.username) {
      const usernameTaken = await env.DB.prepare(
        'SELECT id FROM users WHERE username = ? AND id != ?'
      ).bind(body.username, body.id).first();

      if (usernameTaken) {
        return jsonResponse({ code: 400, message: 'Username already exists' }, 400);
      }
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (body.username) {
      updates.push('username = ?');
      values.push(body.username);
    }
    if (body.password) {
      updates.push('password = ?');
      values.push(body.password);
    }
    if (body.role !== undefined) {
      updates.push('role = ?');
      values.push(body.role);
    }
    if (body.disabled !== undefined) {
      updates.push('disabled = ?');
      values.push(body.disabled ? 1 : 0);
    }
    if (body.base_path !== undefined) {
      updates.push('base_path = ?');
      values.push(body.base_path);
    }
    if (body.permission !== undefined) {
      updates.push('permission = ?');
      values.push(body.permission);
    }

    if (updates.length === 0) {
      return jsonResponse({ code: 400, message: 'No fields to update' }, 400);
    }

    values.push(body.id);

    await env.DB.prepare(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Update user error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleDeleteUser(request: Request, env: Env): Promise<Response> {
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
      return jsonResponse({ code: 400, message: 'User ID is required' }, 400);
    }

    if (parseInt(id) === 1) {
      return jsonResponse({ code: 400, message: 'Cannot delete the main administrator' }, 400);
    }

    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error) {
    console.error('Delete user error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}
