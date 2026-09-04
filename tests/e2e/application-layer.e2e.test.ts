import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, disconnectPrisma, type PrismaClient } from '@audio-book/database';
import { generateId } from '@audio-book/events';
import { startHarness, type E2EHarness } from './harness.js';

/**
 * The Phase 8 application layer over real HTTP, against the real compiled API,
 * a real Postgres, and a real Redis.
 *
 * What this suite is for: the endpoints Phase 8 adds are the ones a frontend
 * will live on, and almost every property that matters about them — a 404
 * rather than a 403 across tenants, an ETag that actually round-trips, a
 * cancellation that does not claim work stopped — is invisible to a unit test
 * with a mocked Prisma. These run through the whole stack: guard chain,
 * validation pipe, exception filter, wire format.
 */
describe('Phase 8 application layer', () => {
  let harness: E2EHarness;
  let prisma: PrismaClient;

  const tenantA = generateId();
  const tenantB = generateId();
  const userA = generateId();
  const userB = generateId();
  const adminUser = generateId();

  let memberA: string;
  let memberB: string;
  let admin: string;
  let bookA: string;
  let bookB: string;

  const cleanupJobIds: string[] = [];

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
        data: { id: tenantId, name: `P8 Tenant ${label}`, status: 'ACTIVE', planCode: 'test' },
      });
      await prisma.user.create({
        data: {
          id: userId,
          tenantId,
          email: `p8-${label}-${tenantId}@test.local`,
          displayName: `P8 User ${label}`,
          status: 'ACTIVE',
          roles: ['TENANT_OWNER'],
          preferences: { locale: 'en-GB' },
        },
      });
    }
    // The admin lives in tenant A's row space but holds only PLATFORM_ADMIN,
    // which is what makes the §6.6 boundary testable: same database, no
    // content access.
    await prisma.user.create({
      data: {
        id: adminUser,
        tenantId: tenantA,
        email: `p8-admin-${tenantA}@test.local`,
        displayName: 'P8 Admin',
        status: 'ACTIVE',
        roles: ['PLATFORM_ADMIN'],
        preferences: {},
      },
    });

    harness = await startHarness();
    memberA = await harness.token({ sub: userA, tenantId: tenantA, roles: ['TENANT_MEMBER'] });
    memberB = await harness.token({ sub: userB, tenantId: tenantB, roles: ['TENANT_MEMBER'] });
    admin = await harness.token({ sub: adminUser, tenantId: tenantA, roles: ['PLATFORM_ADMIN'] });

    bookA = await createBook(memberA, 'Tenant A Book');
    bookB = await createBook(memberB, 'Tenant B Book');
  });

  afterAll(async () => {
    await harness?.stop();
    try {
      // Best-effort: this environment's Postgres has `vector` registered in
      // `pg_extension` but its shared library missing from `$libdir`, so any
      // statement whose plan touches a vector column fails with 58P01. That is
      // an infrastructure fault (the same class as QA finding F-8), not a
      // product one, and it must not turn a green suite red at teardown.
      for (const tenantId of [tenantA, tenantB]) {
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.outboxMessage.deleteMany({ where: { tenantId } });
        await prisma.idempotencyKey.deleteMany({ where: { tenantId } });
        await prisma.processingJob.deleteMany({ where: { tenantId } });
        await prisma.tenantUsageCounter.deleteMany({ where: { tenantId } });
        await prisma.tenantQuota.deleteMany({ where: { tenantId } });
        await prisma.book.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      }
    } catch (err) {
      console.warn(`[e2e] cleanup incomplete: ${String(err)}`);
    } finally {
      await disconnectPrisma(prisma);
    }
  });

  async function createBook(token: string, title: string): Promise<string> {
    const created = await harness.request('POST', '/api/v1/books', {
      token,
      body: { title, language: 'en' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(created.status).toBe(201);
    return (created.body as { data: { id: string } }).data.id;
  }

  /** Seeds a job row directly: creating one through the API needs the whole pipeline. */
  async function seedJob(
    tenantId: string,
    bookId: string | null,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const id = generateId();
    cleanupJobIds.push(id);
    await prisma.processingJob.create({
      data: {
        id,
        tenantId,
        bookId,
        type: 'generate_tts_chunk',
        queue: 'gpu',
        priority: 'NORMAL',
        relatedResourceType: 'audio_script_chunk',
        relatedResourceId: generateId(),
        status: 'QUEUED',
        statusChangedAt: new Date(),
        maxAttempts: 3,
        idempotencyKey: `p8-test:${id}`,
        idempotencyFingerprint: 'f'.repeat(64),
        correlationId: generateId(),
        ...overrides,
      },
    });
    return id;
  }

  // ------------------------------------------------------------ §100 auth ----

  describe('authentication (§100)', () => {
    const protectedRoutes = [
      ['GET', '/api/v1/jobs'],
      ['GET', '/api/v1/users/me'],
      ['GET', '/api/v1/users/me/quotas'],
      ['GET', '/api/v1/capabilities'],
      ['GET', '/api/v1/model-versions'],
      ['GET', '/api/v1/admin/tenants'],
    ] as const;

    it.each(protectedRoutes)('%s %s rejects an unauthenticated request', async (method, path) => {
      const res = await harness.request(method, path);
      expect(res.status).toBe(401);
      expect((res.body as { error: { code: string } }).error.code).toBeTruthy();
    });

    it('rejects a token this API did not issue', async () => {
      const res = await harness.request('GET', '/api/v1/users/me', {
        headers: { authorization: 'Bearer not.a.real.token' },
      });
      expect(res.status).toBe(401);
    });
  });

  // ----------------------------------------------- §101/§102 authorization ----

  describe('tenant isolation and IDOR (§101, §102, §42)', () => {
    it("hides another tenant's book behind a 404, not a 403", async () => {
      const res = await harness.request('GET', `/api/v1/books/${bookB}`, { token: memberA });
      // §6.4: a 403 would confirm the book exists for a tenant the caller
      // cannot see into.
      expect(res.status).toBe(404);
    });

    it.each([
      ['progress', (id: string) => `/api/v1/books/${id}/progress`],
      ['files', (id: string) => `/api/v1/books/${id}/files`],
    ])("hides another tenant's %s behind a 404", async (_label, path) => {
      const res = await harness.request('GET', path(bookB), { token: memberA });
      expect(res.status).toBe(404);
    });

    it("hides another tenant's job behind a 404 on read and on cancel", async () => {
      const jobB = await seedJob(tenantB, bookB);

      const read = await harness.request('GET', `/api/v1/jobs/${jobB}`, { token: memberA });
      expect(read.status).toBe(404);

      const cancel = await harness.request('POST', `/api/v1/jobs/${jobB}/cancellation`, {
        token: memberA,
        body: {},
      });
      expect(cancel.status).toBe(404);

      // And the job is genuinely untouched — a 404 that still cancelled would
      // be the worst of both worlds.
      const row = await prisma.processingJob.findUnique({ where: { id: jobB } });
      expect(row?.status).toBe('QUEUED');
      expect(row?.cancellationRequested).toBe(false);
    });

    it("never lists another tenant's jobs, even filtered by their book id", async () => {
      await seedJob(tenantB, bookB);
      const res = await harness.request('GET', `/api/v1/jobs?book_id=${bookB}`, {
        token: memberA,
      });
      expect(res.status).toBe(200);
      expect((res.body as { data: unknown[] }).data).toEqual([]);
    });

    it("refuses to update or delete another tenant's book", async () => {
      const patch = await harness.request('PATCH', `/api/v1/books/${bookB}`, {
        token: memberA,
        body: { title: 'Hijacked' },
      });
      expect(patch.status).toBe(404);

      const del = await harness.request('DELETE', `/api/v1/books/${bookB}`, { token: memberA });
      expect(del.status).toBe(404);

      const still = await prisma.book.findUnique({ where: { id: bookB } });
      expect(still?.title).toBe('Tenant B Book');
      expect(still?.deletedAt).toBeNull();
    });
  });

  // ------------------------------------------------- §135 no escalation -----

  describe('privilege separation (§133, §134, §135)', () => {
    it('refuses an ordinary tenant user on every admin endpoint', async () => {
      const adminRoutes = [
        ['GET', '/api/v1/admin/tenants'],
        ['GET', '/api/v1/admin/users'],
        ['GET', '/api/v1/admin/jobs'],
        ['GET', '/api/v1/admin/dead-letters'],
        ['GET', '/api/v1/admin/workers'],
        ['GET', '/api/v1/admin/model-versions'],
      ] as const;

      for (const [method, path] of adminRoutes) {
        const res = await harness.request(method, path, { token: memberA });
        expect({ path, status: res.status }).toEqual({ path, status: 403 });
      }
    });

    it('refuses a PLATFORM_ADMIN on tenant content surfaces (§6.6)', async () => {
      const res = await harness.request('GET', `/api/v1/books/${bookA}`, { token: admin });
      expect(res.status).toBe(403);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        'ADMIN_CONTENT_ACCESS_DENIED',
      );
    });

    it('admits a PLATFORM_ADMIN on the admin surface, and returns counts not titles', async () => {
      const res = await harness.request('GET', `/api/v1/admin/tenants/${tenantA}`, {
        token: admin,
      });
      expect(res.status).toBe(200);
      const body = res.body as { data: { counts: { books: number } } };
      expect(body.data.counts.books).toBeGreaterThanOrEqual(1);
      // §16.22: "book titles are not returned".
      expect(JSON.stringify(res.body)).not.toContain('Tenant A Book');
    });

    it('records an audit row for the admin cross-tenant read', async () => {
      await harness.request('GET', '/api/v1/admin/tenants', { token: admin });
      const rows = await prisma.auditLog.findMany({
        where: { actorUserId: adminUser, action: 'ADMIN_CROSS_TENANT_READ' },
      });
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------- §106 cancellation --

  describe('cancellation (§33, §34, §106)', () => {
    it('cancels a QUEUED job immediately and reports it as effective', async () => {
      const jobId = await seedJob(tenantA, bookA, { status: 'QUEUED' });
      const res = await harness.request('POST', `/api/v1/jobs/${jobId}/cancellation`, {
        token: memberA,
        body: { reason: 'Changed my mind.' },
      });

      expect(res.status).toBe(200);
      const job = (res.body as { data: { status: string; cancellation: { effective: boolean } } })
        .data;
      expect(job.status).toBe('CANCELLED');
      expect(job.cancellation.effective).toBe(true);
    });

    it('does not claim a RUNNING job stopped', async () => {
      const jobId = await seedJob(tenantA, bookA, { status: 'RUNNING', startedAt: new Date() });
      const res = await harness.request('POST', `/api/v1/jobs/${jobId}/cancellation`, {
        token: memberA,
        body: {},
      });

      const job = (
        res.body as {
          data: { status: string; cancellation: { requested: boolean; effective: boolean } };
        }
      ).data;
      expect(job.status).toBe('RUNNING');
      expect(job.cancellation.requested).toBe(true);
      expect(job.cancellation.effective).toBe(false);
    });

    it('is a 200 no-op on an already-succeeded job, never a 409 (§71 exception)', async () => {
      const jobId = await seedJob(tenantA, bookA, {
        status: 'SUCCEEDED',
        completedAt: new Date(),
      });
      const res = await harness.request('POST', `/api/v1/jobs/${jobId}/cancellation`, {
        token: memberA,
        body: {},
      });

      expect(res.status).toBe(200);
      expect((res.body as { data: { status: string } }).data.status).toBe('SUCCEEDED');
    });

    it('is idempotent across repeated calls', async () => {
      const jobId = await seedJob(tenantA, bookA, { status: 'QUEUED' });
      const first = await harness.request('POST', `/api/v1/jobs/${jobId}/cancellation`, {
        token: memberA,
        body: {},
      });
      const second = await harness.request('POST', `/api/v1/jobs/${jobId}/cancellation`, {
        token: memberA,
        body: {},
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const a = (first.body as { data: { cancellation: { requested_at: string } } }).data;
      const b = (second.body as { data: { cancellation: { requested_at: string } } }).data;
      // §29.2: "original `requested_at` preserved".
      expect(b.cancellation.requested_at).toBe(a.cancellation.requested_at);
    });

    it('cascades a coordinator cancellation to its children', async () => {
      const parent = await seedJob(tenantA, bookA, { status: 'RUNNING' });
      const child = await seedJob(tenantA, bookA, { status: 'QUEUED', parentJobId: parent });

      await harness.request('POST', `/api/v1/jobs/${parent}/cancellation`, {
        token: memberA,
        body: {},
      });

      const childRow = await prisma.processingJob.findUnique({ where: { id: child } });
      expect(childRow?.status).toBe('CANCELLED');
    });

    it('writes a job.cancelled outbox row so the change is observable', async () => {
      const jobId = await seedJob(tenantA, bookA, { status: 'QUEUED' });
      await harness.request('POST', `/api/v1/jobs/${jobId}/cancellation`, {
        token: memberA,
        body: {},
      });

      const events = await prisma.outboxMessage.findMany({
        where: { jobId, eventType: 'job.cancelled' },
      });
      expect(events).toHaveLength(1);
    });

    it('records an audit row naming the actor', async () => {
      const jobId = await seedJob(tenantA, bookA, { status: 'QUEUED' });
      await harness.request('POST', `/api/v1/jobs/${jobId}/cancellation`, {
        token: memberA,
        body: {},
      });

      const rows = await prisma.auditLog.findMany({
        where: { action: 'JOB_CANCELLED', resourceId: jobId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actorUserId).toBe(userA);
      // §14.11 / §121: the user-authored reason is stored, never echoed into
      // metadata that a log aggregator will index.
      expect(JSON.stringify(rows[0]?.metadata)).not.toContain('Changed my mind');
    });

    it('rejects an over-long cancellation reason at the validation pipe', async () => {
      const jobId = await seedJob(tenantA, bookA);
      const res = await harness.request('POST', `/api/v1/jobs/${jobId}/cancellation`, {
        token: memberA,
        body: { reason: 'x'.repeat(600) },
      });
      expect(res.status).toBe(422);
    });

    it('rejects an unknown field rather than ignoring it (§2.9 strict mode)', async () => {
      const jobId = await seedJob(tenantA, bookA);
      const res = await harness.request('POST', `/api/v1/jobs/${jobId}/cancellation`, {
        token: memberA,
        body: { reason: 'ok', force_kill: true },
      });
      expect(res.status).toBe(422);
      const details = (res.body as { error: { details: { issue: string }[] } }).error.details;
      expect(details.some((d) => d.issue === 'unknown_field')).toBe(true);
    });
  });

  // --------------------------------------------------------------- progress --

  describe('progress (§9-§13)', () => {
    it('reports a book with no work as UNKNOWN, not 0%', async () => {
      const res = await harness.request('GET', `/api/v1/books/${bookA}/progress`, {
        token: memberA,
      });
      expect(res.status).toBe(200);

      const data = (
        res.body as {
          data: {
            overall_progress: number | null;
            stages: { stage: string; progress: number | null; total_units: number | null }[];
            estimate: { confidence: string; remaining_ms: number | null };
          };
        }
      ).data;

      expect(data.overall_progress).toBeNull();
      expect(data.stages).toHaveLength(5);
      for (const stage of data.stages) {
        expect(stage.total_units).toBeNull();
        expect(stage.progress).toBeNull();
      }
      // §16.19: "a fabricated ETA is a contract violation."
      expect(data.estimate.confidence).toBe('NONE');
      expect(data.estimate.remaining_ms).toBeNull();
    });

    it('exposes the five stage names of §20.5 and nothing else', async () => {
      const res = await harness.request('GET', `/api/v1/books/${bookA}/progress`, {
        token: memberA,
      });
      const stages = (res.body as { data: { stages: { stage: string }[] } }).data.stages.map(
        (s) => s.stage,
      );
      expect(stages).toEqual(['ingestion', 'analysis', 'director', 'tts', 'assembly']);
    });

    it('surfaces an active job id once one exists', async () => {
      const jobId = await seedJob(tenantA, bookA, { status: 'RUNNING', startedAt: new Date() });
      const res = await harness.request('GET', `/api/v1/books/${bookA}/progress`, {
        token: memberA,
      });
      const data = (res.body as { data: { active_job_ids: string[] } }).data;
      expect(data.active_job_ids).toContain(jobId);
    });

    it('embeds the same stage summary under GET /books/{id}?include=stages', async () => {
      const res = await harness.request('GET', `/api/v1/books/${bookA}?include=stages`, {
        token: memberA,
      });
      expect(res.status).toBe(200);
      const stages = (res.body as { data: { stages: Record<string, unknown> } }).data.stages;
      expect(Object.keys(stages).sort()).toEqual([
        'analysis',
        'assembly',
        'director',
        'ingestion',
        'tts',
      ]);
    });

    it('rejects an unrecognised include value instead of silently ignoring it', async () => {
      const res = await harness.request('GET', `/api/v1/books/${bookA}?include=everything`, {
        token: memberA,
      });
      expect(res.status).toBe(422);
    });
  });

  // ------------------------------------------------- optimistic concurrency --

  describe('optimistic concurrency (§74, §75, §110, §112)', () => {
    it('round-trips an ETag from GET into a successful If-Match PATCH', async () => {
      const read = await harness.request('GET', `/api/v1/books/${bookA}`, { token: memberA });
      const etag = read.headers.get('etag');
      expect(etag).toBeTruthy();

      const patch = await harness.request('PATCH', `/api/v1/books/${bookA}`, {
        token: memberA,
        body: { description: 'Updated by the first session.' },
        headers: { 'if-match': etag! },
      });
      expect(patch.status).toBe(200);
    });

    it('rejects a stale writer with 409 RESOURCE_VERSION_CONFLICT', async () => {
      const read = await harness.request('GET', `/api/v1/books/${bookA}`, { token: memberA });
      const staleEtag = read.headers.get('etag')!;

      // A second session writes first.
      const winner = await harness.request('PATCH', `/api/v1/books/${bookA}`, {
        token: memberA,
        body: { description: 'Session two wins.' },
        headers: { 'if-match': staleEtag },
      });
      expect(winner.status).toBe(200);

      // The first session now holds a stale tag.
      const loser = await harness.request('PATCH', `/api/v1/books/${bookA}`, {
        token: memberA,
        body: { description: 'Session one clobbers.' },
        headers: { 'if-match': staleEtag },
      });
      expect(loser.status).toBe(409);
      expect((loser.body as { error: { code: string } }).error.code).toBe(
        'RESOURCE_VERSION_CONFLICT',
      );

      const row = await prisma.book.findUnique({ where: { id: bookA } });
      expect(row?.description).toBe('Session two wins.');
    });

    it('refuses to patch pipeline status through the metadata endpoint', async () => {
      const res = await harness.request('PATCH', `/api/v1/books/${bookA}`, {
        token: memberA,
        body: { status: 'COMPLETED' },
      });
      // `status` is absent from the schema, so this is an unknown field —
      // pipeline state changes because work happened, never because a client
      // asked.
      expect(res.status).toBe(422);
    });
  });

  // ------------------------------------------------------------ idempotency --

  describe('idempotency (§18, §19, §98, §111)', () => {
    it('returns the same book for a repeated Idempotency-Key, not a second one', async () => {
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
      expect(secondId).toBe(firstId);

      const count = await prisma.book.count({
        where: { tenantId: tenantA, title: 'Idempotent Book' },
      });
      expect(count).toBe(1);
    });

    it('rejects the same key with a different body as a conflict', async () => {
      const key = randomUUID();
      await harness.request('POST', '/api/v1/books', {
        token: memberA,
        body: { title: 'First Intent', language: 'en' },
        headers: { 'idempotency-key': key },
      });
      const reused = await harness.request('POST', '/api/v1/books', {
        token: memberA,
        body: { title: 'Different Intent', language: 'en' },
        headers: { 'idempotency-key': key },
      });
      expect(reused.status).toBe(409);
    });

    it('requires an Idempotency-Key on book creation', async () => {
      const res = await harness.request('POST', '/api/v1/books', {
        token: memberA,
        body: { title: 'No Key', language: 'en' },
      });
      expect(res.status).toBe(400);
    });
  });

  // ------------------------------------------------------- book lifecycle ----

  describe('book lifecycle (§46, §47, §104, §137)', () => {
    it('paginates the book list rather than truncating it', async () => {
      const res = await harness.request('GET', '/api/v1/books?limit=1', { token: memberA });
      expect(res.status).toBe(200);
      const page = (res.body as { data: unknown[]; page: { has_more: boolean; limit: number } })
        .page;
      expect(page.limit).toBe(1);
      expect(page).toHaveProperty('next_cursor');
      expect(page).toHaveProperty('has_more');
    });

    it('walks a cursor without repeating or skipping a row', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i += 1) {
        const path: string = `/api/v1/books?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await harness.request('GET', path, { token: memberA });
        const body = res.body as {
          data: { id: string }[];
          page: { next_cursor: string | null; has_more: boolean };
        };
        seen.push(...body.data.map((b) => b.id));
        if (!body.page.has_more) break;
        cursor = body.page.next_cursor;
      }
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('rejects an unknown status filter with 422, not a 500', async () => {
      const res = await harness.request('GET', '/api/v1/books?status=ALMOST_THERE', {
        token: memberA,
      });
      expect(res.status).toBe(422);
    });

    it('soft-deletes: 204, gone from the list, still in the database', async () => {
      const doomed = await createBook(memberA, 'To Be Deleted');

      const del = await harness.request('DELETE', `/api/v1/books/${doomed}`, { token: memberA });
      expect(del.status).toBe(204);

      const list = await harness.request('GET', '/api/v1/books?limit=100', { token: memberA });
      const ids = (list.body as { data: { id: string }[] }).data.map((b) => b.id);
      expect(ids).not.toContain(doomed);

      // §16.6.1: deletion is a `deleted_at` stamp. Artifacts are retained.
      const row = await prisma.book.findUnique({ where: { id: doomed } });
      expect(row).not.toBeNull();
      expect(row?.deletedAt).not.toBeNull();
    });

    it('is naturally idempotent: deleting twice is 204 both times', async () => {
      const doomed = await createBook(memberA, 'Deleted Twice');
      const first = await harness.request('DELETE', `/api/v1/books/${doomed}`, { token: memberA });
      const second = await harness.request('DELETE', `/api/v1/books/${doomed}`, { token: memberA });
      expect([first.status, second.status]).toEqual([204, 204]);
    });

    it('refuses deletion while jobs are still running (§16.6.1)', async () => {
      const busy = await createBook(memberA, 'Busy Book');
      await seedJob(tenantA, busy, { status: 'RUNNING', startedAt: new Date() });

      const del = await harness.request('DELETE', `/api/v1/books/${busy}`, { token: memberA });
      expect(del.status).toBe(409);
      expect((del.body as { error: { code: string } }).error.code).toBe('BOOK_HAS_ACTIVE_JOBS');
    });

    it('shows a deleted book again with include_deleted=true', async () => {
      const doomed = await createBook(memberA, 'Recoverable');
      await harness.request('DELETE', `/api/v1/books/${doomed}`, { token: memberA });

      const res = await harness.request('GET', '/api/v1/books?limit=100&include_deleted=true', {
        token: memberA,
      });
      const ids = (res.body as { data: { id: string }[] }).data.map((b) => b.id);
      expect(ids).toContain(doomed);
    });
  });

  // ------------------------------------------------------ platform metadata --

  describe('platform metadata (§16.21)', () => {
    it('serves limits and vocabularies a frontend would otherwise hard-code', async () => {
      const res = await harness.request('GET', '/api/v1/capabilities', { token: memberA });
      expect(res.status).toBe(200);
      const data = (
        res.body as {
          data: {
            limits: { max_page_limit: number };
            vocabularies: { emotion: string[]; delivery_mode: string[] };
            delivery_formats: string[];
          };
        }
      ).data;

      expect(data.limits.max_page_limit).toBe(100);
      expect(data.vocabularies.emotion).toContain('NEUTRAL');
      expect(data.vocabularies.delivery_mode).toContain('INTERNAL_THOUGHT');
      expect(data.delivery_formats).toContain('M4B');
    });

    it('never leaks fleet detail through capabilities', async () => {
      const res = await harness.request('GET', '/api/v1/capabilities', { token: memberA });
      const serialized = JSON.stringify(res.body);
      for (const forbidden of ['hostname', 'vram', 'queue_depth', 'redis', 'weights_storage_key']) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('serves the model registry so an artifact can be traced to its models', async () => {
      const res = await harness.request('GET', '/api/v1/model-versions?limit=5', {
        token: memberA,
      });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('page');
    });
  });

  // ------------------------------------------------------------------ user ---

  describe('self-service user surface (§16.2)', () => {
    it('returns the caller and only the caller', async () => {
      const res = await harness.request('GET', '/api/v1/users/me', { token: memberA });
      expect(res.status).toBe(200);
      const data = (res.body as { data: { id: string; tenant_id: string } }).data;
      expect(data.id).toBe(userA);
      expect(data.tenant_id).toBe(tenantA);
    });

    it('refuses to patch email or roles', async () => {
      for (const body of [{ email: 'new@example.com' }, { roles: ['PLATFORM_ADMIN'] }]) {
        const res = await harness.request('PATCH', '/api/v1/users/me', { token: memberA, body });
        expect(res.status).toBe(422);
      }
      const row = await prisma.user.findUnique({ where: { id: userA } });
      expect(row?.roles).toEqual(['TENANT_OWNER']);
    });

    it('reports quotas, and reports an absent policy row as no limit', async () => {
      const res = await harness.request('GET', '/api/v1/users/me/quotas', { token: memberA });
      expect(res.status).toBe(200);
      const data = (
        res.body as {
          data: { degraded: boolean; quotas: { books_total: { limit: number | null } } };
        }
      ).data;
      expect(data.degraded).toBe(false);
      expect(data.quotas.books_total.limit).toBeNull();
    });
  });

  // ------------------------------------------------------------ error shape --

  describe('error contract (§36, §38, §58, §117)', () => {
    it('carries the §8.1 envelope on every failure', async () => {
      const res = await harness.request('GET', `/api/v1/jobs/${generateId()}`, { token: memberA });
      expect(res.status).toBe(404);
      const error = (res.body as { error: Record<string, unknown> }).error;
      for (const field of ['code', 'message', 'request_id', 'trace_id', 'retryable']) {
        expect(error).toHaveProperty(field);
      }
    });

    it('treats a malformed identifier as a client error, not a server fault', async () => {
      const res = await harness.request('GET', '/api/v1/jobs/not-a-uuid', { token: memberA });
      // This returned 500 INTERNAL_ERROR until Phase 8: Prisma's P2023 escaped
      // unhandled. A 500 tells the caller to retry something that can never
      // succeed. Same class as QA finding F-17.
      expect(res.status).toBe(422);
      expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_IDENTIFIER');
    });

    it('never leaks internals in an error message (§8.2)', async () => {
      const res = await harness.request('GET', '/api/v1/jobs/not-a-uuid', { token: memberA });
      const serialized = JSON.stringify(res.body);
      for (const leak of ['prisma', 'PostgresError', 'at Object.', '/Users/', 'SELECT ']) {
        expect(serialized.toLowerCase()).not.toContain(leak.toLowerCase());
      }
    });

    it('echoes a client-supplied correlation id so a request is traceable (§39, §118)', async () => {
      const requestId = randomUUID();
      const res = await harness.request('GET', '/api/v1/users/me', {
        token: memberA,
        headers: { 'x-request-id': requestId },
      });
      expect(res.headers.get('x-request-id')).toBe(requestId);
      expect(res.headers.get('x-trace-id')).toBeTruthy();
    });
  });

  // ------------------------------------------------------------------ audit --

  describe('audit trail (§76, §77)', () => {
    it('records book creation against the acting user', async () => {
      const created = await createBook(memberA, 'Audited Book');

      // The interceptor's write is deliberately fire-and-forget: an audit
      // failure must never turn a successful creation into a 500. That makes
      // it eventually consistent with the response, so this polls rather than
      // asserting immediately. (Cancellation is different — there the audit is
      // awaited inside the service, so it is committed before the reply.)
      const rows = await eventually(
        () => prisma.auditLog.findMany({ where: { action: 'BOOK_CREATED', resourceId: created } }),
        (r) => r.length === 1,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.actorUserId).toBe(userA);
      expect(rows[0]?.tenantId).toBe(tenantA);
    });

    it('exposes no audit endpoint to ordinary users (§77)', async () => {
      // The trail exists for operators and compliance, not as a user-facing
      // resource; there is deliberately no route to it. An unrouted path must
      // read as 404 — this originally returned 500, because the exception
      // filter collapsed every framework `HttpException` to INTERNAL_ERROR.
      const res = await harness.request('GET', '/api/v1/audit-logs', { token: memberA });
      expect(res.status).toBe(404);
      expect((res.body as { error: { code: string } }).error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------- SSE --

  describe('event stream (§80, §81)', () => {
    it("refuses to open a stream for another tenant's book before writing a byte", async () => {
      const res = await fetch(`${harness.baseUrl}/api/v1/books/${bookB}/events`, {
        headers: { authorization: `Bearer ${memberA}`, accept: 'text/event-stream' },
      });
      expect(res.status).toBe(404);
      // A normal error envelope, not an SSE frame.
      expect(res.headers.get('content-type')).toContain('json');
      await res.text();
    });

    it('opens an SSE stream for an owned book and delivers its events', async () => {
      const controller = new AbortController();
      const res = await fetch(`${harness.baseUrl}/api/v1/books/${bookA}/events`, {
        headers: { authorization: `Bearer ${memberA}`, accept: 'text/event-stream' },
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // Provoke an event on this book, then read until it arrives.
      const jobId = await seedJob(tenantA, bookA, { status: 'QUEUED' });
      await harness.request('POST', `/api/v1/jobs/${jobId}/cancellation`, {
        token: memberA,
        body: {},
      });

      const received = await readUntil(res, 'job.cancelled', controller, 10_000);
      controller.abort();
      expect(received).toContain('job.cancelled');
      // §11.3 payload rule: identifiers and small facts, never bulk content.
      expect(received).not.toContain('storage_key');
    });
  });
});

/** Polls `read` until `done` holds or the deadline passes, then returns the last value read. */
async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return value;
}

/**
 * Reads an SSE body until `marker` appears, then returns everything read.
 *
 * Deliberately a single sequential read loop, with no `Promise.race` timeout
 * around `reader.read()`. Racing a read against a timer looks like a safe way
 * to bound the wait, but it is not: when the timer wins, the outstanding
 * `read()` promise is orphaned and the chunk it later resolves with is
 * discarded. Every frame after the first timeout is then silently lost, which
 * reads as "the server sent nothing" — the symptom that sent this
 * investigation after the server instead of the test.
 *
 * The deadline is enforced by aborting the request, which ends the stream and
 * terminates the loop.
 */
async function readUntil(
  response: Response,
  marker: string,
  controller: AbortController,
  timeoutMs: number,
): Promise<string> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.includes(marker)) break;
    }
  } catch {
    // An abort surfaces here; whatever was read so far is the result.
  } finally {
    clearTimeout(deadline);
  }
  return buffer;
}
