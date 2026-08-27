import { describe, it, expect } from 'vitest';
import { generateToken, verifyToken, verifyPassword, hashPasswordForStorage, staticHashAsync, can, PERM, getPermission, ADMIN_PERMISSION } from './auth';

// Minimal mock of the D1 env used by the auth helpers.
function mockEnv(secret = 'test-secret'): any {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async first() {
            if (sql.includes('settings')) return { value: secret };
            if (sql.includes('invalid_tokens')) return null;
            if (sql.includes('SELECT pwd_ts')) return { pwd_ts: 0, disabled: 0 };
            if (sql.includes('users')) return { id: 1, pwd_ts: 0, disabled: 0 };
            return null;
          },
        };
      },
    },
  };
}

describe('auth token sign/verify', () => {
  it('generates a signed token that verifies', async () => {
    const env = mockEnv();
    const user = { id: 1, username: 'admin', pwd_ts: 0 };
    const token = await generateToken(user, env);
    expect(token).toContain('.');

    const payload = await verifyToken(token, env);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe(1);
    expect(payload!.username).toBe('admin');
  });

  it('rejects a forged (unsigned) token', async () => {
    const env = mockEnv();
    // Old-style base64 token (the original vulnerability)
    const forged = btoa(JSON.stringify({ userId: 1, exp: Date.now() + 86400000 }));
    const payload = await verifyToken(forged, env);
    expect(payload).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const env = mockEnv();
    const user = { id: 1, username: 'admin', pwd_ts: 0 };
    const token = await generateToken(user, env);
    const [b64] = token.split('.');
    // Re-sign with a different secret would fail; tamper the b64 instead
    const tampered = b64.slice(0, -2) + (b64.endsWith('AA') ? 'BB' : 'AA') + '.' + token.split('.')[1];
    expect(await verifyToken(tampered, env)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const env = mockEnv();
    const payload = { userId: 1, username: 'a', pwd_ts: 0, exp: Date.now() - 1000 };
    const { hmacSha256Hex } = await import('./auth');
    const b64 = btoa(JSON.stringify(payload));
    const sig = await hmacSha256Hex('test-secret', b64);
    const token = `${b64}.${sig}`;
    expect(await verifyToken(token, env)).toBeNull();
  });
});

describe('password hashing', () => {
  it('hashes and verifies a password', async () => {
    const stored = await hashPasswordForStorage('secret123');
    expect(stored).toContain(':');
    expect(await verifyPassword(stored, { raw: 'secret123' })).toBe(true);
    expect(await verifyPassword(stored, { raw: 'wrong' })).toBe(false);
  });

  it('verifies a pre-hashed (static) password', async () => {
    const stored = await hashPasswordForStorage('secret123');
    const staticValue = await staticHashAsync('secret123');
    expect(await verifyPassword(stored, { staticHashValue: staticValue })).toBe(true);
  });

  it('verifies legacy plaintext passwords', async () => {
    expect(await verifyPassword('admin', { raw: 'admin' })).toBe(true);
    expect(await verifyPassword('admin', { raw: 'other' })).toBe(false);
    // Client-side static hash of the legacy plaintext also works
    const staticValue = await staticHashAsync('admin');
    expect(await verifyPassword('admin', { staticHashValue: staticValue })).toBe(true);
  });
});

describe('permissions', () => {
  it('returns admin permission for role 2 regardless of stored value', () => {
    expect(getPermission({ role: 2, permission: 0 })).toBe(ADMIN_PERMISSION);
    expect(can({ role: 2, permission: 0 }, PERM.WRITE)).toBe(true);
  });

  it('respects stored permission bits for normal users', () => {
    const user = { role: 1, permission: PERM.WRITE | PERM.RENAME };
    expect(can(user, PERM.WRITE)).toBe(true);
    expect(can(user, PERM.RENAME)).toBe(true);
    expect(can(user, PERM.REMOVE)).toBe(false);
    expect(can(user, PERM.MOVE)).toBe(false);
  });
});
