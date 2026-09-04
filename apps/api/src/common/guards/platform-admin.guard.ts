import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { AuthorizationError } from '@audio-book/errors';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedPrincipal } from './jwt-auth.guard.js';
import { PLATFORM_ADMIN } from './tenant-role.guard.js';

interface RequestWithPrincipal extends FastifyRequest {
  principal?: AuthenticatedPrincipal;
}

/**
 * The administrative surface's authorization (`api-specification.md` §16.22).
 *
 * This is the mirror image of `TenantRoleGuard`, and the pair is what makes
 * §6.6's content boundary a real partition rather than a convention:
 *
 * - `TenantRoleGuard` protects tenant **content** surfaces and refuses
 *   `PLATFORM_ADMIN` outright.
 * - `PlatformAdminGuard` protects **administrative** surfaces and requires
 *   `PLATFORM_ADMIN`, refusing every ordinary tenant principal.
 *
 * Because every route carries exactly one of the two, no principal can hold
 * both kinds of access through any single endpoint, and privilege escalation
 * would require changing a guard rather than forging a claim.
 *
 * Failures are `403 FORBIDDEN`, not `404`: §6.4's existence-hiding rule is
 * about tenant resources whose existence would otherwise leak across a tenant
 * boundary. The *administrative API itself* is documented and public
 * knowledge, so pretending it does not exist buys nothing and makes an
 * operator's misconfiguration much harder to diagnose.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = request.principal;

    // Fail closed: no principal means JwtAuthGuard did not run or did not
    // populate one, which must never be read as "this route is public".
    if (!principal) {
      throw new AuthorizationError({
        code: 'FORBIDDEN',
        message: 'No authenticated principal for an administrative route.',
      });
    }

    if (!principal.roles.includes(PLATFORM_ADMIN)) {
      throw new AuthorizationError({
        code: 'FORBIDDEN',
        message: 'This endpoint requires the PLATFORM_ADMIN role.',
      });
    }

    return true;
  }
}
