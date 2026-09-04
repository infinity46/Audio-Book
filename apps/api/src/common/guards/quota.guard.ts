import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { QuotaService } from '../quota.service.js';
import { resolveBucket } from '../rate-limit/buckets.js';
import type { AuthenticatedPrincipal } from './jwt-auth.guard.js';

interface RequestWithPrincipal extends FastifyRequest {
  principal?: AuthenticatedPrincipal;
  // Fastify types `params` as `unknown` on the generic request; every route
  // here declares its parameters as strings, so narrowing is safe and keeps
  // the read below from needing a cast at each use.
  params: Record<string, string | undefined>;
}

/**
 * Tenant quota admission for expensive work (`api-specification.md` §14.3,
 * `context.md` §3.2.3).
 *
 * **Derived from the request, not from a per-route decorator** — the same
 * reasoning `buckets.ts` documents for rate limiting, and for the same reason:
 * a decorator someone forgets to add leaves that route with no quota check at
 * all, which is the one failure mode an admission control must not have. A new
 * stage sub-resource added tomorrow is quota-checked the day it exists.
 *
 * Runs **after** `RateLimitGuard` in the chain, so a caller hammering an
 * endpoint is told to slow down before being told they are out of allowance —
 * the cheaper check first, and the more actionable message first.
 *
 * §14.3 draws a line this guard respects: quotas are about a tenant's
 * entitlement, never about fleet capacity. Nothing here rejects work because
 * the GPU queue is deep; that would be backpressure dressed up as a quota, and
 * the spec calls it a contract violation.
 */
@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(private readonly quotas: QuotaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = request.principal;
    if (!principal) return true; // Unauthenticated requests never reach a quota.

    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return true;

    const bucket = resolveBucket(method, request.url);
    if (bucket !== 'expensive' && bucket !== 'upload') return true;

    const bookId = request.params?.bookId;
    if (!bookId) return true;

    await this.quotas.assertCanStartGeneration(principal, bookId);
    return true;
  }
}
