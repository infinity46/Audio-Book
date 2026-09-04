/**
 * Manual `Set-Cookie`/`Cookie` handling — no `@fastify/cookie` plugin is
 * registered in this service (`apps/api/src/main.ts`), and adding one for
 * two cookie names is more surface than a ~30-line parser/serializer here.
 *
 * `client_type: "BROWSER"` login (`api-specification.md` §16.1) sets two
 * cookies: `session` (httpOnly — carries the opaque refresh token, never
 * read by page JS) and `csrf` (readable by JS, double-submit companion —
 * every cookie-authenticated mutation on `/auth/**` must echo it back as an
 * `X-CSRF-Token` header, or it is refused). The short-lived access token is
 * deliberately never cookied: a browser client that received it (from
 * `/auth/login` when a refresh immediately follows, or from `/auth/refresh`
 * itself) holds it in memory only, and attaches it as `Authorization:
 * Bearer` like an API client — `JwtAuthGuard` needs no cookie-reading path
 * at all, so this stays fully additive to it.
 */

export const SESSION_COOKIE_NAME = 'session';
export const CSRF_COOKIE_NAME = 'csrf';

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
  maxAgeSeconds?: number;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, options.maxAgeSeconds)}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

/** A `Max-Age=0` cookie clear — used by logout for both cookies regardless of client_type. */
export function clearedCookie(name: string, options: Pick<CookieOptions, 'secure' | 'path'> = {}): string {
  return serializeCookie(name, '', { ...options, maxAgeSeconds: 0 });
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}
