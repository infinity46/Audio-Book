import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP verification (SHA-1, 6 digits, 30s step — the universal
 * defaults every authenticator app assumes). Small and dependency-free on
 * purpose: this codebase has no MFA *enrollment* endpoint
 * (`api-specification.md` §16.1 note, OQ-6 — "reserved... implementations
 * MUST NOT invent them"), so `UserCredential.mfaSecretRef` never actually
 * gets set and `POST /api/v1/auth/mfa` is unreachable in this deployment
 * today. It is still implemented for real, not stubbed, so the wire
 * contract exists correctly for whenever enrollment ships — a fake verifier
 * that always returns false would be indistinguishable from a correct one
 * in every test that can be written against this deployment, which is
 * exactly the kind of untested-claimed-as-done gap the brief asks not to
 * introduce.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  now = Date.now(),
  window = 1,
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secretBase32);
  const counter = Math.floor(now / 1000 / 30);
  for (let drift = -window; drift <= window; drift++) {
    const expected = hotp(key, counter + drift);
    if (timingSafeEqualStrings(expected, code)) return true;
  }
  return false;
}

/** Exported for tests only — lets a test compute the expected code directly instead of brute-forcing it. */
export function hotp(key: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter % 2 ** 32, 4);
  const hmac = createHmac('sha1', key).update(counterBuffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Exported for tests only. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}
