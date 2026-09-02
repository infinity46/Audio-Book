import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { RateLimiter } from '@audio-book/api/common/rate-limit/rate-limiter';

/**
 * Phase 7 §79: the rate limiter against real Redis (api-specification.md
 * §14.3). Exercises the counting itself rather than the HTTP wrapper, since
 * the counter is where the correctness lives — the guard around it only
 * translates a decision into headers and a 429.
 *
 * Requires Redis (see docker-compose.yml).
 */
describe('RateLimiter against real Redis', () => {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  let redis: Redis;
  const createdKeyPrefixes: string[] = [];

  /** A fresh identity per test, so tests never share a window counter. */
  function identity(): string {
    const id = `test-${randomUUID()}`;
    createdKeyPrefixes.push(id);
    return id;
  }

  beforeAll(() => {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  });

  afterAll(async () => {
    for (const prefix of createdKeyPrefixes) {
      const keys = await redis.keys(`ratelimit:*:*:${prefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
    }
    redis.disconnect();
  });

  it('allows requests up to the limit and rejects the one after it', async () => {
    const limiter = new RateLimiter(redis, 60);
    const id = identity();

    for (let i = 1; i <= 3; i += 1) {
      const decision = await limiter.consume('write', [{ kind: 'user', id, limit: 3 }]);
      expect(decision.allowed, `request ${i} of 3 should be allowed`).toBe(true);
      expect(decision.remaining).toBe(3 - i);
    }

    const rejected = await limiter.consume('write', [{ kind: 'user', id, limit: 3 }]);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    expect(rejected.resetAt * 1000).toBeGreaterThan(Date.now());
  });

  it('counts each bucket separately', async () => {
    const limiter = new RateLimiter(redis, 60);
    const id = identity();

    await limiter.consume('expensive', [{ kind: 'user', id, limit: 1 }]);
    const expensiveAgain = await limiter.consume('expensive', [{ kind: 'user', id, limit: 1 }]);
    expect(expensiveAgain.allowed).toBe(false);

    // The same identity in a different bucket is untouched.
    const read = await limiter.consume('read', [{ kind: 'user', id, limit: 1 }]);
    expect(read.allowed).toBe(true);
  });

  it('counts each dimension separately and reports the most constrained one', async () => {
    const limiter = new RateLimiter(redis, 60);
    const userId = identity();
    const tenantId = identity();

    // Exhaust the user dimension while the tenant dimension still has room.
    await limiter.consume('write', [
      { kind: 'user', id: userId, limit: 1 },
      { kind: 'tenant', id: tenantId, limit: 10 },
    ]);
    const decision = await limiter.consume('write', [
      { kind: 'user', id: userId, limit: 1 },
      { kind: 'tenant', id: tenantId, limit: 10 },
    ]);

    expect(decision.allowed).toBe(false);
    // Headers must describe the binding constraint (the user), not the roomy one.
    expect(decision.limit).toBe(1);
    expect(decision.remaining).toBe(0);
  });

  it('rejects when the tenant dimension is exhausted even if the user is fresh', async () => {
    const limiter = new RateLimiter(redis, 60);
    const tenantId = identity();

    await limiter.consume('write', [{ kind: 'tenant', id: tenantId, limit: 1 }]);
    const otherUserSameTenant = await limiter.consume('write', [
      { kind: 'user', id: identity(), limit: 100 },
      { kind: 'tenant', id: tenantId, limit: 1 },
    ]);
    expect(otherUserSameTenant.allowed).toBe(false);
  });

  it('sets a TTL so counters cannot outlive their window', async () => {
    const limiter = new RateLimiter(redis, 60);
    const id = identity();
    await limiter.consume('read', [{ kind: 'user', id, limit: 5 }]);

    const keys = await redis.keys(`ratelimit:read:user:${id}:*`);
    expect(keys).toHaveLength(1);
    const ttl = await redis.ttl(keys[0]!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(61);
  });

  it('fails OPEN when Redis is unreachable, and says so', async () => {
    // A rate limiter that fails closed turns a Redis blip into a full API
    // outage. It must allow the request AND flag itself degraded so the
    // condition is visible rather than silent.
    const deadRedis = new Redis('redis://127.0.0.1:59998', {
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    const limiter = new RateLimiter(deadRedis, 60);

    const decision = await limiter.consume('write', [{ kind: 'user', id: 'anyone', limit: 1 }]);
    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);

    deadRedis.disconnect();
  });
});
