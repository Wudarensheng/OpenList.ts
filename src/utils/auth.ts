/**
 * Authentication & authorization utilities.
 *
 * Security fixes over the original plaintext-Base64 token scheme:
 *  - Tokens are HMAC-SHA256 signed with a secret stored in the private
 *    `token` setting, so they can no longer be forged client-side.
 *  - Passwords are stored as `salt:sha256(sha256(pwd + "-" + saltConst) + "-" + salt)`
 *    matching OpenList's scheme (legacy plaintext rows are migrated on login).
 *  - Login attempts are rate-limited per IP.
 *  - Password changes bump `pwd_ts`, invalidating previously issued tokens.
 *  - Logout blacklists the presented token (hashed) so it can't be reused.
 */

import { Env } from '../types';

export const ALIST_HASH_SALT = 'https://github.com/alist-org/alist';

// ---------------------------------------------------------------------------
// crypto helpers
// ---------------------------------------------------------------------------

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256Hex(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

// ---------------------------------------------------------------------------
// secret (the private `token` setting)
// ---------------------------------------------------------------------------

const secretCache = new Map<string, { secret: string; fetchedAt: number }>();
const SECRET_TTL_MS = 60_000;

export async function getSecret(env: Env): Promise<string> {
  const key = 'default';
  const cached = secretCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SECRET_TTL_MS) {
    return cached.secret;
  }
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('token').first();
    const secret = (row as any)?.value || '';
    if (secret) {
      secretCache.set(key, { secret, fetchedAt: Date.now() });
      return secret;
    }
  } catch {
    // fall through
  }
  // No stored secret (init not yet run or setting deleted). Generate one and
  // persist it so signing stays stable across requests/isolates.
  try {
    const generated = randomToken(32);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO settings (key, value, help, type, group_id, flag) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind('token', generated, 'Sign/Token secret (do not expose)', 'string', 4, 1).run();
    secretCache.set(key, { secret: generated, fetchedAt: Date.now() });
    return generated;
  } catch {
    // Last resort: a per-isolate random secret (unstable but not predictable).
    const ephemeral = randomToken(32);
    secretCache.set(key, { secret: ephemeral, fetchedAt: Date.now() });
    return ephemeral;
  }
}

function randomToken(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const arr = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of arr) s += chars[b % chars.length];
  return s;
}

export function invalidateSecretCache(): void {
  secretCache.clear();
}

// ---------------------------------------------------------------------------
// token sign / verify
// ---------------------------------------------------------------------------

export interface TokenPayload {
  userId: number;
  username: string;
  pwd_ts: number;
  exp: number;
}

export async function generateToken(user: any, env: Env): Promise<string> {
  const payload: TokenPayload = {
    userId: user.id,
    username: user.username,
    pwd_ts: Number(user.pwd_ts) || 0,
    exp: Date.now() + 24 * 60 * 60 * 1000,
  };
  const b64 = base64UrlEncode(JSON.stringify(payload));
  const secret = await getSecret(env);
  const sig = base64UrlEncode(await hmacSha256Hex(secret, b64));
  return `${b64}.${sig}`;
}

export async function verifyToken(token: string, env: Env): Promise<TokenPayload | null> {
  try {
    const idx = token.lastIndexOf('.');
    if (idx <= 0) return null;
    const b64 = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    const secret = await getSecret(env);
    const expected = base64UrlEncode(await hmacSha256Hex(secret, b64));
    if (expected !== sig) return null;

    const payload = JSON.parse(base64UrlDecode(b64)) as TokenPayload;
    if (!payload || !payload.userId) return null;
    if (payload.exp < Date.now()) return null;

    // Blacklist check (logout)
    const tokenHash = await sha256Hex(token);
    const revoked = await env.DB.prepare(
      'SELECT token_hash FROM invalid_tokens WHERE token_hash = ? AND expires_at > datetime(\'now\')'
    ).bind(tokenHash).first();
    if (revoked) return null;

    // Password-change check: tokens issued before a password change are invalid.
    const userRow = await env.DB.prepare(
      'SELECT pwd_ts, disabled FROM users WHERE id = ?'
    ).bind(payload.userId).first();
    if (!userRow || (userRow as any).disabled === 1) return null;
    if (Number((userRow as any).pwd_ts || 0) > Number(payload.pwd_ts || 0)) return null;

    return payload;
  } catch {
    return null;
  }
}

/** Resolve the currently-authenticated user (non-guest) or null. */
export async function getAuthUser(request: Request, env: Env): Promise<any | null> {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const payload = await verifyToken(token, env);
  if (!payload) return null;
  try {
    return await env.DB.prepare(
      'SELECT * FROM users WHERE id = ? AND disabled = 0'
    ).bind(payload.userId).first();
  } catch {
    return null;
  }
}

/** Resolve the current user, falling back to the guest row. */
export async function getCurrentUser(request: Request, env: Env): Promise<any | null> {
  const user = await getAuthUser(request, env);
  if (user) return user;
  try {
    return await env.DB.prepare(
      'SELECT * FROM users WHERE username = ? AND disabled = 0'
    ).bind('guest').first();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// password hashing (OpenList-compatible)
// ---------------------------------------------------------------------------

export async function staticHashAsync(password: string): Promise<string> {
  return sha256Hex(`${password}-${ALIST_HASH_SALT}`);
}

export async function twoHashPwdAsync(staticHashValue: string, salt: string): Promise<string> {
  return sha256Hex(`${staticHashValue}-${salt}`);
}

export function randomSalt(len = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const arr = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of arr) s += chars[b % chars.length];
  return s;
}

export function isHashedStored(stored: string): boolean {
  const idx = stored.indexOf(':');
  return idx > 0 && idx < stored.length - 1;
}

/**
 * Verify a user-supplied password against the stored value.
 * Accepts raw passwords and pre-hashed (client-side sha256) static hashes.
 * Optionally migrates a legacy plaintext password to the hashed format.
 */
export async function verifyPassword(
  stored: string,
  supplied: { raw?: string; staticHashValue?: string },
  migrate?: { env: Env; userId: number }
): Promise<boolean> {
  if (!stored) return false;

  const colonIdx = stored.indexOf(':');
  const isHashed = colonIdx > 0 && !stored.includes('\n') && stored.length > colonIdx + 1;
  const salt = isHashed ? stored.slice(0, colonIdx) : '';
  const storedHash = isHashed ? stored.slice(colonIdx + 1) : stored;

  let candidateStatic: string;
  if (supplied.raw !== undefined) {
    candidateStatic = await staticHashAsync(supplied.raw);
  } else if (supplied.staticHashValue) {
    candidateStatic = supplied.staticHashValue;
  } else {
    return false;
  }

  if (isHashed) {
    const computed = await twoHashPwdAsync(candidateStatic, salt);
    return computed === storedHash;
  }

  // Legacy plaintext row.
  let ok: boolean;
  if (supplied.raw !== undefined) {
    ok = supplied.raw === stored;
  } else {
    ok = supplied.staticHashValue === await staticHashAsync(stored);
  }

  // Migrate plaintext -> hashed on successful login.
  if (ok && migrate) {
    const newSalt = randomSalt();
    const newHash = await twoHashPwdAsync(candidateStatic, newSalt);
    try {
      await migrate.env.DB.prepare(
        'UPDATE users SET password = ?, salt = ?, pwd_ts = CAST(strftime(\'%s\',\'now\') AS INTEGER) WHERE id = ?'
      ).bind(`${newSalt}:${newHash}`, newSalt, migrate.userId).run();
    } catch {
      // Migration failure must not fail the login.
    }
  }
  return ok;
}

/** Compute the stored hash for a raw password (for user creation). */
export async function hashPasswordForStorage(raw: string): Promise<string> {
  const salt = randomSalt();
  const hash = await twoHashPwdAsync(await staticHashAsync(raw), salt);
  return `${salt}:${hash}`;
}

// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------

export const PERM = {
  SEE_HIDES: 1 << 0,
  ACCESS_WITHOUT_PASSWORD: 1 << 1,
  ADD_OFFLINE_DOWNLOAD: 1 << 2,
  WRITE: 1 << 3,
  RENAME: 1 << 4,
  MOVE: 1 << 5,
  COPY: 1 << 6,
  REMOVE: 1 << 7,
  WEBDAV_READ: 1 << 8,
  WEBDAV_MANAGE: 1 << 9,
  FTP_ACCESS: 1 << 10,
  FTP_MANAGE: 1 << 11,
  READ_ARCHIVES: 1 << 12,
  DECOMPRESS: 1 << 13,
  SHARE: 1 << 14,
  CUSTOMIZE_SHARE_ID: 1 << 15,
} as const;

export const ADMIN_PERMISSION = 0xFFFFFFFF;

export function getPermission(user: any): number {
  if (user && user.role === 2) return ADMIN_PERMISSION;
  return Number(user?.permission) || 0;
}

export function can(user: any, bit: number): boolean {
  if (!user) return false;
  if (user.role === 2) return true;
  return (getPermission(user) & bit) !== 0;
}

// ---------------------------------------------------------------------------
// login rate limiting (per IP)
// ---------------------------------------------------------------------------

const MAX_AUTH_RETRIES = 5;
const LOCK_DURATION_SECONDS = 300;

export function clientIp(request: Request): string {
  const cf = (request as any).headers?.get('CF-Connecting-IP');
  if (cf) return cf;
  const fwd = request.headers.get('X-Forwarded-For');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

export async function isLoginLocked(ip: string, env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      'SELECT count FROM login_attempts WHERE ip = ? AND expires_at > datetime(\'now\')'
    ).bind(ip).first();
    return !!row && (row as any).count >= MAX_AUTH_RETRIES;
  } catch {
    return false;
  }
}

export async function recordLoginFailure(ip: string, env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO login_attempts (ip, count, expires_at)
       VALUES (?, 1, datetime('now', '+' || ? || ' seconds'))
       ON CONFLICT(ip) DO UPDATE SET count = count + 1, expires_at = datetime('now', '+' || ? || ' seconds')`
    ).bind(ip, LOCK_DURATION_SECONDS, LOCK_DURATION_SECONDS).run();
  } catch (e) {
    console.error('recordLoginFailure error:', e);
  }
}

export async function clearLoginFailures(ip: string, env: Env): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// logout blacklist
// ---------------------------------------------------------------------------

export async function revokeToken(token: string, env: Env): Promise<void> {
  if (!token) return;
  try {
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO invalid_tokens (token_hash, expires_at)
       VALUES (?, datetime('now', '+1 day'))`
    ).bind(tokenHash).run();
    // Opportunistic cleanup
    await env.DB.prepare(
      'DELETE FROM invalid_tokens WHERE expires_at < datetime(\'now\')'
    ).run();
  } catch (e) {
    console.error('revokeToken error:', e);
  }
}

// ---------------------------------------------------------------------------
// token helpers (legacy endpoints)
// ---------------------------------------------------------------------------

export function parseBearer(request: Request): string {
  return request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || '';
}
