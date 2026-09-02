import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { AuthorizationError } from '@audio-book/errors';
import { TenantRoleGuard } from './tenant-role.guard.js';
import type { AuthenticatedPrincipal } from './jwt-auth.guard.js';

function contextFor(principal: AuthenticatedPrincipal | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext;
}

function principal(roles: string[]): AuthenticatedPrincipal {
  return { sub: 'user-1', tenantId: 'tenant-1', roles, scopes: [] };
}

/**
 * api-specification.md §6.1 (deny by default), §6.2 (the fixed role set), and
 * §6.6 (the administrator content boundary, a MUST NOT).
 */
describe('TenantRoleGuard', () => {
  const guard = new TenantRoleGuard();

  it('admits a tenant owner and a tenant member', () => {
    expect(guard.canActivate(contextFor(principal(['TENANT_OWNER'])))).toBe(true);
    expect(guard.canActivate(contextFor(principal(['TENANT_MEMBER'])))).toBe(true);
  });

  it('refuses a principal carrying no role at all (deny by default)', () => {
    expect(() => guard.canActivate(contextFor(principal([])))).toThrowError(AuthorizationError);
    try {
      guard.canActivate(contextFor(principal([])));
    } catch (err) {
      expect((err as AuthorizationError).code).toBe('FORBIDDEN');
    }
  });

  it('refuses SERVICE and WORKER principals — they belong to /internal/v1', () => {
    expect(() => guard.canActivate(contextFor(principal(['SERVICE'])))).toThrowError(
      AuthorizationError,
    );
    expect(() => guard.canActivate(contextFor(principal(['WORKER'])))).toThrowError(
      AuthorizationError,
    );
  });

  it('refuses PLATFORM_ADMIN with ADMIN_CONTENT_ACCESS_DENIED (§6.6)', () => {
    try {
      guard.canActivate(contextFor(principal(['PLATFORM_ADMIN'])));
      expect.unreachable('admin must not reach a content surface');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((err as AuthorizationError).code).toBe('ADMIN_CONTENT_ACCESS_DENIED');
    }
  });

  it('refuses PLATFORM_ADMIN even when a tenant role is also present', () => {
    // The boundary would be advisory rather than enforced if adding a tenant
    // role beside the admin role were enough to reach content.
    try {
      guard.canActivate(contextFor(principal(['PLATFORM_ADMIN', 'TENANT_OWNER'])));
      expect.unreachable('admin+tenant must still be refused');
    } catch (err) {
      expect((err as AuthorizationError).code).toBe('ADMIN_CONTENT_ACCESS_DENIED');
    }
  });

  it('fails closed when no principal was populated', () => {
    expect(() => guard.canActivate(contextFor(undefined))).toThrowError(AuthorizationError);
  });

  it('ignores unknown roles rather than treating them as a grant', () => {
    expect(() => guard.canActivate(contextFor(principal(['SUPER_USER', 'root'])))).toThrowError(
      AuthorizationError,
    );
  });
});
