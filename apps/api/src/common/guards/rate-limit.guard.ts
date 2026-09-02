import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { ApiConfig } from '@audio-book/config';
import { QuotaExceededError } from '@audio-book/errors';
import type { Logger } from '@audio-book/logging';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { API_CONFIG, LOGGER, REDIS } from '../tokens.js';
import { resolveBucket } from '../rate-limit/buckets.js';
import { RateLimiter, type RateLimitDimension } from '../rate-limit/rate-limiter.js';
import type { AuthenticatedPrincipal } from './jwt-auth.guard.js';

interface RequestWithPrincipal extends FastifyRequest {
  principal?: AuthenticatedPrincipal;
}

/**
 * api-specification.md §14.3. Runs AFTER JwtAuthGuard on authenticated routes,
 * so the principal is available and limits can be attributed to a user and a
 * tenant rather than only to an IP.
 *
 * Exceeding a limit is `429 RATE_LIMITED` with `Retry-After` and the
 * `RateLimit-*` headers — never a silent drop (§14.3). Note this is request
 * admission only: it never rejects work because the GPU fleet is busy, which
 * §14.3 calls out as a contract violation.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter: RateLimiter;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(REDIS) redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.limiter = new RateLimiter(redis, config.rateLimit.windowSeconds);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.rateLimit.enabled) return true;

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    const bucket = resolveBucket(request.method, request.url);
    const limit = this.config.rateLimit.buckets[bucket];
    const principal = request.principal;

    const dimensions: RateLimitDimension[] = [];
    if (principal) {
      dimensions.push({ kind: 'user', id: principal.sub, limit });
      // A tenant is many users, so holding a whole tenant to one user's
      // budget would throttle normal multi-seat use. The multiplier is a
      // starting point to tune against measured traffic, not a researched
      // value.
      dimensions.push({
        kind: 'tenant',
        id: principal.tenantId,
        limit: limit * TENANT_LIMIT_MULTIPLIER,
      });
    }
    const ip = request.ip;
    if (ip) dimensions.push({ kind: 'ip', id: ip, limit });
    if (dimensions.length === 0) return true;

    const decision = await this.limiter.consume(bucket, dimensions);

    if (decision.degraded) {
      // Fail-open is deliberate (see RateLimiter.consume) — but it must be
      // visible, or an outage silently disables rate limiting entirely.
      this.logger.warn(
        { bucket, path: request.url },
        'Rate limiter degraded: Redis unavailable, request allowed without counting',
      );
      return true;
    }

    void reply.header('RateLimit-Limit', String(decision.limit));
    void reply.header('RateLimit-Remaining', String(decision.remaining));
    void reply.header('RateLimit-Reset', String(decision.resetAt));

    if (!decision.allowed) {
      void reply.header('Retry-After', String(decision.retryAfterSeconds));
      this.logger.warn(
        { bucket, tenant_id: principal?.tenantId, path: request.url },
        'Rate limit exceeded',
      );
      throw new QuotaExceededError({
        code: 'RATE_LIMITED',
        message: `Rate limit exceeded for the ${bucket} bucket. Retry after ${decision.retryAfterSeconds}s.`,
      });
    }

    return true;
  }
}

/** Per-tenant headroom relative to a single principal's limit. */
const TENANT_LIMIT_MULTIPLIER = 10;
