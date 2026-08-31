import { NotFoundError } from '@audio-book/errors';
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
