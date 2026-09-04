import { describe, expect, it } from 'vitest';
import { AuthorizationError } from '@audio-book/errors';
import { PlatformAdminGuard } from './platform-admin.guard.js';
import { TenantRoleGuard } from './tenant-role.guard.js';

function contextFor(principal: unknown) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as never;
}

/**
 * `PlatformAdminGuard` and `TenantRoleGuard` are complements, and the property
 * that matters is the one neither guard can assert alone: **no principal can
 * reach both surfaces**. That is what makes §6.6's content boundary a partition
 * rather than a convention, and it is what §135 of the Phase 8 brief asks be
 * tested ("test user attempting admin endpoints — must fail").
 */
describe('PlatformAdminGuard', () => {
  const admin = new PlatformAdminGuard();
  const tenant = new TenantRoleGuard();

  it('admits a PLATFORM_ADMIN', () => {
    expect(admin.canActivate(contextFor({ roles: ['PLATFORM_ADMIN'] }))).toBe(true);
  });

  it.each([['TENANT_OWNER'], ['TENANT_MEMBER'], []])(
    'refuses a principal whose roles are %j',
    (...roles) => {
      expect(() => admin.canActivate(contextFor({ roles: roles.flat() }))).toThrow(
        AuthorizationError,
      );
    },
  );

  it('fails closed when no principal was populated', () => {
    // A missing principal means the auth guard did not run; reading that as
    // "public route" is how an administrative API ends up unauthenticated.
    expect(() => admin.canActivate(contextFor(undefined))).toThrow(AuthorizationError);
  });

  it('no principal can pass both guards — the surfaces are disjoint', () => {
    const cases = [
      { roles: ['PLATFORM_ADMIN'] },
      { roles: ['TENANT_OWNER'] },
      { roles: ['TENANT_MEMBER'] },
      // The dual-role case §6.6 forces a decision on: TenantRoleGuard treats
      // the prohibition as absolute, so this principal reaches neither.
      { roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'] },
      { roles: ['SERVICE'] },
      { roles: [] },
    ];

    for (const principal of cases) {
      const passedAdmin = tryGuard(() => admin.canActivate(contextFor(principal)));
      const passedTenant = tryGuard(() => tenant.canActivate(contextFor(principal)));
      expect(passedAdmin && passedTenant).toBe(false);
    }
  });
});

function tryGuard(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}
