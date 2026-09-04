import 'server-only';

import { cookies } from 'next/headers';
import { createRemoteJWKSet, importSPKI, jwtVerify, type JWTVerifyGetKey, type KeyLike } from 'jose';
import { serverConfig } from './env';

/**
 * Session handling for the `web` deployable.
 *
 * `context.md` §3.1 gives `web` a "BFF calls to `api`" role and §1933 names a
 * "colocated BFF for session handling"; this is that BFF. It is emphatically
 * **not** a second login system (Phase 9 rule 73):
 *
 *  - This deployment **verifies an externally-issued RS256 bearer token** and
 *    implements no registration, login, refresh, or MFA — `/api/v1/auth/**`
 *    does not exist and is documented as absent (Phase 8 finding P8-8,
 *    `api-usage-guide.md` §14).
 *  - So the token comes from the deployment's identity provider, exactly as it
 *    does for any other API client. This module's whole job is to hold that
 *    token **server-side**, in an httpOnly cookie, and attach it to proxied
 *    requests — instead of parking it in `localStorage` where any script on
 *    the page could read it.
 *  - It verifies the token against the *same* issuer, audience, and key
 *    material the API's `JwtAuthGuard` uses, so a token this app accepts is one
 *    the API will accept too. It mints nothing and signs nothing.
 *
 * The open gap this cannot close is recorded in `docs/application/frontend-api-gaps.md`
 * (GAP-1): there is no endpoint to obtain a token, so the sign-in page can only
 * accept one the identity provider already issued.
 */

/**
 * `__Host-` locks the cookie to this exact origin with no `Domain` scope — but
 * browsers only honour the prefix on a `Secure` cookie, which plain-HTTP local
 * development cannot set. The name therefore follows the security posture
 * rather than silently failing to set a cookie on `http://localhost:3001`.
 */
export function sessionCookieName(): string {
  return serverConfig().cookieSecure ? '__Host-audiobook_session' : 'audiobook_session';
}

export interface SessionPrincipal {
  sub: string;
  tenantId: string;
  roles: string[];
  scopes: string[];
  /** Seconds since epoch, from the token's own `exp`. */
  expiresAt: number | null;
}

let keyResolver: JWTVerifyGetKey | KeyLike | undefined;

async function resolveKey(): Promise<JWTVerifyGetKey | KeyLike> {
  if (keyResolver) return keyResolver;
  const { auth } = serverConfig();
  keyResolver = auth.jwksUrl
    ? createRemoteJWKSet(new URL(auth.jwksUrl))
    : await importSPKI(auth.publicKey ?? '', 'RS256');
  return keyResolver;
}

/** Test seam. */
export function resetKeyResolver(): void {
  keyResolver = undefined;
}

export class InvalidTokenError extends Error {
  constructor(message = 'The token was not accepted.') {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

/**
 * Verifies a token the way the API will, and extracts the principal.
 *
 * Verifying here is not a substitute for the API's own check — the API remains
 * authoritative (rule 74). It exists so this app refuses to store a credential
 * it can already tell is unusable, and so the shell can render the right
 * workspace without a round trip.
 */
export async function verifyToken(token: string): Promise<SessionPrincipal> {
  const { auth } = serverConfig();
  try {
    const key = await resolveKey();
    const { payload } = await jwtVerify(token, key as JWTVerifyGetKey, {
      issuer: auth.issuer,
      audience: auth.audience,
    });
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    const tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : '';
    if (!sub || !tenantId) {
      throw new InvalidTokenError('The token is missing the sub or tenant_id claim.');
    }
    return {
      sub,
      tenantId,
      roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
      scopes: Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [],
      expiresAt: typeof payload.exp === 'number' ? payload.exp : null,
    };
  } catch (err) {
    if (err instanceof InvalidTokenError) throw err;
    throw new InvalidTokenError('The token is invalid, expired, or from another issuer.');
  }
}

export async function startSession(token: string): Promise<SessionPrincipal> {
  const principal = await verifyToken(token);
  const { cookieSecure } = serverConfig();
  const store = await cookies();
  store.set(sessionCookieName(), token, {
    httpOnly: true,
    // `Lax` still sends the cookie on top-level navigation (so a bookmarked
    // project URL opens signed in) while withholding it from cross-site
    // sub-requests, which is the CSRF property that matters here. Write routes
    // additionally assert same-origin — see `bff/route-handler.ts`.
    sameSite: 'lax',
    secure: cookieSecure,
    path: '/',
    // Never outlive the credential itself.
    expires: principal.expiresAt ? new Date(principal.expiresAt * 1000) : undefined,
  });
  return principal;
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(sessionCookieName());
}

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(sessionCookieName())?.value ?? null;
}

/**
 * The current principal, or `null`. Never throws on an expired token: an
 * expired session is a sign-in prompt, not a crash.
 */
export async function currentPrincipal(): Promise<SessionPrincipal | null> {
  const token = await readSessionToken();
  if (!token) return null;
  try {
    return await verifyToken(token);
  } catch {
    return null;
  }
}
