import { describe, it, expect } from 'vitest';
import { decodeName } from './archive';

// "中文.txt" encoded in GBK (no EFS flag -> the raw bytes are *not* UTF-8).
const GBK_NAME = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x2e, 0x74, 0x78, 0x74]);
// Same text in UTF-8.
const UTF8_NAME = new TextEncoder().encode('中文.txt');

describe('decodeName (archive entry names)', () => {
  it('keeps valid UTF-8 names untouched', () => {
    expect(decodeName(UTF8_NAME, 'GB18030')).toBe('中文.txt');
  });

  it('falls back to the configured legacy charset for non-UTF-8 bytes', () => {
    expect(decodeName(GBK_NAME, 'GB18030')).toBe('中文.txt');
    expect(decodeName(GBK_NAME, 'gbk')).toBe('中文.txt');
  });

  it('honours the EFS flag (force UTF-8)', () => {
    // forceUtf8 emulates flag bit 0x800: bytes are decoded as UTF-8 as-is.
    expect(decodeName(UTF8_NAME, 'GB18030', true)).toBe('中文.txt');
  });

  it('degrades gracefully for unsupported legacy charset labels', () => {
    // "ibm437"/"cp936" are not WHATWG labels, decode must not throw.
    expect(() => decodeName(GBK_NAME, 'ibm437')).not.toThrow();
  });

  it('handles empty input', () => {
    expect(decodeName(new Uint8Array(0), 'GB18030')).toBe('');
  });
});
