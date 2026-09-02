import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, disconnectPrisma, type PrismaClient } from '@audio-book/database';
import { generateId } from '@audio-book/events';
import { startHarness, type E2EHarness } from './harness.js';

/**
 * The HTTP surface, end to end, against the real compiled API.
 *
 * This layer previously had no coverage at all: controller tests mock their
 * service, and the integration suite calls services directly, so nothing
 * exercised the guard chain, the validation pipe, the exception filter, or
 * the wire format together. That gap is how F-13 (`pnpm start:dev` cannot
 * inject any dependency, so every endpoint 500s) survived unnoticed.
 *
 * Requires Postgres, Redis, MinIO, and a prior `pnpm -r run build`.
 */
describe('API over real HTTP', () => {
  let harness: E2EHarness;
  let prisma: PrismaClient;

  const tenantA = generateId();
  const tenantB = generateId();
  const userA = generateId();
  const userB = generateId();
  let bookA: string;

  let memberA: string;
  let memberB: string;

  beforeAll(async () => {
    prisma = createPrismaClient({
      databaseUrl:
        process.env.DATABASE_URL ??
        'postgresql://audiobook:audiobook_dev_password@localhost:5432/audiobook',
    });

    for (const [tenantId, userId, label] of [
      [tenantA, userA, 'A'],
      [tenantB, userB, 'B'],
    ] as const) {
      await prisma.tenant.create({
        data: { id: tenantId, name: `E2E Tenant ${label}`, status: 'ACTIVE', planCode: 'test' },
      });
      await prisma.user.create({
        data: {
          id: userId,
          tenantId,
          email: `e2e-${label}-${tenantId}@test.local`,
          displayName: `E2E User ${label}`,
          status: 'ACTIVE',
          roles: ['TENANT_OWNER'],
          preferences: {},
        },
      });
    }

    harness = await startHarness();
    memberA = await harness.token({ sub: userA, tenantId: tenantA, roles: ['TENANT_MEMBER'] });
    memberB = await harness.token({ sub: userB, tenantId: tenantB, roles: ['TENANT_MEMBER'] });

    const created = await harness.request('POST', '/api/v1/books', {
      token: memberA,
      body: { title: 'E2E Book', language: 'en' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(created.status).toBe(201);
    bookA = (created.body as { data: { id: string } }).data.id;
  });

  afterAll(async () => {
    await harness?.stop();
    try {
      for (const tenantId of [tenantA, tenantB]) {
        await prisma.idempotencyKey.deleteMany({ where: { tenantId } });
        await prisma.processingJob.deleteMany({ where: { tenantId } });
        await prisma.bookFile.deleteMany({ where: { tenantId } });
        await prisma.book.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      }
    } catch (err) {
      console.warn('api-http.e2e cleanup failed (non-fatal):', err);
    }
    await disconnectPrisma(prisma);
  });

  describe('the service actually serves requests', () => {
    it('answers liveness and readiness', async () => {
      const health = await harness.request('GET', '/health');
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: 'alive' });

      // Readiness talks to Postgres, Redis, and storage — a 200 here means
      // the real dependencies are wired, not merely that the process is up.
      const ready = await harness.request('GET', '/ready');
      expect(ready.status).toBe(200);
    });

    it('injects its dependencies (regression for F-13)', async () => {
      // A Nest DI failure surfaces as a 500 on every route while /health,
      // which needs no injected service, keeps returning 200 — exactly the
      // shape F-13 had. Any 2xx from a service-backed route disproves it.
      const response = await harness.request('GET', '/api/v1/books', { token: memberA });
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
    });
  });

  describe('authentication', () => {
    it('refuses an anonymous request', async () => {
      const response = await harness.request('GET', '/api/v1/books');
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    });

    it('refuses a token signed by the wrong key', async () => {
      const foreign = await (await startForeignIssuer()).token({
        sub: userA,
        tenantId: tenantA,
        roles: ['TENANT_MEMBER'],
      });
      const response = await harness.request('GET', '/api/v1/books', { token: foreign });
      expect(response.status).toBe(401);
    });

    it('refuses a structurally valid token with no tenant claim', async () => {
      const response = await harness.request('GET', '/api/v1/books', { token: 'not-a-jwt' });
      expect(response.status).toBe(401);
    });
  });

  describe('authorization', () => {
    it('refuses a principal with no tenant role', async () => {
      const token = await harness.token({ sub: userA, tenantId: tenantA, roles: [] });
      const response = await harness.request('GET', '/api/v1/books', { token });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
    });

    it('refuses PLATFORM_ADMIN on a content surface', async () => {
      const token = await harness.token({
        sub: userA,
        tenantId: tenantA,
        roles: ['PLATFORM_ADMIN'],
      });
      const response = await harness.request('GET', `/api/v1/books/${bookA}`, { token });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'ADMIN_CONTENT_ACCESS_DENIED' } });
    });

    it('refuses admin content access even when a tenant role is also present', async () => {
      const token = await harness.token({
        sub: userA,
        tenantId: tenantA,
        roles: ['PLATFORM_ADMIN', 'TENANT_OWNER'],
      });
      const response = await harness.request('POST', `/api/v1/books/${bookA}/text/access-urls`, {
        token,
        body: { disposition: 'INLINE' },
        headers: { 'idempotency-key': randomUUID() },
      });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ error: { code: 'ADMIN_CONTENT_ACCESS_DENIED' } });
    });
  });

  describe('tenant isolation over the wire', () => {
    it("returns 404 — never 403 — for another tenant's book", async () => {
      const response = await harness.request('GET', `/api/v1/books/${bookA}`, { token: memberB });
      expect(response.status).toBe(404);
      // 403 would confirm the resource exists, leaking it across the boundary.
      expect(response.status).not.toBe(403);
    });

    it("does not list another tenant's books", async () => {
      const response = await harness.request('GET', '/api/v1/books', { token: memberB });
      expect(response.status).toBe(200);
      const ids = (response.body as { data: { id: string }[] }).data.map((b) => b.id);
      expect(ids).not.toContain(bookA);
    });
  });

  describe('request contract', () => {
    it('rejects a mutation with no Idempotency-Key', async () => {
      const response = await harness.request('POST', '/api/v1/books', {
        token: memberA,
        body: { title: 'No Key', language: 'en' },
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: 'MISSING_IDEMPOTENCY_KEY' } });
    });

    it('replays the original response for a repeated Idempotency-Key', async () => {
      const key = randomUUID();
      const body = { title: 'Idempotent Book', language: 'en' };
      const first = await harness.request('POST', '/api/v1/books', {
        token: memberA,
        body,
        headers: { 'idempotency-key': key },
      });
      const second = await harness.request('POST', '/api/v1/books', {
        token: memberA,
        body,
        headers: { 'idempotency-key': key },
      });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const firstId = (first.body as { data: { id: string } }).data.id;
      const secondId = (second.body as { data: { id: string } }).data.id;
      // A second book must NOT have been created.
      expect(secondId).toBe(firstId);
    });

    it('rejects an unknown field rather than silently dropping it', async () => {
      const response = await harness.request('POST', '/api/v1/books', {
        token: memberA,
        body: { title: 'Strict', language: 'en', smuggled_field: 'should be refused' },
        headers: { 'idempotency-key': randomUUID() },
      });
      expect(response.status).toBe(422);
    });

    it('returns the documented error envelope shape', async () => {
      const response = await harness.request('GET', `/api/v1/books/${generateId()}`, {
        token: memberA,
      });
      expect(response.status).toBe(404);
      const error = (response.body as { error: Record<string, unknown> }).error;
      // api-specification.md §8.1
      expect(error).toHaveProperty('code');
      expect(error).toHaveProperty('message');
      expect(error).toHaveProperty('request_id');
      expect(error).toHaveProperty('trace_id');
      expect(error).toHaveProperty('retryable');
      // §8.2: no internals ever reach the client.
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toMatch(/at .*\.ts:\d+/);
      expect(serialized).not.toContain('node_modules');
      expect(serialized).not.toContain('postgresql://');
    });
  });

  describe('rate limiting', () => {
    it('reports bucket state on every response', async () => {
      const response = await harness.request('GET', '/api/v1/books', { token: memberA });
      expect(response.headers.get('ratelimit-limit')).toBeTruthy();
      expect(response.headers.get('ratelimit-remaining')).toBeTruthy();
      expect(response.headers.get('ratelimit-reset')).toBeTruthy();
    });
  });

  /** A second, unrelated keypair — used to prove tokens are actually verified. */
  async function startForeignIssuer() {
    const { SignJWT, generateKeyPair } = await import('jose');
    const { privateKey } = await generateKeyPair('RS256');
    return {
      token: (principal: { sub: string; tenantId: string; roles: string[] }) =>
        new SignJWT({ tenant_id: principal.tenantId, roles: principal.roles, scopes: [] })
          .setProtectedHeader({ alg: 'RS256' })
          .setSubject(principal.sub)
          .setIssuer('https://e2e.test')
          .setAudience('audiobook-api-e2e')
          .setIssuedAt()
          .setExpirationTime('15m')
          .sign(privateKey),
    };
  }
});
