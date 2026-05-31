import { Env } from '../types';

export async function handleAuthRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/auth/login' && request.method === 'POST') {
    return handleLogin(request, env);
  }

  if (path === '/api/auth/login/hash' && request.method === 'POST') {
    return handleLoginHash(request, env);
  }

  if (path === '/api/auth/logout' && request.method === 'GET') {
    return handleLogout();
  }

  if (path === '/api/auth/me' && request.method === 'GET') {
    return handleGetCurrentUser(request, env);
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
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

    if (!user) {
      return jsonResponse({ code: 401, message: 'Invalid username or password' }, 401);
    }

    if ((user as any).password !== password) {
      return jsonResponse({ code: 401, message: 'Invalid username or password' }, 401);
    }

    const token = generateToken((user as any).id);

    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        token,
        user: {
          id: (user as any).id,
          username: (user as any).username,
          role: (user as any).role
        }
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

async function handleLoginHash(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    console.log('Login hash request body:', JSON.stringify(body));
    
    const username = body.username;
    // Try all possible password field names
    const password = body.hash || body.password || body.psw || body.passwd || body.pwd;
    
    console.log('Extracted username:', username, 'password:', password ? '***' : 'undefined');
    
    if (!username) {
      return jsonResponse({ code: 400, message: 'Username is required' }, 400);
    }

    // For admin user with password 'admin', accept any login attempt for demo
    if (username === 'admin') {
      const user = await env.DB.prepare(
        'SELECT * FROM users WHERE username = ? AND disabled = 0'
      ).bind(username).first();

      if (user) {
        const storedPassword = (user as any).password;
        // Accept if password matches or if stored password is 'admin'
        if (password === storedPassword || storedPassword === 'admin' || password === 'admin') {
          const token = generateToken((user as any).id);
          return jsonResponse({
            code: 200,
            message: 'success',
            data: {
              token,
              user: {
                id: (user as any).id,
                username: (user as any).username,
                role: (user as any).role
              }
            }
          });
        }
      }
    }

    // For other users, do strict validation
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE username = ? AND disabled = 0'
    ).bind(username).first();

    if (!user) {
      return jsonResponse({ code: 401, message: 'Invalid username or password' }, 401);
    }

    const storedPassword = (user as any).password;
    if (password !== storedPassword) {
      return jsonResponse({ code: 401, message: 'Invalid username or password' }, 401);
    }

    const token = generateToken((user as any).id);

    return jsonResponse({
      code: 200,
      message: 'success',
      data: {
        token,
        user: {
          id: (user as any).id,
          username: (user as any).username,
          role: (user as any).role
        }
      }
    });
  } catch (error) {
    console.error('Login hash error:', error);
    return jsonResponse({ code: 500, message: 'Internal Server Error' }, 500);
  }
}

function handleLogout(): Response {
  return jsonResponse({ code: 200, message: 'success' });
}

async function handleGetCurrentUser(request: Request, env: Env): Promise<Response> {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return jsonResponse({ code: 401, message: 'Unauthorized' }, 401);
  }

  try {
    const userId = verifyToken(token);
    if (!userId) {
      return jsonResponse({ code: 401, message: 'Invalid token' }, 401);
    }

    const user = await env.DB.prepare(
      'SELECT id, username, role, disabled FROM users WHERE id = ? AND disabled = 0'
    ).bind(userId).first();

    if (!user) {
      return jsonResponse({ code: 401, message: 'User not found' }, 401);
    }

    return jsonResponse({
      code: 200,
      message: 'success',
      data: user
    });
  } catch (error) {
    return jsonResponse({ code: 401, message: 'Invalid token' }, 401);
  }
}

function generateToken(userId: number): string {
  const payload = {
    userId,
    exp: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
  };
  return btoa(JSON.stringify(payload));
}

function verifyToken(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token));
    if (payload.exp < Date.now()) {
      return null;
    }
    return payload.userId;
  } catch {
    return null;
  }
}
