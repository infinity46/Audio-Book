import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AuthenticationError } from '@audio-book/errors';
import {
  createRemoteJWKSet,
  jwtVerify,
  importSPKI,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose';
import type { FastifyRequest } from 'fastify';
import { API_CONFIG } from '../tokens.js';
import type { ApiConfig } from '@audio-book/config';

export interface AuthenticatedPrincipal {
  sub: string;
  tenantId: string;
  roles: string[];
  scopes: string[];
}

interface RequestWithPrincipal extends FastifyRequest {
  principal?: AuthenticatedPrincipal;
}

/**
 * Authentication BOUNDARY only (api-specification.md §5.1 / task Phase 1
 * scope): verifies a bearer JWT and populates {sub, tenant_id, roles,
 * scopes} onto the request for downstream tenant/authorization checks.
 * No registration/login/refresh/MFA flows — those are Phase 2. Fails
 * closed: any verification error is 401, never a silent pass-through.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private keyResolver: JWTVerifyGetKey | KeyLike | undefined;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  private async resolveKey(): Promise<JWTVerifyGetKey | KeyLike> {
    if (this.keyResolver) return this.keyResolver;
    const auth = this.config.secrets.auth;
    if (!auth) {
      throw new AuthenticationError({
        message: 'Authentication is not configured for this service.',
      });
    }
    this.keyResolver = auth.jwtJwksUrl
      ? createRemoteJWKSet(new URL(auth.jwtJwksUrl))
      : await importSPKI(auth.jwtPublicKey ?? '', 'RS256');
    return this.keyResolver;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AuthenticationError({ message: 'Missing bearer token.' });
    }
    const token = header.slice('Bearer '.length);
    const auth = this.config.secrets.auth;
    if (!auth) {
      throw new AuthenticationError({
        message: 'Authentication is not configured for this service.',
      });
    }

    try {
      const key = await this.resolveKey();
      const { payload } = await jwtVerify(token, key as JWTVerifyGetKey, {
        issuer: auth.jwtIssuer,
        audience: auth.jwtAudience,
      });

      const sub = requireStringClaim(payload, 'sub');
      const tenantId = requireStringClaim(payload, 'tenant_id');
      const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
      const scopes = Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [];

      request.principal = { sub, tenantId, roles, scopes };
      return true;
    } catch (err) {
      throw new AuthenticationError({ message: 'Invalid or expired token.', cause: err });
    }
  }
}

function requireStringClaim(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AuthenticationError({ message: `Token missing required claim: ${key}` });
  }
  return value;
}
