import { describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError } from '@audio-book/errors';
import { assertIfMatch, currentPeriod, UsersService, userEtag } from './users.service.js';

const principal = { sub: 'user-1', tenantId: 'tenant-1', roles: ['TENANT_MEMBER'], scopes: [] };

function baseUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    tenantId: 'tenant-1',
    email: 'reader@example.com',
    displayName: 'Reader',
    roles: ['TENANT_MEMBER'],
    status: 'ACTIVE',
    preferences: { locale: 'en-GB', notification_email: true },
    locale: 'en-GB',
    rowVersion: 3,
    deletedAt: null,
    createdAt: new Date('2026-01-04T09:00:00Z'),
    updatedAt: new Date('2026-08-01T12:00:00Z'),
    ...overrides,
  };
}

function makeService(
  opts: {
    user?: Record<string, unknown> | null;
    quota?: unknown;
    counters?: unknown;
    sessions?: Record<string, unknown>[];
  } = {},
) {
  const user: Record<string, unknown> | null = opts.user === undefined ? baseUser() : opts.user;
  const sessions = new Map((opts.sessions ?? []).map((s) => [s.id as string, { ...s }]));

  const sessionApi = {
    findMany: vi.fn(({ where }: { where: { userId: string } }) =>
      Promise.resolve(
        [...sessions.values()]
          .filter((s) => s.userId === where.userId && s.revokedAt === null)
          .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()),
      ),
    ),
    findFirst: vi.fn(({ where }: { where: { id: string; userId: string } }) => {
      const row = sessions.get(where.id);
      return Promise.resolve(row && row.userId === where.userId ? row : null);
    }),
    update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = sessions.get(where.id);
      if (row) sessions.set(where.id, { ...row, ...data });
      return Promise.resolve(row);
    }),
  };
  const refreshTokenApi = {
    updateMany: vi.fn(() => Promise.resolve({ count: 0 })),
  };
  const tx = { session: sessionApi, refreshToken: refreshTokenApi };

  const prisma = {
    user: {
      findFirst: vi.fn(({ where }: { where: { id: string; tenantId: string } }) =>
        Promise.resolve(
          user && user.tenantId === where.tenantId && user.id === where.id ? user : null,
        ),
      ),
      update: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        const next: Record<string, unknown> = {
          ...(user ?? {}),
          ...data,
          rowVersion: ((user?.rowVersion as number | undefined) ?? 0) + 1,
        };
        if (data.preferences) next.preferences = data.preferences;
        return Promise.resolve(next);
      }),
    },
    tenantQuota: { findUnique: vi.fn(() => Promise.resolve(opts.quota ?? null)) },
    tenantUsageCounter: {
      findMany: vi.fn(() =>
        opts.counters === 'throw'
          ? Promise.reject(new Error('aggregator down'))
          : Promise.resolve(opts.counters ?? []),
      ),
    },
    session: sessionApi,
    refreshToken: refreshTokenApi,
    $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const audit = { record: vi.fn(), recordIn: vi.fn() };
  return { service: new UsersService(prisma as never, logger as never, audit as never), prisma, audit };
}

describe('optimistic concurrency (§2.8)', () => {
  it('an ETag round-trips: the value from GET satisfies If-Match on PATCH', async () => {
    const { service } = makeService();
    const { etag } = await service.getCurrentUser(principal);

    // The whole point of §75: a client that read, then wrote, must succeed.
    await expect(
      service.updateCurrentUser(principal, { display_name: 'New Name' }, etag),
    ).resolves.toBeDefined();
  });

  it('a stale If-Match is 409 RESOURCE_VERSION_CONFLICT, not a silent overwrite', async () => {
    const staleEtag = userEtag({ id: 'user-1', rowVersion: 1 });
    const { service } = makeService();

    await expect(
      service.updateCurrentUser(principal, { display_name: 'Clobber' }, staleEtag),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('an absent If-Match is last-write-wins, as the spec permits', async () => {
    const { service } = makeService();
    await expect(
      service.updateCurrentUser(principal, { display_name: 'No precondition' }, undefined),
    ).resolves.toBeDefined();
  });

  it('If-Match: * always matches', () => {
    expect(() => assertIfMatch('*', '"abc"')).not.toThrow();
  });

  it('accepts a multi-valued If-Match containing the current tag', () => {
    expect(() => assertIfMatch('"old", "abc"', '"abc"')).not.toThrow();
  });

  it('derives the ETag from row_version, so it changes only when the row does', () => {
    const a = userEtag({ id: 'user-1', rowVersion: 3 });
    const b = userEtag({ id: 'user-1', rowVersion: 3 });
    const c = userEtag({ id: 'user-1', rowVersion: 4 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('UsersService.updateCurrentUser', () => {
  it('merges preferences rather than replacing the whole object', async () => {
    const { service } = makeService();
    const { data } = await service.updateCurrentUser(principal, {
      preferences: { notification_email: false },
    });
    // A replace would silently drop `locale`, which the client never asked to
    // change — §2.9: an omitted field means "leave unchanged".
    expect(data.preferences).toEqual({ locale: 'en-GB', notification_email: false });
  });

  it('404s a principal whose user row does not exist', async () => {
    const { service } = makeService({ user: null });
    await expect(service.getCurrentUser(principal)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('UsersService.getQuotas — fails OPEN (§16.2)', () => {
  it('returns 200 with degraded:true and null usage when the aggregator is down', async () => {
    const { service } = makeService({
      counters: 'throw',
      quota: {
        concurrentBooksLimit: 3,
        gpuMinutesMonthlyLimit: 1200,
        storageBytesLimit: BigInt(214748364800),
        booksTotalLimit: 50,
      },
    });
    const result = await service.getQuotas(principal);

    expect(result.degraded).toBe(true);
    expect(result.quotas.concurrent_books?.used).toBeNull();
    // The limit is still known — it comes from a different table.
    expect(result.quotas.concurrent_books?.limit).toBe(3);
  });

  it('reports a tenant with no quota row as having no limits, not zero limits', async () => {
    const { service } = makeService({ quota: null });
    const result = await service.getQuotas(principal);

    // A `0` here would read as "you may create no books", which is the exact
    // opposite of what an absent policy row means.
    expect(result.quotas.books_total?.limit).toBeNull();
    expect(result.quotas.books_total?.used).toBe(0);
  });

  it('reports usage against the current calendar month', async () => {
    const { service } = makeService({
      counters: [{ metric: 'GPU_MINUTES', usedValue: BigInt(340) }],
      quota: {
        concurrentBooksLimit: 3,
        gpuMinutesMonthlyLimit: 1200,
        storageBytesLimit: BigInt(1),
        booksTotalLimit: 50,
      },
    });
    const result = await service.getQuotas(principal);
    const period = currentPeriod();

    expect(result.quotas.gpu_minutes_monthly?.used).toBe(340);
    expect(result.period_start).toBe(period.start.toISOString());
    expect(result.period_end).toBe(period.end.toISOString());
  });
});

describe('UsersService.listSessions / revokeSession (§16.2)', () => {
  function session(overrides: Record<string, unknown> = {}) {
    return {
      id: 'session-1',
      userId: 'user-1',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      lastSeenAt: null,
      expiresAt: new Date('2099-01-01T00:00:00Z'),
      revokedAt: null,
      userAgentFamily: 'Chrome',
      ipCountry: 'GB',
      ...overrides,
    };
  }

  it('marks the session matching currentSessionId as current', async () => {
    const { service } = makeService({ sessions: [session()] });
    const result = await service.listSessions(principal, 'session-1');
    expect(result).toEqual([
      {
        id: 'session-1',
        object: 'session',
        created_at: '2026-08-01T00:00:00.000Z',
        last_seen_at: null,
        user_agent_family: 'Chrome',
        ip_country: 'GB',
        current: true,
      },
    ]);
  });

  it('omits revoked sessions', async () => {
    const { service } = makeService({
      sessions: [session({ id: 's1' }), session({ id: 's2', revokedAt: new Date() })],
    });
    const result = await service.listSessions(principal, undefined);
    expect(result.map((s) => s.id)).toEqual(['s1']);
  });

  it('revokeSession revokes the session and its refresh tokens', async () => {
    const { service, prisma } = makeService({ sessions: [session()] });
    await service.revokeSession(principal, 'session-1');

    expect(prisma.session.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'session-1' } }),
    );
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: 'session-1', revokedAt: null } }),
    );
  });

  it('revoking another principal\'s session is a silent no-op (existence-leak rule)', async () => {
    const { service, prisma } = makeService({
      sessions: [session({ id: 'not-mine', userId: 'someone-else' })],
    });
    await expect(service.revokeSession(principal, 'not-mine')).resolves.toBeUndefined();
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('revoking an already-revoked session is idempotent', async () => {
    const { service, prisma } = makeService({
      sessions: [session({ revokedAt: new Date() })],
    });
    await expect(service.revokeSession(principal, 'session-1')).resolves.toBeUndefined();
    expect(prisma.session.update).not.toHaveBeenCalled();
  });
});
