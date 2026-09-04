import { describe, expect, it } from 'vitest';
import { base32Decode, hotp, verifyTotp } from './totp.js';

const SECRET = 'JBSWY3DPEHPK3PXP'; // "Hello!" base32, a canonical RFC 6238 example secret

function counterAt(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000 / 30);
}

describe('verifyTotp', () => {
  it('rejects a non-6-digit code outright', () => {
    expect(verifyTotp(SECRET, '12345')).toBe(false);
    expect(verifyTotp(SECRET, 'abcdef')).toBe(false);
  });

  it('accepts the code for the current time step and rejects every other 6-digit code', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const expected = hotp(base32Decode(SECRET), counterAt('2026-01-01T00:00:00Z'));

    expect(verifyTotp(SECRET, expected, now, 0)).toBe(true);
    expect(verifyTotp(SECRET, expected === '000000' ? '111111' : '000000', now, 0)).toBe(false);
  });

  it('accepts a code from an adjacent time step within the window, and rejects one outside it', () => {
    const earlierCode = hotp(base32Decode(SECRET), counterAt('2026-01-01T00:00:00Z'));
    const oneStepLater = Date.parse('2026-01-01T00:00:30Z');
    const threeStepsLater = Date.parse('2026-01-01T00:01:30Z');

    expect(verifyTotp(SECRET, earlierCode, oneStepLater, 1)).toBe(true);
    expect(verifyTotp(SECRET, earlierCode, threeStepsLater, 1)).toBe(false);
  });
});
