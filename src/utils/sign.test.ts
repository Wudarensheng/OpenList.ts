import { describe, it, expect } from 'vitest';
import { signData, verifySign, getSignExpire, isSignAll } from './sign';

function mockEnv(settings: Record<string, string> = {}): any {
  return {
    DB: {
      prepare(sql: string) {
        let args: any[] = [];
        return {
          bind(...bound: any[]) {
            args = bound;
            return this;
          },
          async first() {
            const key = args[0];
            if (key === 'link_expiration') return { value: settings.link_expiration ?? '0' };
            if (key === 'sign_all') return { value: settings.sign_all ?? 'false' };
            if (sql.includes('settings')) return null;
            if (sql.includes('storages')) return { results: [] };
            return null;
          },
        };
      },
    },
  };
}

describe('sign data', () => {
  it('signs and verifies', async () => {
    const env = mockEnv();
    const sig = await signData('/backblaze/file.mp3', 0, env);
    expect(sig).toContain(':0');
    expect(await verifySign('/backblaze/file.mp3', sig, env)).toBe(true);
  });

  it('rejects an invalid signature', async () => {
    const env = mockEnv();
    expect(await verifySign('/backblaze/file.mp3', 'deadbeef:0', env)).toBe(false);
    expect(await verifySign('/backblaze/file.mp3', '', env)).toBe(false);
    expect(await verifySign('/backblaze/file.mp3', 'abc', env)).toBe(false);
  });

  it('rejects an expired signature', async () => {
    const env = mockEnv();
    const past = Math.floor(Date.now() / 1000) - 100;
    const sig = await signData('/backblaze/file.mp3', past, env);
    expect(await verifySign('/backblaze/file.mp3', sig, env)).toBe(false);
  });

  it('treats different data as invalid', async () => {
    const env = mockEnv();
    const sig = await signData('/backblaze/a.mp3', 0, env);
    expect(await verifySign('/backblaze/b.mp3', sig, env)).toBe(false);
  });
});

describe('sign settings', () => {
  it('returns 0 expiration when unset', async () => {
    const env = mockEnv();
    expect(await getSignExpire(env)).toBe(0);
  });

  it('computes expiration from link_expiration hours', async () => {
    const env = mockEnv({ link_expiration: '2' });
    const exp = await getSignExpire(env);
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('detects sign_all', async () => {
    expect(await isSignAll(mockEnv({ sign_all: 'true' }))).toBe(true);
    expect(await isSignAll(mockEnv({ sign_all: 'false' }))).toBe(false);
  });
});
