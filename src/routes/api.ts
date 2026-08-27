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
import { handleMetaRequest } from './meta';
import { jsonResponse } from '../utils/response';
import { getAuthUser, verifyToken, verifyPassword, getPermission, hashPasswordForStorage } from '../utils/auth';

// Re-exported for modules that historically imported from ./api
export { isAnonymousEnabled, getGuestUserFromDB } from './auth';

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
    return handleOfflineDownloadTools(env);
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
    const admin = await requireAdmin(request, env);
    if (admin !== true) return admin;

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

    // Message routes (push notifications for the admin panel)
    if (path === '/api/admin/message/get') {
      return handleMessageGet();
    }
    if (path === '/api/admin/message/send') {
      return jsonResponse({ code: 200, message: 'success' });
    }
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}

// Verify the admin token; returns true when authorized, otherwise a Response.
async function requireAdmin(request: Request, env: Env): Promise<true | Response> {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
  }

  const payload = await verifyToken(token, env);
  if (!payload) {
    return jsonResponse({ code: 401, message: 'Invalid or expired token' }, 401);
  }

  try {
    const user = await env.DB.prepare(
      'SELECT id, username, role, disabled FROM users WHERE id = ? AND disabled = 0'
    ).bind(payload.userId).first();
    if (!user || (user as any).role < 2) {
      return jsonResponse({ code: 403, message: 'Permission denied' }, 403);
    }
  } catch {
    return jsonResponse({ code: 401, message: 'Invalid token' }, 401);
  }
  return true;
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

// Returns the offline download tools that are currently configured.
async function handleOfflineDownloadTools(env: Env): Promise<Response> {
  try {
    const rows = await env.DB.prepare(
      'SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?, ?, ?)'
    ).bind('aria2_uri', 'aria2_secret', 'qbittorrent_url', 'qbittorrent_seedtime', 'transmission_uri', 'transmission_seedtime').all();
    const map: Record<string, string> = {};
    for (const row of rows.results) map[(row as any).key] = (row as any).value;

    const tools: string[] = [];
    if (map.aria2_uri) tools.push('aria2');
    if (map.qbittorrent_url) tools.push('qBittorrent');
    if (map.transmission_uri) tools.push('Transmission');
    return jsonResponse({ code: 200, message: 'success', data: tools });
  } catch (e) {
    console.error('offline_download_tools error:', e);
    return jsonResponse({ code: 200, message: 'success', data: [] });
  }
}

async function handleGetCurrentUser(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');

  const guestResponse = async () => {
    const { getGuestUserFromDB } = await import('./auth');
    const guest = await getGuestUserFromDB(env);
    return jsonResponse({ code: 200, message: 'success', data: guest });
  };
  const deniedResponse = () => jsonResponse({ code: 401, message: 'Unauthorized' }, 401);

  const { isAnonymousEnabled } = await import('./auth');
  const anonymousEnabled = await isAnonymousEnabled(env);
  if (!token) {
    return anonymousEnabled ? guestResponse() : deniedResponse();
  }

  const user = await getAuthUser(request, env);
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
      permission: getPermission(user),
      sso_id: (user as any).sso_id || '',
      otp: !!((user as any).otp_secret),
      password: '',
      base_path: (user as any).base_path || '/',
      home_dir: (user as any).base_path || '/',
      allow_ldap: !!((user as any).allow_ldap) || false,
      two_factor_login: !!((user as any).otp_secret) || false
    }
  });
}

// POST /api/me/update - update the current user's username / password
async function handleUpdateCurrentUser(request: Request, env: Env): Promise<Response> {
  const user = await getAuthUser(request, env);
  if (!user) {
    return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
  }

  try {
    const body = await request.json() as { username?: string; password?: string; old_password?: string; otp_code?: string };

    // The OpenList/AList frontend profile form does not send `old_password`
    // (it only sends username/password). The signed token is the authority,
    // so old-password verification is only applied when the field is present
    // (API clients that choose to send it get an extra check).
    if (body.password && body.old_password) {
      const ok = await verifyPassword((user as any).password, { raw: body.old_password });
      if (!ok) {
        return jsonResponse({ code: 400, message: 'Old password is incorrect' }, 400);
      }
    }

    const updates: string[] = [];
    const values: any[] = [];

    if (body.username && body.username !== (user as any).username) {
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
      const hashed = await hashPasswordForStorage(body.password);
      const salt = hashed.split(':')[0];
      const hash = hashed.split(':')[1];
      // Note: pwd_ts is intentionally NOT bumped here. The user is changing
      // their own password with their own valid token; bumping pwd_ts would
      // immediately invalidate the session they are using, causing the
      // frontend's next API call to 401 and force a confusing re-login
      // (OpenList's profile page already redirects to /login after a change).
      updates.push('password = ?', 'salt = ?');
      values.push(`${salt}:${hash}`, salt);
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

function handleMessageGet(): Response {
  // The Worker is stateless, so there is no persistent push channel; the
  // frontend treats a 404 ("no message") as the quiet state (same as Go when
  // the in-memory channel is empty).
  return jsonResponse({ code: 404, message: 'no message' }, 404);
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
