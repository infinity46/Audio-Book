import { Inject, Injectable } from '@nestjs/common';
import type { ApiConfig } from '@audio-book/config';
import { AuthenticationError } from '@audio-book/errors';
import { generateId } from '@audio-book/events';
import { decodeJwt, importPKCS8, SignJWT, type KeyLike } from 'jose';
import { API_CONFIG } from '../common/tokens.js';

export interface AccessTokenPrincipal {
  sub: string;
  tenantId: string;
  roles: string[];
  scopes: string[];
  /** Session id — lets `/auth/logout` revoke the exact session a token belongs to. */
  sessionId: string;
}

export interface IssuedAccessToken {
  accessToken: string;
  expiresIn: number;
}

/**
 * Token *issuance* — the counterpart `JwtAuthGuard` never had
 * (`common/guards/jwt-auth.guard.ts` only verifies). Deliberately a
 * separate, narrow service rather than a change to that guard: every
 * existing route's verification behavior is untouched, and this is additive
 * — a new capability, not a modified one (`context.md` §18.1's claim set:
 * `{sub, tenant_id, roles, scopes, exp, iat, jti, aud, iss}`, plus `sid`
 * here, a private claim `JwtAuthGuard` already ignores since it only reads
 * the four claims it needs).
 *
 * Signs with `AUTH_JWT_PRIVATE_KEY` (PKCS8 PEM) — the operator is
 * responsible for making this the private half of whatever
 * `AUTH_JWT_PUBLIC_KEY`/`AUTH_JWT_JWKS_URL` `JwtAuthGuard` verifies against.
 * Fails closed with a clear, non-crashing error if issuance was never
 * configured, mirroring `JwtAuthGuard`'s own "not configured" message.
 */
@Injectable()
export class TokenService {
  private keyPromise: Promise<KeyLike> | undefined;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  private resolveKey(): Promise<KeyLike> {
    if (this.keyPromise) return this.keyPromise;
    const pem = this.config.secrets.auth?.jwtPrivateKey;
    if (!pem) {
      throw new AuthenticationError({
        code: 'AUTH_ISSUANCE_NOT_CONFIGURED',
        message: 'Token issuance is not configured for this service.',
      });
    }
    this.keyPromise = importPKCS8(pem, 'RS256');
    return this.keyPromise;
  }

  async issueAccessToken(principal: AccessTokenPrincipal): Promise<IssuedAccessToken> {
    const auth = this.config.secrets.auth;
    if (!auth) {
      throw new AuthenticationError({
        code: 'AUTH_ISSUANCE_NOT_CONFIGURED',
        message: 'Token issuance is not configured for this service.',
      });
    }
    const key = await this.resolveKey();
    const expiresIn = this.config.authPolicy.accessTokenTtlSeconds;

    const accessToken = await new SignJWT({
      tenant_id: principal.tenantId,
      roles: principal.roles,
      scopes: principal.scopes,
      sid: principal.sessionId,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject(principal.sub)
      .setIssuedAt()
      .setIssuer(auth.jwtIssuer)
      .setAudience(auth.jwtAudience)
      .setJti(generateId())
      .setExpirationTime(`${expiresIn}s`)
      .sign(key);

    return { accessToken, expiresIn };
  }
}

/**
 * Reads the `sid` (session id) private claim back out of an already
 * bearer-verified access token — `JwtAuthGuard` has already checked the
 * signature by the time a controller runs, so this only needs to decode,
 * never re-verify. Used by `/auth/logout` to find the exact session to
 * revoke without threading a new field through `AuthenticatedPrincipal`
 * (which every other guard/controller in the codebase also constructs from
 * `JwtAuthGuard` and would otherwise need to learn about).
 */
export function decodeSessionId(bearerToken: string): string | undefined {
  const claims = decodeJwt(bearerToken);
  return typeof claims.sid === 'string' ? claims.sid : undefined;
}
