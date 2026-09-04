import { AuthorizationError, NotFoundError } from '@audio-book/errors';
import type { AuthenticatedPrincipal } from './guards/jwt-auth.guard.js';

/**
 * Ownership check (api-specification.md §6.3/§6.4): cross-tenant access
 * returns 404, never 403 — a 403 would disclose that the resource exists
 * for a tenant the caller can't see into.
 */
export function assertTenantOwnership(
  resource: { tenantId: string } | null | undefined,
  principal: AuthenticatedPrincipal,
  notFoundMessage = 'Resource not found.',
): asserts resource is { tenantId: string } {
  if (!resource || resource.tenantId !== principal.tenantId) {
    throw new NotFoundError({ message: notFoundMessage });
  }
}

/**
 * Role check *within* a tenant the caller already owns (per
 * `assertTenantOwnership`) — distinct from `TenantRoleGuard`, which only
 * checks tenant *membership* (`TENANT_OWNER` or `TENANT_MEMBER`, either
 * admitted). Some operations (`api-specification.md` §16.6.2/§16.6.3 book
 * restoration/purge) are `TENANT_OWNER`-only even for another member of the
 * same tenant, so this is a `403`, not a `404`: the resource's existence is
 * already established by the ownership check that necessarily runs first.
 */
export function requireRole(principal: AuthenticatedPrincipal, role: string): void {
  if (!principal.roles.includes(role)) {
    throw new AuthorizationError({
      message: `This operation requires the ${role} role.`,
    });
  }
}
