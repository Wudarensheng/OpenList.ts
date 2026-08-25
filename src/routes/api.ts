import { Env } from '../types';
import { handleAuthRequest } from './auth';
import { handleFsRequest } from './fs';
import { handleShareRequest } from './share';
import { handleStorageRequest } from './storage';
import { handleSettingRequest } from './settings';
import { handleUserRequest } from './users';
import { handleDriverRequest } from './drivers';
import { handleTaskRequest } from './tasks';
import { handleRefreshRequest } from './refresh';
import { jsonResponse } from '../utils/response';
import { getGuestUser } from '../utils/guest';

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Authentication routes
  if (path.startsWith('/api/auth/')) {
    return handleAuthRequest(request, env);
  }

  // Public routes (no auth required)
  if (path === '/api/public/settings') {
    return handlePublicSettings(env);
  }

  if (path === '/api/public/archive_extensions') {
    return handleArchiveExtensions();
  }

  if (path === '/api/public/offline_download_tools') {
    return handleOfflineDownloadTools();
  }

  // Me endpoint (with auth)
  if (path === '/api/me') {
    return handleGetCurrentUser(request, env);
  }

  // Update current user profile (username / password)
  if (path === '/api/me/update' && request.method === 'POST') {
    return handleUpdateCurrentUser(request, env);
  }

  // Share management
  if (path.startsWith('/api/share/')) {
    return handleShareRequest(request, env);
  }

  // Me sshkey endpoints
  if (path === '/api/me/sshkey/list') {
    return jsonResponse({ code: 200, message: 'success', data: { content: [], total: 0 } });
  }

  if (path === '/api/me/sshkey/add') {
    return jsonResponse({ code: 200, message: 'success' });
  }

  if (path === '/api/me/sshkey/delete') {
    return jsonResponse({ code: 200, message: 'success' });
  }

  // File system routes (with auth)
  if (path.startsWith('/api/fs/')) {
    return handleFsRequest(request, env);
  }

  // Task routes (with auth)
  if (path.startsWith('/api/task/')) {
    return handleTaskRequest(request, env);
  }

  // Admin routes (require admin auth)
  if (path.startsWith('/api/admin/')) {
    // Verify admin token
    const token = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    }
    
    try {
      const payload = JSON.parse(atob(token));
      if (payload.exp < Date.now()) {
        return jsonResponse({ code: 401, message: 'Token expired' }, 401);
      }
      
      const user = await env.DB.prepare(
        'SELECT id, username, role, disabled FROM users WHERE id = ? AND disabled = 0'
      ).bind(payload.userId).first();
      
      if (!user || (user as any).role < 2) {
        return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
      }
    } catch (e) {
      return jsonResponse({ code: 401, message: 'Invalid token' }, 401);
    }

    // Refresh routes (file cache sync) - must be before storage routes
    if (path.startsWith('/api/admin/storage/refresh')) {
      return handleRefreshRequest(request, env);
    }

    // Storage management routes
    if (path.startsWith('/api/admin/storage/')) {
      return handleStorageRequest(request, env);
    }

    // Settings routes
    if (path.startsWith('/api/admin/setting/')) {
      return handleSettingRequest(request, env);
    }

    // User management routes
    if (path.startsWith('/api/admin/user/')) {
      return handleUserRequest(request, env);
    }

    // Driver routes
    if (path.startsWith('/api/admin/driver/')) {
      return handleDriverRequest(request, env);
    }

    // Index routes
    if (path.startsWith('/api/admin/index/')) {
      return handleIndexRequest(request, env);
    }

    // Scan routes
    if (path.startsWith('/api/admin/scan/')) {
      return handleScanRequest(request, env);
    }

    // Meta routes
    if (path.startsWith('/api/admin/meta/')) {
      return handleMetaRequest(request, env);
    }
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}



async function handlePublicSettings(env: Env): Promise<Response> {
  try {
    const settings = await env.DB.prepare(
      'SELECT key, value FROM settings WHERE flag = 0'
    ).all();

    const settingsMap: Record<string, string> = {};
    for (const setting of settings.results) {
      settingsMap[(setting as any).key] = (setting as any).value;
    }

    return jsonResponse({
      code: 200,
      message: 'success',
      data: settingsMap
    });
  } catch (error) {
    console.error('Public settings error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

// AList returns a flat array of extension suffixes (with leading dots).
// The frontend calls data.some(t => filename.toLowerCase().endsWith(t)) on it,
// so `data` MUST be an array or the UI throws "sO.some is not a function".
function handleArchiveExtensions(): Response {
  return jsonResponse({
    code: 200,
    message: 'success',
    data: [
      '.7z', '.rar', '.iso',
      '.br', '.bz2', '.gz', '.lz4', '.lz', '.sz', '.s2', '.xz', '.zz', '.zst', '.tar',
      '.zip', '.zip.001', '.7z.001', '.part1.rar',
    ]
  });
}

function handleOfflineDownloadTools(): Response {
  return jsonResponse({
    code: 200,
    message: 'success',
    data: []
  });
}

async function handleGetCurrentUser(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');

  // No/invalid token -> guest user (view + download only, no permissions).
  // When the guest user is disabled, anonymous access is forbidden.
  const guestResponse = async () => {
    const guest = await getGuestUserFromDB(env);
    return jsonResponse({ code: 200, message: 'success', data: guest });
  };
  const deniedResponse = () => jsonResponse({ code: 401, message: 'Unauthorized' }, 401);

  const anonymousEnabled = await isAnonymousEnabled(env);
  if (!token) {
    return anonymousEnabled ? guestResponse() : deniedResponse();
  }

  try {
    const payload = JSON.parse(atob(token));
    if (payload.exp < Date.now()) {
      return anonymousEnabled ? guestResponse() : deniedResponse();
    }

    const user = await env.DB.prepare(
      'SELECT id, username, role, disabled, otp_secret FROM users WHERE id = ? AND disabled = 0'
    ).bind(payload.userId).first();

    if (!user) {
      return anonymousEnabled ? guestResponse() : deniedResponse();
    }

    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        id: (user as any).id,
        username: (user as any).username,
        role: (user as any).role,
        disabled: (user as any).disabled === 1,
        permission: (user as any).role === 2 ? 0xFFFFFFFF : (user as any).role === 1 ? 0x00000007 : 0x00000001,
        sso_id: '',
        otp: !!((user as any).otp_secret),
        password: '',
        base_path: '/',
        home_dir: '/'
      }
    });
  } catch (error) {
    return anonymousEnabled ? guestResponse() : deniedResponse();
  }
}

// Load the guest user row from the DB (fall back to the hardcoded model if
// the row is missing).
async function getGuestUserFromDB(env: Env): Promise<Record<string, any>> {
  try {
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE username = ?'
    ).bind('guest').first();
    if (user) {
      return {
        id: (user as any).id,
        username: (user as any).username,
        role: (user as any).role,
        disabled: (user as any).disabled === 1,
        permission: (user as any).permission ?? 0,
        sso_id: (user as any).sso_id || '',
        otp: !!((user as any).otp_secret),
        password: '',
        base_path: (user as any).base_path || '/',
        home_dir: (user as any).home_dir || '/',
        allow_ldap: false,
      };
    }
  } catch {
    // fall through to hardcoded model
  }
  return getGuestUser();
}

// Anonymous browsing is enabled when the "guest" user exists in the users
// table and is not disabled. This lets admins toggle guest access directly in
// the user list.
export async function isAnonymousEnabled(env: Env): Promise<boolean> {
  try {
    const user = await env.DB.prepare(
      'SELECT id, disabled FROM users WHERE username = ?'
    ).bind('guest').first();
    if (!user) return false;
    return (user as any).disabled !== 1;
  } catch {
    return false;
  }
}

// POST /api/me/update - update the current user's username / password
async function handleUpdateCurrentUser(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
  }

  try {
    const payload = JSON.parse(atob(token));
    if (payload.exp < Date.now()) {
      return jsonResponse({ code: 401, message: 'Token expired' }, 401);
    }

    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE id = ? AND disabled = 0'
    ).bind(payload.userId).first();

    if (!user) {
      return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
    }

    const body = await request.json() as { username?: string; password?: string; old_password?: string; otp_code?: string };

    // Verify old password if changing password or username
    if (body.password) {
      const oldPwd = body.old_password || '';
      const storedPassword = (user as any).password;
      const alistSalt = 'https://github.com/alist-org/alist';
      const oldOk =
        oldPwd === storedPassword ||
        oldPwd === await sha256(`${storedPassword}-${alistSalt}`) ||
        oldPwd === await sha256(storedPassword);
      if (!oldOk) {
        return jsonResponse({ code: 400, message: 'Old password is incorrect' }, 400);
      }
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (body.username && body.username !== (user as any).username) {
      // Check username uniqueness
      const taken = await env.DB.prepare(
        'SELECT id FROM users WHERE username = ? AND id != ?'
      ).bind(body.username, (user as any).id).first();
      if (taken) {
        return jsonResponse({ code: 400, message: 'Username already exists' }, 400);
      }
      updates.push('username = ?');
      values.push(body.username);
    }

    if (body.password) {
      updates.push('password = ?');
      values.push(body.password);
    }

    if (updates.length === 0) {
      return jsonResponse({ code: 200, message: 'success' });
    }

    updates.push('updated_at = datetime(\'now\')');
    values.push((user as any).id);

    await env.DB.prepare(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Update user error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function handleIndexRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.includes('/progress')) {
    return Promise.resolve(jsonResponse({
      code: 200,
      message: 'success',
      data: { progress: 0, status: '' }
    }));
  }

  if (path.includes('/build') || path.includes('/update') || path.includes('/stop') || path.includes('/clear')) {
    return Promise.resolve(jsonResponse({ code: 200, message: 'success' }));
  }

  return Promise.resolve(jsonResponse({ code: 404, message: 'Not Found' }, 404));
}

function handleScanRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.includes('/progress')) {
    return Promise.resolve(jsonResponse({
      code: 200,
      message: 'success',
      data: { progress: 0, status: '' }
    }));
  }

  if (path.includes('/start') || path.includes('/stop')) {
    return Promise.resolve(jsonResponse({ code: 200, message: 'success' }));
  }

  return Promise.resolve(jsonResponse({ code: 404, message: 'Not Found' }, 404));
}

function handleMetaRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.includes('/list')) {
    return Promise.resolve(jsonResponse({
      code: 200,
      message: 'success',
      data: { content: [], total: 0 }
    }));
  }

  if (path.includes('/get') || path.includes('/create') || path.includes('/update') || path.includes('/delete')) {
    return Promise.resolve(jsonResponse({ code: 200, message: 'success', data: {} }));
  }

  return Promise.resolve(jsonResponse({ code: 404, message: 'Not Found' }, 404));
}
