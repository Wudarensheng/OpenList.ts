import { Env } from '../types';
import { jsonResponse } from '../utils/response';
import {
  getAuthUser,
  generateToken,
  verifyPassword,
  hashPasswordForStorage,
  clientIp,
  isLoginLocked,
  recordLoginFailure,
  clearLoginFailures,
  revokeToken,
  sha256Hex,
  getPermission,
} from '../utils/auth';
import { generateOtpSecret, verifyTotp, buildOtpAuthUri, qrSvgDataUri } from '../utils/otp';
import { handleSsoRequest } from './sso';

export async function handleAuthRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // SSO login (OAuth2/OIDC)
  if (path === '/api/auth/sso' || path === '/api/auth/sso_callback' ||
      path === '/api/auth/get_sso_id' || path === '/api/auth/sso_get_token') {
    return handleSsoRequest(request, env);
  }

  if (path === '/api/auth/login' && request.method === 'POST') {
    return handleLogin(request, env, false);
  }

  if (path === '/api/auth/login/hash' && request.method === 'POST') {
    return handleLogin(request, env, true);
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
    const hash = await sha256Hex(testInput);
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
    return handleLogout(request, env);
  }

  if (path === '/api/auth/me' && request.method === 'GET') {
    return handleGetCurrentUser(request, env);
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}

async function handleLogin(request: Request, env: Env, preHashed: boolean): Promise<Response> {
  try {
    const body = await request.json() as { username: string; password: string; hash?: string; otp_code?: string };
    const username = body.username;
    // login/hash sends the static hash in `password`; some clients use `hash`.
    const supplied = body.password || body.hash || '';

    if (!username || !supplied) {
      return jsonResponse({ code: 400, message: 'Username and password are required' }, 400);
    }

    // Rate-limit per IP
    const ip = clientIp(request);
    if (await isLoginLocked(ip, env)) {
      return jsonResponse({ code: 429, message: '登录失败次数过多，请稍后再试' }, 429);
    }

    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE username = ? AND disabled = 0'
    ).bind(username).first();

    if (!user || !(await verifyPassword(
      (user as any).password,
      preHashed ? { staticHashValue: supplied } : { raw: supplied },
      { env, userId: (user as any).id }
    ))) {
      await recordLoginFailure(ip, env);
      return jsonResponse({ code: 401, message: '用户名或密码错误' }, 401);
    }

    // 2FA check. Return 402 so the frontend can show the code dialog.
    const otpSecret = (user as any).otp_secret;
    if (otpSecret) {
      const ok = await verifyTotp(otpSecret, body.otp_code || '');
      if (!ok) {
        await recordLoginFailure(ip, env);
        return jsonResponse({ code: 402, message: '需要两步验证码，请输入验证码后重试' }, 402);
      }
    }

    await clearLoginFailures(ip, env);
    const token = await generateToken(user, env);
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

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (token) {
    await revokeToken(token, env);
  }
  return jsonResponse({ code: 200, message: 'success' });
}

// POST /api/auth/2fa/generate - create a new TOTP secret for the current user
async function handleGenerate2FA(request: Request, env: Env): Promise<Response> {
  try {
    const user = await getAuthUser(request, env);
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
    const user = await getAuthUser(request, env);
    if (!user) return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);

    const body = await request.json() as { code: string; secret?: string };

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
    const user = await getAuthUser(request, env);
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

async function handleGetCurrentUser(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');

  const guestResponse = async () => {
    const guest = await getGuestUserFromDB(env);
    return jsonResponse({ code: 200, message: 'success', data: guest });
  };
  const deniedResponse = () => jsonResponse({ code: 401, message: 'Unauthorized' }, 401);

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
      home_dir: (user as any).base_path || '/'
    }
  });
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

// Load the guest user row from the DB (fall back to the hardcoded model if
// the row is missing).
export async function getGuestUserFromDB(env: Env): Promise<Record<string, any>> {
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
  return {
    id: 2,
    username: 'guest',
    role: 1,
    disabled: false,
    permission: 0,
    sso_id: '',
    otp: false,
    password: '',
    base_path: '/',
    home_dir: '/',
    allow_ldap: false,
  };
}
