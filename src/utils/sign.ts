/**
 * Download link signing (OpenList-compatible HMAC sign).
 *
 * A signed URL looks like:  /d/<path>?sign=<sig>:<expire>
 * where sig = base64url(HMAC-SHA256(secret, path + ":" + expire)) and
 * expire = 0 (never) or a unix timestamp. The secret is the private `token`
 * setting, and the expiry duration is controlled by the `link_expiration`
 * setting (hours; 0 = never expire).
 */

import { Env } from '../types';
import { getSecret } from './auth';

export async function signData(data: string, expire: number, env: Env): Promise<string> {
  const secret = await getSecret(env);
  const hmac = await hmacSha256Hex(secret, `${data}:${expire}`);
  return `${base64Url(hmac)}:${expire}`;
}

export async function verifySign(data: string, signature: string, env: Env): Promise<boolean> {
  if (!signature) return false;
  const idx = signature.lastIndexOf(':');
  if (idx < 0) return false;
  const sig = signature.slice(0, idx);
  const expStr = signature.slice(idx + 1);
  const expire = parseInt(expStr, 10);
  if (isNaN(expire)) return false;
  if (expire !== 0 && expire < Math.floor(Date.now() / 1000)) return false;
  const expected = await signData(data, expire, env);
  return expected === signature;
}

export async function signPath(path: string, env: Env): Promise<string> {
  const expire = await getSignExpire(env);
  return signData(path, expire, env);
}

/** Compute the sign expire timestamp once for a batch of paths. */
export async function getSignExpire(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).bind('link_expiration').first();
    const hours = parseFloat((row as any)?.value || '0');
    if (!hours || hours <= 0) return 0;
    return Math.floor(Date.now() / 1000) + hours * 3600;
  } catch {
    return 0;
  }
}

/** Whether sign links are globally enabled. */
export async function isSignAll(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).bind('sign_all').first();
    return (row as any)?.value === 'true';
  } catch {
    return false;
  }
}

/** Whether a path requires a signed download link (storage sign or global sign_all). */
export async function pathNeedsSign(path: string, env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).bind('sign_all').first();
    if ((row as any)?.value === 'true') return true;
  } catch {
    // ignore
  }
  try {
    const storage = await getStorageForPathSign(path, env);
    if (storage && (storage as any).enable_sign) return true;
  } catch {
    // ignore
  }
  return false;
}

async function getStorageForPathSign(path: string, env: Env): Promise<any | null> {
  const storages = await env.DB.prepare(
    'SELECT * FROM storages WHERE disabled = 0 ORDER BY mount_path DESC'
  ).all();
  for (const storage of storages.results || []) {
    const mountPath = (storage as any).mount_path;
    if (path.startsWith(mountPath) || mountPath === '/') {
      return storage;
    }
  }
  return null;
}

async function hmacSha256Hex(secret: string, input: string): Promise<string> {
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

function base64Url(hex: string): string {
  // Hex -> base64url
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
