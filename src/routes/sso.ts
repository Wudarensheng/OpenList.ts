/**
 * SSO (OAuth2 / OIDC) login - port of OpenList's server/handles/ssologin.go.
 *
 * Flow:
 *   1. GET /api/auth/sso?method=<platform>  -> 302 to the provider authorize URL
 *   2. Provider redirects to /api/auth/sso_callback?method=<platform>&code=...
 *   3. Callback exchanges the code, resolves the user by sso_id (auto-registers
 *      when enabled) and returns an HTML page that posts the token back to the
 *      opener window (window.opener.postMessage) - matching the frontend.
 *
 * Supported platforms: Github, Microsoft, Google, OIDC.
 */

import { Env } from '../types';
import { jsonResponse } from '../utils/response';
import { generateToken, randomSalt } from '../utils/auth';

interface SsoConfig {
  enabled: boolean;
  platform: string;
  clientId: string;
  clientSecret: string;
  oidcUsernameKey: string;
  endpoint: string;
  extraScopes: string;
  autoRegister: boolean;
  defaultPermission: number;
  defaultDir: string;
  compatibility: boolean;
}

async function getSsoConfig(env: Env): Promise<SsoConfig> {
  const get = async (key: string, d = ''): Promise<string> => {
    try {
      const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
      return (row as any)?.value ?? d;
    } catch {
      return d;
    }
  };
  return {
    enabled: (await get('sso_login_enabled', 'false')) === 'true',
    platform: await get('sso_login_platform', ''),
    clientId: await get('sso_client_id', ''),
    clientSecret: await get('sso_client_secret', ''),
    oidcUsernameKey: await get('sso_oidc_username_key', 'name'),
    endpoint: await get('sso_endpoint_name', ''),
    extraScopes: await get('sso_extra_scopes', ''),
    autoRegister: (await get('sso_auto_register', 'false')) === 'true',
    defaultPermission: parseInt(await get('sso_default_permission', '0')) || 0,
    defaultDir: await get('sso_default_dir', '/'),
    compatibility: (await get('sso_compatibility_mode', 'false')) === 'true',
  };
}

// ---------------------------------------------------------------------------
// state (CSRF) handling - stored in D1 since the Worker is stateless
// ---------------------------------------------------------------------------

async function saveState(state: string, env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO sso_states (state, created_at) VALUES (?, datetime('now'))"
    ).bind(state).run();
    // Opportunistic cleanup
    await env.DB.prepare(
      "DELETE FROM sso_states WHERE created_at < datetime('now', '-10 minutes')"
    ).run();
  } catch (e) {
    console.error('save sso state error:', e);
  }
}

async function verifyState(state: string, env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      "SELECT state FROM sso_states WHERE state = ? AND created_at > datetime('now', '-10 minutes')"
    ).bind(state).first();
    if (!row) return false;
    await env.DB.prepare('DELETE FROM sso_states WHERE state = ?').bind(state).run();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// platform definitions
// ---------------------------------------------------------------------------

interface PlatformDef {
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  scope: string;
  authField: string;
  idField: string;
  usernameField: string;
  useBearer: boolean; // token in Authorization: Bearer vs custom header
  /** Extra authorize query params (e.g. Dingtalk prompt=consent). */
  prompt?: string;
  /** Exchange the code via a JSON body instead of a form (Dingtalk). */
  jsonToken?: boolean;
  /** Header that carries the access token on the user request (Dingtalk). */
  tokenHeader?: string;
  /** Field name of the access token in the token response (default access_token). */
  accessField?: string;
}

function getPlatformDef(platform: string, config: SsoConfig): PlatformDef | null {
  switch (platform) {
    case 'Github':
      return { authorizeUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', userUrl: 'https://api.github.com/user', scope: 'read:user', authField: 'code', idField: 'id', usernameField: 'login', useBearer: true };
    case 'Microsoft':
      return { authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', userUrl: 'https://graph.microsoft.com/v1.0/me', scope: 'user.read', authField: 'code', idField: 'id', usernameField: 'displayName', useBearer: true };
    case 'Google':
      return { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', userUrl: 'https://www.googleapis.com/oauth2/v1/userinfo', scope: 'https://www.googleapis.com/auth/userinfo.profile', authField: 'code', idField: 'id', usernameField: 'name', useBearer: true };
    case 'Dingtalk':
      return { authorizeUrl: 'https://login.dingtalk.com/oauth2/auth', tokenUrl: 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken', userUrl: 'https://api.dingtalk.com/v1.0/contact/users/me', scope: 'openid', authField: 'authCode', idField: 'unionId', usernameField: 'nick', useBearer: true, prompt: 'consent', jsonToken: true, tokenHeader: 'x-acs-dingtalk-access-token', accessField: 'accessToken' };
    case 'Casdoor': {
      const endpoint = (config.endpoint || '').replace(/\/$/, '');
      if (!endpoint) return null;
      return { authorizeUrl: `${endpoint}/login/oauth/authorize`, tokenUrl: `${endpoint}/api/login/oauth/access_token`, userUrl: `${endpoint}/api/userinfo`, scope: 'profile', authField: 'code', idField: 'sub', usernameField: 'preferred_username', useBearer: true };
    }
    default:
      return null;
  }
}

/**
 * Resolve the actual OAuth provider.
 *
 * The `method` query param is an *intent* marker, not the provider: the
 * frontend always opens `/api/auth/sso?method=sso_get_token` (or
 * `get_sso_id`), and these values flow through the redirect_uri to the
 * callback so the backend knows what to hand back. The provider itself is the
 * configured `sso_login_platform`. When `method` is an explicit platform name
 * it is used as an override (backwards compatible with older clients).
 */
function resolvePlatform(method: string, config: SsoConfig): string {
  if (method === 'Github' || method === 'Microsoft' || method === 'Google' || method === 'Dingtalk' || method === 'Casdoor' || method === 'OIDC') {
    return method;
  }
  return config.platform;
}

function redirectUri(origin: string, method: string, compatibility: boolean): string {
  if (compatibility) return `${origin}/api/auth/${method}`;
  return `${origin}/api/auth/sso_callback?method=${encodeURIComponent(method)}`;
}

function postMessageHtml(key: string, value: string): string {
  return `<!DOCTYPE html><head></head><body><script>
window.opener.postMessage({"${key}":"${value.replace(/"/g, '&quot;')}"}, "*");
window.close();
</script></body>`;
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

export async function handleSsoRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const config = await getSsoConfig(env);

  // /api/auth/sso?method=<intent> -> redirect to provider
  if (path === '/api/auth/sso' && request.method === 'GET') {
    if (!config.enabled) {
      return jsonResponse({ code: 403, message: 'Single sign-on is not enabled' }, 403);
    }
    const method = url.searchParams.get('method') || '';
    if (!method) {
      return jsonResponse({ code: 400, message: 'no method provided' }, 400);
    }
    // The provider is the configured platform; `method` is the intent marker
    // (sso_get_token / get_sso_id) carried through the redirect_uri.
    const platform = resolvePlatform(method, config);
    if (platform === 'OIDC') {
      return oidcRedirect(request, env, config, method);
    }
    const def = getPlatformDef(platform, config);
    if (!def) {
      return jsonResponse({ code: 400, message: 'invalid platform' }, 400);
    }
    // Casdoor uses the endpoint itself as the OAuth state (matches OpenList).
    const state = platform === 'Casdoor' ? (config.endpoint || '').replace(/\/$/, '') : randomSalt(16);
    await saveState(state, env);
    const redirect = redirectUri(url.origin, method, config.compatibility);
    const params = new URLSearchParams({
      response_type: 'code',
      redirect_uri: redirect,
      client_id: config.clientId,
      scope: def.scope,
      state,
    });
    if (platform === 'Microsoft') params.set('response_mode', 'query');
    if (def.prompt) params.set('prompt', def.prompt);
    return Response.redirect(`${def.authorizeUrl}?${params.toString()}`, 302);
  }

  // Callback routes
  if (
    (path === '/api/auth/sso_callback' || path === '/api/auth/get_sso_id' || path === '/api/auth/sso_get_token') &&
    request.method === 'GET'
  ) {
    if (!config.enabled) {
      return jsonResponse({ code: 403, message: 'Single sign-on is not enabled' }, 403);
    }
    let method = url.searchParams.get('method') || '';
    if (config.compatibility) {
      method = path.split('/').pop() || '';
    }
    const platform = resolvePlatform(method, config);
    if (platform === 'OIDC') {
      return oidcCallback(request, env, config, method);
    }
    return platformCallback(request, env, config, method, platform);
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}

async function platformCallback(request: Request, env: Env, config: SsoConfig, method: string, platform: string): Promise<Response> {
  const url = new URL(request.url);
  const def = getPlatformDef(platform, config);
  if (!def) {
    return jsonResponse({ code: 400, message: 'invalid platform' }, 400);
  }

  const code = url.searchParams.get(def.authField) || '';
  if (!code) {
    return jsonResponse({ code: 400, message: 'No code provided' }, 400);
  }

  // Exchange the code for an access token. The redirect_uri must match the one
  // used in the authorize step (it carries the `method` intent marker).
  // Dingtalk exchanges the code with a JSON body and returns `accessToken`;
  // the other platforms use a form and return `access_token`.
  let accessToken = '';
  if (def.jsonToken) {
    const tokenResp = await fetch(def.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code,
        grantType: 'authorization_code',
      }),
    });
    const tokenBody: any = await tokenResp.json().catch(() => ({}));
    accessToken = tokenBody[def.accessField || 'accessToken'] || '';
    if (!tokenResp.ok || !accessToken) {
      return jsonResponse({ code: 400, message: 'Failed to exchange code' }, 400);
    }
  } else {
    const form = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri(url.origin, method, config.compatibility),
      scope: def.scope,
    });
    if (platform === 'Microsoft' || platform === 'Google' || platform === 'Casdoor') form.set('grant_type', 'authorization_code');
    const tokenResp = await fetch(def.tokenUrl, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const tokenBody: any = await tokenResp.json().catch(() => ({}));
    accessToken = tokenBody.access_token || '';
    if (!tokenResp.ok || !accessToken) {
      return jsonResponse({ code: 400, message: 'Failed to exchange code' }, 400);
    }
  }

  // Fetch the user profile. Dingtalk carries the token in a custom header.
  const userHeaders: Record<string, string> = { 'Accept': 'application/json' };
  if (def.tokenHeader) {
    userHeaders[def.tokenHeader] = accessToken;
  } else {
    userHeaders['Authorization'] = `Bearer ${accessToken}`;
  }
  const userResp = await fetch(def.userUrl, {
    method: 'GET',
    headers: userHeaders,
  });
  const userBody: any = await userResp.json().catch(() => ({}));
  if (!userResp.ok) {
    return jsonResponse({ code: 400, message: 'Failed to fetch user info' }, 400);
  }
  const userId = String(userBody[def.idField] ?? '');
  if (!userId || userId === '0') {
    return jsonResponse({ code: 400, message: 'error occurred' }, 400);
  }

  if (method === 'get_sso_id') {
    if (config.compatibility) {
      return Response.redirect(`${url.origin}/@manage?sso_id=${encodeURIComponent(userId)}`, 302);
    }
    return new Response(postMessageHtml('sso_id', userId), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const username = String(userBody[def.usernameField] ?? '');
  const user = await resolveSsoUser(env, userId, username, config);
  if (!user) {
    return jsonResponse({ code: 400, message: 'SSO user not found and auto-register is disabled' }, 400);
  }

  const token = await generateToken(user, env);
  if (config.compatibility) {
    return Response.redirect(`${url.origin}/@login?token=${encodeURIComponent(token)}`, 302);
  }
  return new Response(postMessageHtml('token', token), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Find a user by sso_id, or auto-register one when enabled.
async function resolveSsoUser(env: Env, ssoId: string, username: string, config: SsoConfig): Promise<any | null> {
  const existing = await env.DB.prepare('SELECT * FROM users WHERE sso_id = ?').bind(ssoId).first();
  if (existing) return existing;

  if (!config.autoRegister || !username) return null;
  // Create a user with a random password (can't log in with it; SSO is the way).
  const salt = randomSalt(16);
  const pwdHash = await hashForSso(salt);
  const base = config.defaultDir || '/';
  try {
    const result = await env.DB.prepare(
      'INSERT INTO users (username, password, salt, role, permission, base_path, sso_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(username, `${salt}:${pwdHash}`, salt, 0, config.defaultPermission || 0, base, ssoId).run();
    return await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(result.meta.last_row_id).first();
  } catch {
    // Username collision: suffix with sso_id.
    const result2 = await env.DB.prepare(
      'INSERT INTO users (username, password, salt, role, permission, base_path, sso_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(`${username}_${ssoId}`, `${salt}:${pwdHash}`, salt, 0, config.defaultPermission || 0, base, ssoId).run();
    return await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(result2.meta.last_row_id).first();
  }
}

async function hashForSso(salt: string): Promise<string> {
  const { sha256Hex } = await import('../utils/auth');
  // Empty password users can't log in by password; sso_id is the identity.
  return sha256Hex(`empty-${salt}`);
}

// ---------------------------------------------------------------------------
// OIDC
// ---------------------------------------------------------------------------

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

async function discoverOidc(config: SsoConfig): Promise<OidcDiscovery | null> {
  if (!config.endpoint) return null;
  const base = config.endpoint.replace(/\/$/, '');
  const resp = await fetch(`${base}/.well-known/openid-configuration`);
  if (!resp.ok) return null;
  const data: any = await resp.json().catch(() => null);
  if (!data || !data.authorization_endpoint || !data.token_endpoint) return null;
  return {
    authorization_endpoint: String(data.authorization_endpoint),
    token_endpoint: String(data.token_endpoint),
    userinfo_endpoint: String(data.userinfo_endpoint || ''),
  };
}

async function oidcRedirect(request: Request, env: Env, config: SsoConfig, method: string): Promise<Response> {
  const discovery = await discoverOidc(config);
  if (!discovery) {
    return jsonResponse({ code: 400, message: 'OIDC discovery failed' }, 400);
  }
  const url = new URL(request.url);
  const state = randomSalt(16);
  await saveState(state, env);
  const scopes = ['openid', 'profile', ...(config.extraScopes ? config.extraScopes.split(' ').filter(Boolean) : [])];
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: redirectUri(url.origin, method, config.compatibility),
    client_id: config.clientId,
    scope: scopes.join(' '),
    state,
  });
  return Response.redirect(`${discovery.authorization_endpoint}?${params.toString()}`, 302);
}

async function oidcCallback(request: Request, env: Env, config: SsoConfig, method: string): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!code) return jsonResponse({ code: 400, message: 'No code provided' }, 400);
  if (!(await verifyState(state, env))) {
    return jsonResponse({ code: 400, message: 'incorrect or expired state parameter' }, 400);
  }

  const discovery = await discoverOidc(config);
  if (!discovery) return jsonResponse({ code: 400, message: 'OIDC discovery failed' }, 400);

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(url.origin, method, config.compatibility),
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const tokenResp = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: form.toString(),
  });
  const tokenBody: any = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok || !tokenBody.access_token) {
    return jsonResponse({ code: 400, message: 'Failed to exchange code' }, 400);
  }

  // Prefer the id_token claims; fall back to the userinfo endpoint.
  let userId = '';
  let username = '';
  const idToken = tokenBody.id_token;
  if (idToken) {
    const claims = parseJwtPayload(idToken);
    userId = String(claims?.sub ?? '');
    username = String(claims?.[config.oidcUsernameKey] ?? claims?.preferred_username ?? '');
  }
  if (!userId) {
    const userResp = await fetch(discovery.userinfo_endpoint, {
      headers: { 'Authorization': `Bearer ${tokenBody.access_token}`, 'Accept': 'application/json' },
    });
    const userBody: any = await userResp.json().catch(() => ({}));
    userId = String(userBody.sub ?? '');
    username = String(userBody[config.oidcUsernameKey] ?? userBody.preferred_username ?? '');
  }
  if (!userId) {
    return jsonResponse({ code: 400, message: 'cannot get username from OIDC provider' }, 400);
  }

  if (method === 'get_sso_id') {
    if (config.compatibility) {
      return Response.redirect(`${url.origin}/@manage?sso_id=${encodeURIComponent(userId)}`, 302);
    }
    return new Response(postMessageHtml('sso_id', userId), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const user = await resolveSsoUser(env, userId, username, config);
  if (!user) {
    return jsonResponse({ code: 400, message: 'SSO user not found and auto-register is disabled' }, 400);
  }
  const token = await generateToken(user, env);
  if (config.compatibility) {
    return Response.redirect(`${url.origin}/@login?token=${encodeURIComponent(token)}`, 302);
  }
  return new Response(postMessageHtml('token', token), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function parseJwtPayload(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const pad = parts[1].length % 4 === 0 ? '' : '='.repeat(4 - (parts[1].length % 4));
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad;
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}
