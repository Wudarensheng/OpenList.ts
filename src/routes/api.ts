import { Env } from '../types';
import { handleAuthRequest } from './auth';
import { handleFsRequest } from './fs';
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

  // No/invalid token -> guest user (view + download only, no permissions)
  const guestResponse = () => jsonResponse({ code: 200, message: 'success', data: getGuestUser() });

  if (!token) {
    return guestResponse();
  }

  try {
    const payload = JSON.parse(atob(token));
    if (payload.exp < Date.now()) {
      return guestResponse();
    }

    const user = await env.DB.prepare(
      'SELECT id, username, role, disabled FROM users WHERE id = ? AND disabled = 0'
    ).bind(payload.userId).first();

    if (!user) {
      return guestResponse();
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
        otp: false,
        password: '',
        base_path: '/',
        home_dir: '/'
      }
    });
  } catch (error) {
    return guestResponse();
  }
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
