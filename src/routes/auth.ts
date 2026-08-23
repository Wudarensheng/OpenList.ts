import { Env } from '../types';
import { jsonResponse } from '../utils/response';
import { getGuestUser } from '../utils/guest';

export async function handleAuthRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/auth/login' && request.method === 'POST') {
    return handleLogin(request, env);
  }

  if (path === '/api/auth/login/hash' && request.method === 'POST') {
    return handleLoginHash(request, env);
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
    const body = await request.json() as { username: string; password: string };
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

    const storedPassword = (user as any).password;

    // AList frontend sends sha256(plaintextPassword + "-" + ALIST_HASH_SALT)
    // We compare the received hash against sha256(storedPassword + "-" + salt)
    // which works when storedPassword is plaintext.
    const alistHash = await sha256(`${storedPassword}-${ALIST_HASH_SALT}`);
    if (hash === alistHash) {
      const token = generateToken((user as any).id);
      return jsonResponse({
        code: 200,
        message: 'success',
        data: {
          token,
          user: { id: (user as any).id, username: (user as any).username, role: (user as any).role }
        }
      });
    }

    // Fallback: direct comparison (stored password might already be a hash)
    if (hash === storedPassword) {
      const token = generateToken((user as any).id);
      return jsonResponse({
        code: 200,
        message: 'success',
        data: {
          token,
          user: { id: (user as any).id, username: (user as any).username, role: (user as any).role }
        }
      });
    }

    // Fallback: plain SHA-256 of stored password
    const storedHash = await sha256(storedPassword);
    if (hash === storedHash) {
      const token = generateToken((user as any).id);
      return jsonResponse({
        code: 200,
        message: 'success',
        data: {
          token,
          user: { id: (user as any).id, username: (user as any).username, role: (user as any).role }
        }
      });
    }

    return jsonResponse({ code: 401, message: 'Invalid username or password' }, 401);
  } catch (error: any) {
    console.error('Login hash error:', error);
    return jsonResponse({ code: 500, message: error.message || 'Internal Server Error' }, 500);
  }
}

function handleLogout(): Response {
  return jsonResponse({ code: 200, message: 'success' });
}

async function handleGetCurrentUser(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');

  // No/invalid token -> guest user (view + download only, no permissions)
  const guestResponse = () => jsonResponse({ code: 200, message: 'success', data: getGuestUser() });

  if (!token) {
    return guestResponse();
  }

  try {
    const userId = verifyToken(token);
    if (!userId) {
      return guestResponse();
    }

    const user = await env.DB.prepare(
      'SELECT id, username, role, disabled FROM users WHERE id = ? AND disabled = 0'
    ).bind(userId).first();

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
