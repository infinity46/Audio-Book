import { describe, expect, it } from 'vitest';
import { clearedCookie, parseCookies, serializeCookie } from './cookies.js';

describe('serializeCookie / parseCookies round-trip', () => {
  it('a serialized cookie parses back to the same value', () => {
    const header = serializeCookie('session', 'abc def/+=', { httpOnly: true, secure: true });
    const [nameValue] = header.split(';');
    const cookieHeader = nameValue; // simulate what the browser sends back
    expect(parseCookies(cookieHeader)['session']).toBe('abc def/+=');
  });

  it('includes HttpOnly/Secure/SameSite/Path/Max-Age attributes when requested', () => {
    const header = serializeCookie('csrf', 'tok', {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      maxAgeSeconds: 3600,
    });
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Strict');
    expect(header).toContain('Max-Age=3600');
    expect(header).toContain('Path=/');
  });

  it('defaults to SameSite=Lax when not specified', () => {
    expect(serializeCookie('x', 'y')).toContain('SameSite=Lax');
  });

  it('parses multiple cookies from one header', () => {
    const parsed = parseCookies('session=abc; csrf=def; other=ghi');
    expect(parsed).toEqual({ session: 'abc', csrf: 'def', other: 'ghi' });
  });

  it('returns an empty object for an absent header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('clearedCookie sets Max-Age=0', () => {
    expect(clearedCookie('session')).toContain('Max-Age=0');
  });
});
