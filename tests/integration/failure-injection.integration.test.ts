import { describe, expect, it } from 'vitest';
import { createPrismaClient, disconnectPrisma, pingDatabase } from '@audio-book/database';
import { composeReadiness } from '@audio-book/observability';
import { S3StorageProvider } from '@audio-book/storage';
import { Redis } from 'ioredis';

/**
 * Task §68 "Failure Injection": readiness must degrade predictably (503 +
 * reason_code shape, via composeReadiness) rather than crash the process or
 * hang, when a dependency is unreachable. Each check below points at a
 * definitely-unreachable endpoint (nothing listens on these ports) rather
 * than stopping a real docker-compose service, so this test has no
 * dependency on the rest of the stack being up or down.
 */
describe('Failure injection: dependency unavailability degrades predictably', () => {
  it('Postgres unavailable: pingDatabase resolves false, does not throw or hang', async () => {
    const prisma = createPrismaClient({
      databaseUrl: 'postgresql://nope:nope@localhost:59999/nope?connect_timeout=1',
    });
    await expect(pingDatabase(prisma)).resolves.toBe(false);
    await disconnectPrisma(prisma);
  }, 10_000);

  it('Redis unavailable: readiness check reports not_ready with DEPENDENCY_UNAVAILABLE, never throws', async () => {
    const redis = new Redis({
      host: 'localhost',
      port: 59998,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    // A connection failure to an unreachable host always surfaces as an
    // 'error' event even with retryStrategy disabled; without a listener
    // Node treats it as unhandled. The check below already handles the
    // rejection itself — this just keeps the expected failure from being
    // logged as if it were a crash.
    redis.on('error', () => undefined);
    const result = await composeReadiness([
      {
        name: 'redis',
        check: async () => {
          try {
            return (await redis.ping()) === 'PONG';
          } catch {
            return false;
          }
        },
      },
    ]);
    expect(result.status).toBe('not_ready');
    expect(result.reason_code).toBe('DEPENDENCY_UNAVAILABLE');
    redis.disconnect();
  }, 10_000);

  it('Object storage unavailable: readiness check reports not_ready without throwing', async () => {
    const storage = new S3StorageProvider({
      endpoint: 'http://localhost:59997',
      region: 'us-east-1',
      bucket: 'unreachable',
      accessKeyId: 'x',
      secretAccessKey: 'x',
      forcePathStyle: true,
    });
    const result = await composeReadiness([
      { name: 'storage', check: () => storage.exists('__health/sentinel') },
    ]);
    expect(result.status).toBe('not_ready');
    expect(result.reason_code).toBe('DEPENDENCY_UNAVAILABLE');
  }, 10_000);

  it('a mix of healthy and unhealthy dependencies is still reported without naming which one failed in the status', async () => {
    const result = await composeReadiness([
      { name: 'always-healthy', check: () => Promise.resolve(true) },
      { name: 'always-unhealthy', check: () => Promise.resolve(false) },
    ]);
    expect(result.status).toBe('not_ready');
    expect(result.reason_code).toBe('DEPENDENCY_UNAVAILABLE');
    // Per-dependency detail is allowed (it's what /health/dependencies exposes)
    // but the top-level status/reason_code pair must never embed a dependency name.
    expect(
      JSON.stringify({ status: result.status, reason_code: result.reason_code }),
    ).not.toContain('always-unhealthy');
  });
});
