/**
 * TOTP (RFC 6238) implementation using Web Crypto API (HMAC-SHA1).
 * Compatible with Google Authenticator / Aegis / etc.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/[\s-=]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

// Base32 secret without padding (as shown in authenticator apps)
export function generateOtpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20)); // 160-bit
  return base32Encode(bytes);
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, message);
  return new Uint8Array(sig);
}

// Compute the TOTP code for a given secret and time (seconds since epoch)
export async function generateTotp(secret: string, timestamp: number = Date.now()): Promise<string> {
  const key = base32Decode(secret);
  const counter = Math.floor(timestamp / 1000 / TOTP_PERIOD);

  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }

  const hash = await hmacSha1(key, msg);

  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const otp = binary % Math.pow(10, TOTP_DIGITS);
  return otp.toString().padStart(TOTP_DIGITS, '0');
}

// Verify a user-supplied code. Allows a small window (+-1 period) for clock drift.
export async function verifyTotp(secret: string, code: string): Promise<boolean> {
  if (!secret || !code) return false;
  const cleanCode = code.trim();
  if (!/^\d{6}$/.test(cleanCode)) return false;

  const now = Date.now();
  for (let i = -1; i <= 1; i++) {
    const candidate = await generateTotp(secret, now + i * TOTP_PERIOD * 1000);
    if (candidate === cleanCode) return true;
  }
  return false;
}

// Build the otpauth:// provisioning URI used by QR code libraries
export function buildOtpAuthUri(secret: string, username: string, issuer = 'OpenList'): string {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?${params.toString()}`;
}
