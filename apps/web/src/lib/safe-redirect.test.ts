import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './safe-redirect';

/**
 * Open-redirect guard. The cases that matter are the ones a naive
 * `startsWith('/')` lets through.
 */
describe('safeReturnPath', () => {
  it('keeps an ordinary same-site path', () => {
    expect(safeReturnPath('/projects/abc/generation?tab=1')).toBe('/projects/abc/generation?tab=1');
  });

  it('refuses an absolute URL', () => {
    expect(safeReturnPath('https://evil.example/steal')).toBe('/');
  });

  it('refuses a protocol-relative URL', () => {
    // `//evil.example` passes startsWith('/') but browsers resolve it as
    // cross-origin. This is the case the guard exists for.
    expect(safeReturnPath('//evil.example/steal')).toBe('/');
  });

  it('refuses a backslash-escaped protocol-relative URL', () => {
    expect(safeReturnPath('/\\evil.example')).toBe('/');
  });

  it('falls back to the dashboard for empty or missing input', () => {
    expect(safeReturnPath(null)).toBe('/');
    expect(safeReturnPath(undefined)).toBe('/');
    expect(safeReturnPath('')).toBe('/');
  });
});
