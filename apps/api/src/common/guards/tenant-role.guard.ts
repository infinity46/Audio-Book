import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { AuthorizationError } from '@audio-book/errors';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedPrincipal } from './jwt-auth.guard.js';

interface RequestWithPrincipal extends FastifyRequest {
  principal?: AuthenticatedPrincipal;
}

/** api-specification.md §6.2. No implementation may extend this set. */
export const TENANT_ROLES = ['TENANT_OWNER', 'TENANT_MEMBER'] as const;
export const PLATFORM_ADMIN = 'PLATFORM_ADMIN';

/**
 * Authorization for tenant content surfaces (api-specification.md §6).
 *
 * Two rules, both from the spec rather than invented here:
 *
 * 1. **Deny by default (§6.1).** A principal must carry a tenant role to
 *    reach tenant resources. `SERVICE`/`WORKER` principals belong to
 *    `/internal/v1/**` and have no row in §6.5's matrix for these routes, so
 *    they are refused; so is a token carrying no role at all.
 *
 * 2. **The administrator content boundary (§6.6).** `PLATFORM_ADMIN` MUST NOT
 *    read book text, canonical text, Story Bible content, or audio bytes, and
 *    MUST NOT mint signed URLs for tenant artifacts, through *any* endpoint.
 *    Every controller this guard is applied to is such a surface, so an admin
 *    principal is refused outright with `ADMIN_CONTENT_ACCESS_DENIED`.
 *
 * Note on rule 2: the refusal is applied whenever `PLATFORM_ADMIN` is present,
 * even alongside a tenant role. §6.6 is written as an absolute prohibition, so
 * the fail-safe reading wins over the more permissive one — a principal that
 * could reach content by adding a tenant role beside its admin role would make
 * the boundary advisory rather than enforced. If product intent is that a
 * human may hold both roles and use their own tenant normally, this is the
 * single line to revisit, and it should be revisited deliberately.
 *
 * Failures here are `403`, not `404`: per §6.4, existence is already known to
 * the tenant, so hiding it would be confusing rather than safer. Cross-tenant
 * references remain `404` — that is `assertTenantOwnership`'s job, not this
 * guard's.
 */
@Injectable()
export class TenantRoleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = request.principal;

    // No principal means JwtAuthGuard did not run or did not populate one.
    // Fail closed rather than assume the route is public.
    if (!principal) {
      throw new AuthorizationError({
        code: 'FORBIDDEN',
        message: 'No authenticated principal for an authorized route.',
      });
    }

    if (principal.roles.includes(PLATFORM_ADMIN)) {
      throw new AuthorizationError({
        code: 'ADMIN_CONTENT_ACCESS_DENIED',
        message:
          'Administrative principals cannot reach tenant content or mint artifact access URLs.',
      });
    }

    const hasTenantRole = principal.roles.some((role) =>
      (TENANT_ROLES as readonly string[]).includes(role),
    );
    if (!hasTenantRole) {
      throw new AuthorizationError({
        code: 'FORBIDDEN',
        message: 'Principal lacks a tenant role for this resource.',
      });
    }

    return true;
  }
}
