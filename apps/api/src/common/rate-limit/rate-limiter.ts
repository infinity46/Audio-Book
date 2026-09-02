import type { Redis } from 'ioredis';
import type { RateLimitBucket } from './buckets.js';

export interface RateLimitDecision {
  allowed: boolean;
  /** The limit of whichever dimension was closest to exhaustion. */
  limit: number;
  remaining: number;
  /** Unix seconds at which the binding window resets. */
  resetAt: number;
  retryAfterSeconds: number;
  /** True when the limiter could not reach Redis and therefore allowed the request. */
  degraded: boolean;
}

export interface RateLimitDimension {
  /** e.g. 'user', 'ip', 'tenant' — part of the Redis key, so it must be stable. */
  kind: string;
  id: string;
  limit: number;
}

/**
 * Fixed-window counters in Redis, one key per (bucket, dimension, window).
 *
 * Fixed window rather than sliding: it costs a single INCR per dimension and
 * its worst case (a burst spanning a window boundary) is acceptable for the
 * abuse-bounding job this does. A sliding window is the upgrade path if
 * measured traffic shows boundary bursts actually matter.
 *
 * Redis is shared across API replicas, so limits hold for the deployment
 * rather than per-process — which is the whole point of not doing this in
 * memory.
 */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly windowSeconds: number,
  ) {}

  /**
   * Counts this request against every dimension and reports the most
   * constrained one. All dimensions are incremented (not just the binding
   * one) so that per-user, per-IP, and per-tenant limits stay independently
   * accurate — §14.3 requires all three.
   */
  async consume(
    bucket: RateLimitBucket,
    dimensions: RateLimitDimension[],
  ): Promise<RateLimitDecision> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowIndex = Math.floor(nowSeconds / this.windowSeconds);
    const resetAt = (windowIndex + 1) * this.windowSeconds;

    let counts: number[];
    try {
      const pipeline = this.redis.pipeline();
      for (const dimension of dimensions) {
        const key = `ratelimit:${bucket}:${dimension.kind}:${dimension.id}:${windowIndex}`;
        pipeline.incr(key);
        // Re-arming the TTL on every hit is harmless (the window key is
        // replaced each window anyway) and guarantees no key outlives its
        // window if the first EXPIRE was ever lost.
        pipeline.expire(key, this.windowSeconds + 1);
      }
      const results = await pipeline.exec();
      if (!results) throw new Error('Redis pipeline returned no results');
      // exec() yields [err, value] per queued command; INCRs are at even indices.
      counts = dimensions.map((_, i) => {
        const entry = results[i * 2];
        if (!entry || entry[0]) throw entry?.[0] ?? new Error('Redis INCR failed');
        return Number(entry[1]);
      });
    } catch {
      // Fail OPEN: a Redis outage must not become a total API outage. The
      // caller logs this and the `degraded` flag is what monitoring watches —
      // silently allowing traffic with no signal would be the real hazard.
      return {
        allowed: true,
        limit: dimensions[0]?.limit ?? 0,
        remaining: dimensions[0]?.limit ?? 0,
        resetAt,
        retryAfterSeconds: 0,
        degraded: true,
      };
    }

    // Report the dimension with the least headroom, so the headers describe
    // the constraint the client will actually hit next.
    let binding = { limit: Number.POSITIVE_INFINITY, remaining: Number.POSITIVE_INFINITY };
    let allowed = true;
    dimensions.forEach((dimension, i) => {
      const used = counts[i] ?? 0;
      const remaining = Math.max(0, dimension.limit - used);
      if (used > dimension.limit) allowed = false;
      if (remaining < binding.remaining) binding = { limit: dimension.limit, remaining };
    });

    return {
      allowed,
      limit: binding.limit === Number.POSITIVE_INFINITY ? 0 : binding.limit,
      remaining: binding.remaining === Number.POSITIVE_INFINITY ? 0 : binding.remaining,
      resetAt,
      retryAfterSeconds: Math.max(1, resetAt - nowSeconds),
      degraded: false,
    };
  }
}
