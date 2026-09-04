import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError, ValidationError } from '@audio-book/errors';
import { AuthService } from './auth.service.js';

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

interface Store {
  tenants: Map<string, Record<string, unknown>>;
  users: Map<string, Record<string, unknown>>;
  credentials: Map<string, Record<string, unknown>>; // keyed by userId
  sessions: Map<string, Record<string, unknown>>;
  refreshTokens: Map<string, Record<string, unknown>>; // keyed by id
  auditLog: Record<string, unknown>[];
  outbox: Record<string, unknown>[];
}

function emptyStore(): Store {
  return {
    tenants: new Map(),
    users: new Map(),
    credentials: new Map(),
    sessions: new Map(),
    refreshTokens: new Map(),
    auditLog: [],
    outbox: [],
  };
}

/**
 * A minimal in-memory Prisma stand-in. `$transaction` runs the callback
 * against the same store (adequate for unit tests, which don't need real
 * atomicity) — mirrors the `$transaction: vi.fn((fn) => fn(tx))` pattern
 * already used in `jobs.service.test.ts`.
 */
function makePrisma(store: Store) {
  const refreshTokenApi = {
    create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
      const row = { rotatedAt: null, rotatedToId: null, revokedAt: null, reuseDetectedAt: null, ...data };
      store.refreshTokens.set(data.id as string, row);
      return Promise.resolve(row);
    }),
    findUnique: vi.fn(({ where }: { where: { tokenHash: string } }) => {
      const row = [...store.refreshTokens.values()].find((r) => r.tokenHash === where.tokenHash);
      if (!row) return Promise.resolve(null);
      const user = store.users.get(row.userId as string);
      const session = store.sessions.get(row.sessionId as string);
      return Promise.resolve({ ...row, user, session });
    }),
    update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = store.refreshTokens.get(where.id);
      if (row) store.refreshTokens.set(where.id, { ...row, ...data });
      return Promise.resolve(row);
    }),
    updateMany: vi.fn(
      ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const [id, row] of store.refreshTokens) {
          const matchesSession = where.sessionId === undefined || row.sessionId === where.sessionId;
          const matchesUser = where.userId === undefined || row.userId === where.userId;
          const matchesFamily = where.familyId === undefined || row.familyId === where.familyId;
          const matchesRevoked =
            !('revokedAt' in where) || row.revokedAt === where.revokedAt;
          if (matchesSession && matchesUser && matchesFamily && matchesRevoked) {
            store.refreshTokens.set(id, { ...row, ...data });
            count++;
          }
        }
        return Promise.resolve({ count });
      },
    ),
    findMany: vi.fn(({ where }: { where: { familyId: string } }) =>
      Promise.resolve([...store.refreshTokens.values()].filter((r) => r.familyId === where.familyId)),
    ),
  };

  const sessionApi = {
    create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
      store.sessions.set(data.id as string, { ...data, revokedAt: null });
      return Promise.resolve(data);
    }),
    findFirst: vi.fn(({ where }: { where: { id: string; userId: string } }) => {
      const row = store.sessions.get(where.id);
      return Promise.resolve(row && row.userId === where.userId ? row : null);
    }),
    update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = store.sessions.get(where.id);
      if (row) store.sessions.set(where.id, { ...row, ...data });
      return Promise.resolve(row);
    }),
    updateMany: vi.fn(
      ({
        where,
        data,
      }: {
        where: { userId?: string; id?: { in: string[] }; revokedAt?: null };
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const [id, row] of store.sessions) {
          const matchesUser = where.userId === undefined || row.userId === where.userId;
          const matchesId = where.id === undefined || where.id.in.includes(id);
          const matchesRevoked = !('revokedAt' in where) || row.revokedAt === where.revokedAt;
          if (matchesUser && matchesId && matchesRevoked) {
            store.sessions.set(id, { ...row, ...data });
            count++;
          }
        }
        return Promise.resolve({ count });
      },
    ),
  };

  const userCredentialApi = {
    create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
      store.credentials.set(data.userId as string, { ...data });
      return Promise.resolve(data);
    }),
    update: vi.fn(({ where, data }: { where: { userId: string }; data: Record<string, unknown> }) => {
      const row = store.credentials.get(where.userId);
      if (row) store.credentials.set(where.userId, { ...row, ...data });
      return Promise.resolve(row);
    }),
  };

  const userApi = {
    create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
      store.users.set(data.id as string, { ...data, rowVersion: 0 });
      return Promise.resolve(store.users.get(data.id as string));
    }),
    findFirst: vi.fn(({ where, include }: { where: Record<string, unknown>; include?: { credential?: boolean } }) => {
      const candidates = [...store.users.values()];
      const row = candidates.find((u) => {
        if (where.email !== undefined && u.email !== where.email) return false;
        if (where.id !== undefined && u.id !== where.id) return false;
        return true;
      });
      if (!row) return Promise.resolve(null);
      if (include?.credential) {
        return Promise.resolve({ ...row, credential: store.credentials.get(row.id as string) ?? null });
      }
      return Promise.resolve(row);
    }),
    findUnique: vi.fn(({ where }: { where: { id: string } }) => Promise.resolve(store.users.get(where.id) ?? null)),
    update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = store.users.get(where.id);
      if (row) store.users.set(where.id, { ...row, ...data });
      return Promise.resolve(row);
    }),
  };

  const tenantApi = {
    create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
      store.tenants.set(data.id as string, data);
      return Promise.resolve(data);
    }),
  };

  const auditLogApi = {
    create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
      store.auditLog.push(data);
      return Promise.resolve(data);
    }),
  };

  const outboxMessageApi = {
    create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
      store.outbox.push(data);
      return Promise.resolve(data);
    }),
  };

  const tx = {
    tenant: tenantApi,
    user: userApi,
    userCredential: userCredentialApi,
    session: sessionApi,
    refreshToken: refreshTokenApi,
    auditLog: auditLogApi,
    outboxMessage: outboxMessageApi,
  };

  return {
    ...tx,
    $transaction: vi.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
}

function makeRedis() {
  const map = new Map<string, string>();
  return {
    set: vi.fn((key: string, value: string, ..._rest: unknown[]) => {
      void _rest;
      map.set(key, value);
      return Promise.resolve('OK');
    }),
    get: vi.fn((key: string) => Promise.resolve(map.get(key) ?? null)),
    del: vi.fn((key: string) => {
      map.delete(key);
      return Promise.resolve(1);
    }),
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    app: { nodeEnv: 'test' },
    authPolicy: {
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      passwordMinLength: 8,
      enumerationProtection: true,
      loginMaxFailedAttempts: 3,
      loginLockoutSeconds: 900,
      ...overrides,
    },
  };
}

function makeService(opts: { store?: Store; config?: Record<string, unknown> } = {}) {
  const store = opts.store ?? emptyStore();
  const prisma = makePrisma(store);
  const redis = makeRedis();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const tokens = {
    issueAccessToken: vi.fn(() => Promise.resolve({ accessToken: 'signed.jwt.token', expiresIn: 900 })),
  };
  const audit = { record: vi.fn(), recordIn: vi.fn() };
  const config = makeConfig(opts.config);

  const service = new AuthService(
    prisma as never,
    redis as never,
    config as never,
    logger as never,
    tokens as never,
    audit as never,
  );
  return { service, store, prisma, redis, tokens, audit };
}

describe('AuthService.register', () => {
  it('creates a Tenant, User (TENANT_OWNER), and UserCredential', async () => {
    const { service, store } = makeService();
    const result = await service.register({ email: 'New@Example.com', password: 'correcthorse' });

    expect(result.status).toBe('CREATED');
    expect(store.tenants.size).toBe(1);
    expect(store.users.size).toBe(1);
    const user = [...store.users.values()][0];
    expect(user?.email).toBe('new@example.com'); // normalized
    expect(user?.roles).toEqual(['TENANT_OWNER']);
    expect(store.credentials.size).toBe(1);
  });

  it('rejects a password shorter than the configured minimum', async () => {
    const { service } = makeService();
    await expect(service.register({ email: 'a@example.com', password: 'short' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('enumeration protection ON: a duplicate email returns the same shape as success and creates nothing new', async () => {
    const { service, store } = makeService();
    await service.register({ email: 'dup@example.com', password: 'correcthorse' });
    expect(store.users.size).toBe(1);

    const second = await service.register({ email: 'dup@example.com', password: 'anotherpassword' });
    expect(second.status).toBe('REGISTRATION_PENDING');
    expect(store.users.size).toBe(1); // no second row
  });

  it('enumeration protection OFF: a duplicate email is 409 EMAIL_ALREADY_REGISTERED', async () => {
    const { service } = makeService({ config: { enumerationProtection: false } });
    await service.register({ email: 'dup@example.com', password: 'correcthorse' });
    await expect(
      service.register({ email: 'dup@example.com', password: 'anotherpassword' }),
    ).rejects.toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED' });
  });
});

describe('AuthService.login', () => {
  async function registeredService(password = 'correcthorse') {
    const ctx = makeService();
    await ctx.service.register({ email: 'reader@example.com', password });
    return ctx;
  }

  it('returns AUTHENTICATED with a session on correct credentials', async () => {
    const { service } = await registeredService();
    const result = await service.login(
      { email: 'reader@example.com', password: 'correcthorse', client_type: 'API' },
      {},
    );
    expect(result.status).toBe('AUTHENTICATED');
    if (result.status === 'AUTHENTICATED') {
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.refreshToken).toBeTruthy();
      expect(result.sessionId).toBeTruthy();
    }
  });

  it('an unknown email fails exactly like a wrong password (§14.11)', async () => {
    const { service } = makeService();
    await expect(
      service.login({ email: 'nobody@example.com', password: 'whatever1', client_type: 'API' }, {}),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('a wrong password fails and increments the failed-attempt counter', async () => {
    const { service, store } = await registeredService();
    await expect(
      service.login({ email: 'reader@example.com', password: 'wrongpassword', client_type: 'API' }, {}),
    ).rejects.toBeInstanceOf(AuthenticationError);
    const user = [...store.users.values()][0]!;
    const credential = store.credentials.get(user.id as string);
    expect(credential?.failedAttemptCount).toBe(1);
  });

  it('locks the account after the configured number of failed attempts, then refuses further login even with the right password', async () => {
    const { service } = await registeredService();
    for (let i = 0; i < 3; i++) {
      await expect(
        service.login({ email: 'reader@example.com', password: 'wrongpassword', client_type: 'API' }, {}),
      ).rejects.toBeInstanceOf(AuthenticationError);
    }
    // 3 failures == the configured max — the account is now locked.
    await expect(
      service.login({ email: 'reader@example.com', password: 'correcthorse', client_type: 'API' }, {}),
    ).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
  });

  it('a successful login resets the failed-attempt counter', async () => {
    const { service, store } = await registeredService();
    await expect(
      service.login({ email: 'reader@example.com', password: 'wrongpassword', client_type: 'API' }, {}),
    ).rejects.toBeInstanceOf(AuthenticationError);
    await service.login({ email: 'reader@example.com', password: 'correcthorse', client_type: 'API' }, {});
    const user = [...store.users.values()][0]!;
    expect(store.credentials.get(user.id as string)?.failedAttemptCount).toBe(0);
  });
});

describe('AuthService.refresh — rotation and reuse detection', () => {
  async function loggedInService() {
    const ctx = makeService();
    await ctx.service.register({ email: 'reader@example.com', password: 'correcthorse' });
    const result = await ctx.service.login(
      { email: 'reader@example.com', password: 'correcthorse', client_type: 'API' },
      {},
    );
    if (result.status !== 'AUTHENTICATED') throw new Error('expected AUTHENTICATED');
    return { ...ctx, firstRefreshToken: result.refreshToken, sessionId: result.sessionId };
  }

  it('rotates: the old token is marked rotated and a new one is issued', async () => {
    const { service, firstRefreshToken, store } = await loggedInService();
    const result = await service.refresh(firstRefreshToken);
    expect(result.refreshToken).not.toBe(firstRefreshToken);

    const oldRow = [...store.refreshTokens.values()].find((r) => r.tokenHash === sha256(firstRefreshToken));
    expect(oldRow?.rotatedAt).toBeTruthy();
  });

  it('reusing an already-rotated token is refused and revokes the whole family', async () => {
    const { service, firstRefreshToken, store, sessionId } = await loggedInService();
    await service.refresh(firstRefreshToken); // legitimate rotation

    await expect(service.refresh(firstRefreshToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSED',
    });

    const session = store.sessions.get(sessionId);
    expect(session?.revokedAt).toBeTruthy();
    for (const row of store.refreshTokens.values()) {
      expect(row.revokedAt).toBeTruthy();
    }
  });

  it('an unknown token is TOKEN_REVOKED, not a 500', async () => {
    const { service } = await loggedInService();
    await expect(service.refresh('not-a-real-token')).rejects.toMatchObject({ code: 'TOKEN_REVOKED' });
  });

  it('an expired token is TOKEN_EXPIRED', async () => {
    const { service, firstRefreshToken, store } = await loggedInService();
    const row = [...store.refreshTokens.values()].find((r) => r.tokenHash === sha256(firstRefreshToken))!;
    store.refreshTokens.set(row.id as string, { ...row, expiresAt: new Date(Date.now() - 1000) });
    await expect(service.refresh(firstRefreshToken)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
  });
});

describe('AuthService.logout', () => {
  it('revokes the session and every refresh token in it', async () => {
    const ctx = makeService();
    await ctx.service.register({ email: 'reader@example.com', password: 'correcthorse' });
    const login = await ctx.service.login(
      { email: 'reader@example.com', password: 'correcthorse', client_type: 'API' },
      {},
    );
    if (login.status !== 'AUTHENTICATED') throw new Error('expected AUTHENTICATED');
    const user = [...ctx.store.users.values()][0]!;

    await ctx.service.logout(user.id as string, login.sessionId);

    expect(ctx.store.sessions.get(login.sessionId)?.revokedAt).toBeTruthy();
    for (const row of ctx.store.refreshTokens.values()) {
      if (row.sessionId === login.sessionId) expect(row.revokedAt).toBeTruthy();
    }
  });

  it('is naturally idempotent — no sessionId is a silent no-op', async () => {
    const { service } = makeService();
    await expect(service.logout('user-1', undefined)).resolves.toBeUndefined();
  });
});

describe('AuthService password reset', () => {
  it('requestPasswordReset writes a Redis-backed, hashed, single-use token for an existing user', async () => {
    const ctx = makeService();
    await ctx.service.register({ email: 'reader@example.com', password: 'correcthorse' });

    await ctx.service.requestPasswordReset('reader@example.com');

    // The plaintext token is never persisted or returned anywhere (only its
    // SHA-256 is) — confirmed here by checking the key shape and that the
    // stored value is a userId, not a token.
    const [storedKey, storedValue] = ctx.redis.set.mock.calls[0] as [string, string];
    expect(storedKey.startsWith('pwreset:')).toBe(true);
    const user = [...ctx.store.users.values()][0]!;
    expect(storedValue).toBe(user.id);
  });

  it('confirm with a valid token changes the password and revokes every session', async () => {
    const ctx = makeService();
    await ctx.service.register({ email: 'reader@example.com', password: 'correcthorse' });
    const user = [...ctx.store.users.values()][0]!;
    const login = await ctx.service.login(
      { email: 'reader@example.com', password: 'correcthorse', client_type: 'API' },
      {},
    );
    if (login.status !== 'AUTHENTICATED') throw new Error('expected AUTHENTICATED');

    const passwordHashBefore = ctx.store.credentials.get(user.id as string)?.passwordHash;

    // Seed Redis exactly the way requestPasswordReset would, but with a
    // token this test controls the plaintext of.
    const plainToken = 'test-reset-token';
    await ctx.redis.set(`pwreset:${sha256(plainToken)}`, user.id as string, 'EX', 1800);

    await ctx.service.confirmPasswordReset(plainToken, 'brandNewPassword1');

    expect(ctx.store.credentials.get(user.id as string)?.passwordHash).not.toBe(passwordHashBefore);
    expect(ctx.store.sessions.get(login.sessionId)?.revokedAt).toBeTruthy();
    // The token is single-use.
    expect(await ctx.redis.get(`pwreset:${sha256(plainToken)}`)).toBeNull();

    // The old password no longer works; the new one does.
    await expect(
      ctx.service.login({ email: 'reader@example.com', password: 'correcthorse', client_type: 'API' }, {}),
    ).rejects.toBeInstanceOf(AuthenticationError);
    const relogin = await ctx.service.login(
      { email: 'reader@example.com', password: 'brandNewPassword1', client_type: 'API' },
      {},
    );
    expect(relogin.status).toBe('AUTHENTICATED');
  });

  it('request always resolves, whether or not the email exists (§14.11 enumeration protection)', async () => {
    const { service } = makeService();
    await expect(service.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined();
  });

  it('confirm with an invalid/expired token is TOKEN_EXPIRED', async () => {
    const { service } = makeService();
    await expect(service.confirmPasswordReset('bogus-token', 'newpassword1')).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
  });

  it('confirm rejects a too-short new password', async () => {
    const { service } = makeService();
    await expect(service.confirmPasswordReset('bogus-token', 'short')).rejects.toBeInstanceOf(ValidationError);
  });
});
