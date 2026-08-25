import { Env } from '../types';
import { jsonResponse } from '../utils/response';
import { getGuestUser } from '../utils/guest';
import { generateOtpSecret, verifyTotp, buildOtpAuthUri, qrSvgDataUri } from '../utils/otp';

export async function handleAuthRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/auth/login' && request.method === 'POST') {
    return handleLogin(request, env);
  }

  if (path === '/api/auth/login/hash' && request.method === 'POST') {
    return handleLoginHash(request, env);
  }

  // 2FA endpoints
  if (path === '/api/auth/2fa/generate' && request.method === 'POST') {
    return handleGenerate2FA(request, env);
  }

  if (path === '/api/auth/2fa/verify' && request.method === 'POST') {
    return handleVerify2FA(request, env);
  }

  if (path === '/api/auth/2fa/disable' && request.method === 'POST') {
    return handleDisable2FA(request, env);
  }

  // SHA-256 test endpoint
  if (path === '/api/auth/sha256test' && request.method === 'GET') {
    const testInput = url.searchParams.get('input') || 'admin';
    const hash = await sha256(testInput);
    return jsonResponse({ 
      code: 200, 
      data: { 
        input: testInput, 
        hash, 
        hashLen: hash.length,
        expected: '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918',
        match: hash === '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918'
      } 
    });
  }

  if (path === '/api/auth/logout' && request.method === 'GET') {
    return handleLogout();
  }

  if (path === '/api/auth/me' && request.method === 'GET') {
    return handleGetCurrentUser(request, env);
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}



async function handleLogin(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { username: string; password: string; otp_code?: string };
    const { username, password } = body;

    if (!username || !password) {
      return jsonResponse({ code: 400, message: 'Username and password are required' }, 400);
    }

    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE username = ? AND disabled = 0'
    ).bind(username).first();

    if (!user || (user as any).password !== password) {
      return jsonResponse({ code: 401, message: 'Invalid username or password' }, 401);
    }

    // 2FA check
    const otpSecret = (user as any).otp_secret;
    if (otpSecret) {
      const ok = await verifyTotp(otpSecret, body.otp_code || '');
      if (!ok) {
        return jsonResponse({ code: 401, message: 'Invalid two-factor code' }, 401);
      }
    }

    const token = generateToken((user as any).id);
    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        token,
        user: { id: (user as any).id, username: (user as any).username, role: (user as any).role }
      }
    });
  } catch (error: any) {
    console.error('Login error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// AList frontend hashes passwords as sha256(password + "-" + salt)
const ALIST_HASH_SALT = 'https://github.com/alist-org/alist';

async function handleLoginHash(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const username = body.username;
    const hash = body.hash || body.password || body.psw || body.passwd || body.pwd;

    if (!username || !hash) {
      return jsonResponse({ code: 400, message: 'Username and password are required' }, 400);
    }

    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE username = ? AND disabled = 0'
    ).bind(username).first();

    if (!user) {
      return jsonResponse({ code: 401, message: 'Invalid username or password' }, 401);
    }

    // Verify the supplied credentials (one of the supported hash formats)
    const storedPassword = (user as any).password;
    const passwordOk =
      hash === await sha256(`${storedPassword}-${ALIST_HASH_SALT}`) ||
      hash === storedPassword ||
      hash === await sha256(storedPassword);

    if (!passwordOk) {
      return jsonResponse({ code: 401, message: 'Invalid username or password' }, 401);
    }

    // 2FA check
    const otpSecret = (user as any).otp_secret;
    if (otpSecret) {
      const ok = await verifyTotp(otpSecret, body.otp_code || '');
      if (!ok) {
        return jsonResponse({ code: 401, message: 'Invalid two-factor code' }, 401);
      }
    }

    const token = generateToken((user as any).id);
    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        token,
        user: { id: (user as any).id, username: (user as any).username, role: (user as any).role }
      }
    });
  } catch (error: any) {
    console.error('Login hash error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

function handleLogout(): Response {
  return jsonResponse({ code: 200, message: 'success' });
}

// POST /api/auth/2fa/generate - create a new TOTP secret for the current user
async function handleGenerate2FA(request: Request, env: Env): Promise<Response> {
  try {
    const user = await requireAuthUser(request, env);
    if (!user) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);

    if (user.otp_secret) {
      return jsonResponse({ code: 400, message: 'Two-factor authentication is already enabled' }, 400);
    }

    const secret = generateOtpSecret();
    const otpauth = buildOtpAuthUri(secret, user.username);
    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        secret,
        qr: await qrSvgDataUri(otpauth),
        url: otpauth,
      }
    });
  } catch (error: any) {
    console.error('Generate 2FA error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// POST /api/auth/2fa/verify - verify a code against a freshly generated secret and enable 2FA
async function handleVerify2FA(request: Request, env: Env): Promise<Response> {
  try {
    const user = await requireAuthUser(request, env);
    if (!user) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);

    const body = await request.json() as { code: string; secret?: string };

    // If a secret was supplied (fresh from /generate), verify against it and persist.
    // Otherwise fall back to the user's stored secret (used for re-verification).
    const secret = body.secret || (user as any).otp_secret || '';
    if (!secret) {
      return jsonResponse({ code: 400, message: 'No secret provided' }, 400);
    }

    const ok = await verifyTotp(secret, body.code || '');
    if (!ok) {
      return jsonResponse({ code: 401, message: 'Invalid code' }, 401);
    }

    if (body.secret) {
      await env.DB.prepare(
        'UPDATE users SET otp_secret = ? WHERE id = ?'
      ).bind(secret, user.id).run();
    }

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Verify 2FA error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// POST /api/auth/2fa/disable - disable 2FA for the current user (requires valid code)
async function handleDisable2FA(request: Request, env: Env): Promise<Response> {
  try {
    const user = await requireAuthUser(request, env);
    if (!user) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);

    const body = await request.json() as { code: string };
    const otpSecret = (user as any).otp_secret;
    if (!otpSecret) {
      return jsonResponse({ code: 400, message: 'Two-factor authentication is not enabled' }, 400);
    }

    const ok = await verifyTotp(otpSecret, body.code || '');
    if (!ok) {
      return jsonResponse({ code: 401, message: 'Invalid code' }, 401);
    }

    await env.DB.prepare(
      'UPDATE users SET otp_secret = NULL WHERE id = ?'
    ).bind(user.id).run();

    return jsonResponse({ code: 200, message: 'success' });
  } catch (error: any) {
    console.error('Disable 2FA error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

// Resolve the authenticated user (not the guest) or return null
async function requireAuthUser(request: Request, env: Env): Promise<any | null> {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token) return null;

  try {
    const userId = verifyToken(token);
    if (!userId) return null;

    return await env.DB.prepare(
      'SELECT * FROM users WHERE id = ? AND disabled = 0'
    ).bind(userId).first();
  } catch {
    return null;
  }
}

async function handleGetCurrentUser(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');

  // No/invalid token -> guest user (view + download only, no permissions).
  // When the "anonymous" setting is disabled, anonymous access is forbidden.
  const guestResponse = () => jsonResponse({ code: 200, message: 'success', data: getGuestUser() });
  const deniedResponse = () => jsonResponse({ code: 401, message: 'Unauthorized' }, 401);

  const anonymousEnabled = await isAnonymousEnabled(env);
  if (!token) {
    return anonymousEnabled ? guestResponse() : deniedResponse();
  }

  try {
    const userId = verifyToken(token);
    if (!userId) {
      return anonymousEnabled ? guestResponse() : deniedResponse();
    }

    const user = await env.DB.prepare(
      'SELECT id, username, role, disabled, otp_secret FROM users WHERE id = ? AND disabled = 0'
    ).bind(userId).first();

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

// Read the "anonymous" setting from D1 (true = anonymous browsing allowed)
async function isAnonymousEnabled(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).bind('anonymous').first();
    const value = (row as any)?.value;
    return value === 'true' || value === '1' || value === true;
  } catch {
    return false;
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

function generateToken(userId: number): string {
  const payload = { userId, exp: Date.now() + 24 * 60 * 60 * 1000 };
  return btoa(JSON.stringify(payload));
}

function verifyToken(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token));
    if (payload.exp < Date.now()) return null;
    return payload.userId;
  } catch {
    return null;
  }
}
