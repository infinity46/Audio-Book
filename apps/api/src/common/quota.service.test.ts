import { describe, expect, it, vi } from 'vitest';
import { QuotaExceededError } from '@audio-book/errors';
import { QuotaService } from './quota.service.js';

const principal = { sub: 'user-1', tenantId: 'tenant-1', roles: ['TENANT_MEMBER'], scopes: [] };

function makeService(opts: { quota?: unknown; bookCount?: number } = {}) {
  const prisma = {
    tenantQuota: { findUnique: vi.fn(() => Promise.resolve(opts.quota ?? null)) },
    book: {
      count: vi.fn((_args: { where: Record<string, unknown> }) =>
        Promise.resolve(opts.bookCount ?? 0),
      ),
    },
    tenantUsageCounter: {
      upsert: vi.fn((_args: { update: { usedValue: { increment: bigint } } }) =>
        Promise.resolve({}),
      ),
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { service: new QuotaService(prisma as never, logger as never), prisma };
}

const quota = {
  concurrentBooksLimit: 2,
  gpuMinutesMonthlyLimit: 1200,
  storageBytesLimit: BigInt(1),
  booksTotalLimit: 5,
};

describe('QuotaService — fails closed on expensive work', () => {
  it('refuses a generation start once the concurrency limit is reached', async () => {
    const { service } = makeService({ quota, bookCount: 2 });
    await expect(service.assertCanStartGeneration(principal, 'book-x')).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it('reports the refusal as non-retryable — retrying will not free capacity', async () => {
    const { service } = makeService({ quota, bookCount: 2 });
    // RATE_LIMITED means "slow down" and retrying works; QUOTA_EXCEEDED means
    // "you are out of allowance", and a client that retries it just burns
    // requests. The two must not be conflated.
    await expect(service.assertCanStartGeneration(principal, 'book-x')).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      retryable: false,
    });
  });

  it('excludes the book being started from its own concurrency count', async () => {
    const { service, prisma } = makeService({ quota, bookCount: 1 });
    await service.assertCanStartGeneration(principal, 'book-being-started');

    // Without the exclusion, re-invoking a stage on an already-GENERATING book
    // would be refused by that book's own contribution to the total.
    const args = prisma.book.count.mock.calls[0]?.[0];
    expect(args?.where.NOT).toEqual({ id: 'book-being-started' });
  });

  it('refuses book creation past the library limit', async () => {
    const { service } = makeService({ quota, bookCount: 5 });
    await expect(service.assertCanCreateBook(principal)).rejects.toBeInstanceOf(QuotaExceededError);
  });
});

describe('QuotaService — no invented commercial policy (§44)', () => {
  it('treats a tenant with no quota row as unlimited', async () => {
    const { service, prisma } = makeService({ quota: null, bookCount: 10_000 });

    await expect(service.assertCanStartGeneration(principal, 'book-x')).resolves.toBeUndefined();
    await expect(service.assertCanCreateBook(principal)).resolves.toBeUndefined();
    // Not just permitted — not even counted. An absent policy row must not
    // cause a query, let alone a default limit this code invented.
    expect(prisma.book.count).not.toHaveBeenCalled();
  });
});

describe('QuotaService.recordUsage', () => {
  it('never propagates a counter failure to the caller', async () => {
    const { service, prisma } = makeService();
    prisma.tenantUsageCounter.upsert.mockRejectedValueOnce(new Error('deadlock'));

    // The work was already admitted. Failing the user's request because a
    // billing counter could not be incremented trades an accounting
    // inaccuracy for an outage.
    await expect(service.recordUsage('tenant-1', 'GPU_MINUTES', 5)).resolves.toBeUndefined();
  });

  it('increments rather than overwrites (§7.5)', async () => {
    const { service, prisma } = makeService();
    await service.recordUsage('tenant-1', 'GPU_MINUTES', 5);

    const call = prisma.tenantUsageCounter.upsert.mock.calls[0]?.[0];
    expect(call?.update.usedValue).toEqual({ increment: BigInt(5) });
  });
});
