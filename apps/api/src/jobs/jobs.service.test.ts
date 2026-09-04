import { describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError } from '@audio-book/errors';
import { JobsService } from './jobs.service.js';

/**
 * The cancellation state table of `api-specification.md` §16.18 /
 * `event-contracts.md` §29.2, exercised state by state.
 *
 * It is worth testing exhaustively because every row is a place where the
 * obvious implementation is wrong in a user-visible way: returning `409` for a
 * terminal job, reporting a `RUNNING` job as stopped the moment cancellation is
 * requested, or reviving a `SUCCEEDED` job by marking it `CANCELLED`.
 */

const principal = { sub: 'user-1', tenantId: 'tenant-1', roles: ['TENANT_MEMBER'], scopes: [] };

interface JobRow extends Record<string, unknown> {
  id: string;
  tenantId: string;
  status: string;
  queue: string;
  parentJobId: string | null;
}

function baseJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    bookId: 'book-1',
    type: 'generate_tts_chunk',
    status: 'QUEUED',
    queue: 'gpu',
    priority: 'NORMAL',
    relatedResourceType: 'audio_script_chunk',
    relatedResourceId: 'chunk-1',
    parentJobId: null,
    childJobCount: 0,
    progress: 0,
    progressStage: null,
    completedUnits: 0,
    totalUnits: null,
    attemptCount: 0,
    maxAttempts: 3,
    retryCount: 0,
    nextAttemptAt: null,
    blockedReason: null,
    cancellationRequested: false,
    cancellationRequestedAt: null,
    cancellationRequestedByUserId: null,
    cancellationEffectiveAt: null,
    errorCode: null,
    errorClass: null,
    errorMessage: null,
    errorRetryable: null,
    errorTerminal: null,
    resultResourceType: null,
    resultResourceId: null,
    resultVersion: null,
    idempotencyFingerprint: 'f'.repeat(64),
    forced: false,
    correlationId: 'corr-1',
    dispatchEnvelope: null,
    scope: null,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    heartbeatAt: null,
    ...overrides,
  };
}

function makeService(jobs: JobRow[]) {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const outbox: Record<string, unknown>[] = [];

  const applyUpdate = (id: string, data: Record<string, unknown>) => {
    const row = byId.get(id);
    if (!row) throw new Error(`no such job ${id}`);
    const flat: Record<string, unknown> = { ...data };
    // The service writes the actor as a Prisma `connect`; flatten it to the
    // column the DTO reads.
    const connect = data.cancellationRequestedByUser as { connect?: { id: string } } | undefined;
    if (connect?.connect) {
      flat.cancellationRequestedByUserId = connect.connect.id;
      delete flat.cancellationRequestedByUser;
    }
    Object.assign(row, flat);
    return row;
  };

  const tx = {
    processingJob: {
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Promise.resolve(applyUpdate(where.id, data)),
      ),
    },
    outboxMessage: {
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        outbox.push(data);
        return Promise.resolve(data);
      }),
    },
  };

  const prisma = {
    processingJob: {
      findFirst: vi.fn(({ where }: { where: { id: string; tenantId: string } }) => {
        const row = byId.get(where.id);
        return Promise.resolve(row && row.tenantId === where.tenantId ? row : null);
      }),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(byId.get(where.id) ?? null),
      ),
      findUniqueOrThrow: vi.fn(({ where }: { where: { id: string } }) => {
        const row = byId.get(where.id);
        if (!row) throw new Error('not found');
        return Promise.resolve(row);
      }),
      findMany: vi.fn(({ where }: { where: { parentJobId?: string } }) =>
        Promise.resolve(
          jobs.filter(
            (j) =>
              j.parentJobId === where.parentJobId &&
              !['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED'].includes(j.status),
          ),
        ),
      ),
      create: vi.fn(({ data }: { data: JobRow }) => {
        // Fill in what the database supplies by default (@default(now()),
        // @updatedAt, and the counters with defaults), so the fixture returns
        // the shape a real INSERT would rather than only the columns the
        // service wrote.
        const row: JobRow = {
          ...baseJob({ id: data.id }),
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        byId.set(row.id, row);
        return Promise.resolve(row);
      }),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Promise.resolve(applyUpdate(where.id, data)),
      ),
    },
    $transaction: vi.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };

  const queueManager = {
    removeQueuedJob: vi.fn(() => Promise.resolve(true)),
    enqueue: vi.fn(() => Promise.resolve({})),
  };
  const redis = {
    set: vi.fn(() => Promise.resolve('OK')),
    get: vi.fn(() => Promise.resolve(null)),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const audit = { record: vi.fn(() => Promise.resolve()) };

  const service = new JobsService(
    prisma as never,
    queueManager as never,
    redis as never,
    logger as never,
    audit as never,
  );
  return { service, prisma, queueManager, redis, audit, outbox, byId };
}

describe('JobsService.cancelJob — the §29.2 state table', () => {
  it.each(['CREATED', 'QUEUED', 'BLOCKED', 'RETRYING'])(
    'cancels a %s job immediately and reports it as effective',
    async (status) => {
      const { service, byId } = makeService([baseJob({ status })]);
      const result = await service.cancelJob(principal, 'job-1', {});

      expect(result.status).toBe('CANCELLED');
      expect(result.cancellation.requested).toBe(true);
      expect(result.cancellation.effective).toBe(true);
      expect(byId.get('job-1')?.completedAt).toBeInstanceOf(Date);
    },
  );

  it('does NOT claim a RUNNING job stopped — only that cancellation was requested', async () => {
    const { service } = makeService([baseJob({ status: 'RUNNING' })]);
    const result = await service.cancelJob(principal, 'job-1', {});

    // The whole point of §16.18's RUNNING row: the response must not imply the
    // GPU stopped. Only the worker's acknowledgement moves it to CANCELLED.
    expect(result.status).toBe('RUNNING');
    expect(result.cancellation.requested).toBe(true);
    expect(result.cancellation.effective).toBe(false);
  });

  it('emits job.cancelled only where cancellation actually took effect', async () => {
    const immediate = makeService([baseJob({ status: 'QUEUED' })]);
    await immediate.service.cancelJob(principal, 'job-1', {});
    expect(immediate.outbox).toHaveLength(1);
    expect(immediate.outbox[0]?.eventType).toBe('job.cancelled');

    const running = makeService([baseJob({ status: 'RUNNING' })]);
    await running.service.cancelJob(principal, 'job-1', {});
    // Emitting here would tell every consumer the work stopped while it is
    // still running; the worker emits it on acknowledgement instead.
    expect(running.outbox).toHaveLength(0);
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED'])(
    'is a 200 no-op for a terminal %s job, never a 409 and never a revival',
    async (status) => {
      const { service, byId, outbox } = makeService([baseJob({ status })]);
      const result = await service.cancelJob(principal, 'job-1', {});

      expect(result.status).toBe(status);
      expect(byId.get('job-1')?.status).toBe(status);
      expect(outbox).toHaveLength(0);
      if (status !== 'CANCELLED') {
        expect(result.cancellation.requested).toBe(false);
      }
    },
  );

  it('is idempotent: cancelling twice does not change the outcome', async () => {
    const { service, byId } = makeService([baseJob({ status: 'QUEUED' })]);
    const first = await service.cancelJob(principal, 'job-1', {});
    const firstRequestedAt = byId.get('job-1')?.cancellationRequestedAt;
    const second = await service.cancelJob(principal, 'job-1', {});

    expect(second.status).toBe(first.status);
    // §29.2: "original `requested_at` preserved".
    expect(byId.get('job-1')?.cancellationRequestedAt).toBe(firstRequestedAt);
  });

  it('cascades to children: terminates the queued ones, requests the running one', async () => {
    const { service, byId } = makeService([
      baseJob({ id: 'coordinator', status: 'RUNNING' }),
      baseJob({ id: 'child-queued', status: 'QUEUED', parentJobId: 'coordinator' }),
      baseJob({ id: 'child-running', status: 'RUNNING', parentJobId: 'coordinator' }),
      baseJob({ id: 'child-done', status: 'SUCCEEDED', parentJobId: 'coordinator' }),
    ]);

    await service.cancelJob(principal, 'coordinator', {});

    expect(byId.get('child-queued')?.status).toBe('CANCELLED');
    expect(byId.get('child-running')?.status).toBe('RUNNING');
    expect(byId.get('child-running')?.cancellationRequested).toBe(true);
    // §29.5: already-completed work is retained.
    expect(byId.get('child-done')?.status).toBe('SUCCEEDED');
    expect(byId.get('child-done')?.cancellationRequested).toBe(false);
  });

  it('sets the Redis fast-path flag as well as the durable column', async () => {
    const { service, redis } = makeService([baseJob({ status: 'RUNNING' })]);
    await service.cancelJob(principal, 'job-1', {});
    expect(redis.set).toHaveBeenCalledWith(
      'job:cancel:tenant-1:job-1',
      '1',
      'EX',
      expect.any(Number),
    );
  });

  it('still commits the durable cancellation when Redis is unavailable', async () => {
    const { service, redis, byId } = makeService([baseJob({ status: 'RUNNING' })]);
    redis.set.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.cancelJob(principal, 'job-1', {})).resolves.toBeDefined();
    // A broker outage delays cancellation (the worker falls back to this
    // column) — it must never lose it.
    expect(byId.get('job-1')?.cancellationRequested).toBe(true);
  });

  it('refuses a job belonging to another tenant with 404, not 403', async () => {
    const { service } = makeService([baseJob({ tenantId: 'tenant-2' })]);
    // §6.4: a 403 would confirm the job exists for a tenant the caller cannot
    // see into.
    await expect(service.cancelJob(principal, 'job-1', {})).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('JobsService reads', () => {
  it('never exposes a result for a non-terminal job', async () => {
    const { service } = makeService([
      baseJob({
        status: 'RUNNING',
        resultResourceType: 'audio_chunk',
        resultResourceId: 'chunk-out-1',
      }),
    ]);
    // §16.18: "the API never predicts an outcome."
    expect((await service.getJob(principal, 'job-1')).result).toBeNull();
  });

  it('reports an unknown total as null rather than zero', async () => {
    const { service } = makeService([baseJob({ totalUnits: null })]);
    expect((await service.getJob(principal, 'job-1')).progress.total_units).toBeNull();
  });

  it('does not leak worker leases, dispatch envelopes, or scope internals', async () => {
    const { service } = makeService([baseJob({ dispatchEnvelope: { secret: 'payload' } })]);
    const dto = (await service.getJob(principal, 'job-1')) as Record<string, unknown>;

    for (const forbidden of ['dispatch_envelope', 'lease_worker_id', 'lease_fence', 'scope']) {
      expect(dto).not.toHaveProperty(forbidden);
    }
  });

  it('rejects an unknown status filter instead of passing it to Postgres', async () => {
    const { service } = makeService([baseJob()]);
    // An unchecked value reaches Postgres as an invalid enum literal and
    // surfaces as a 500 for what is a client mistake.
    await expect(service.listJobs(principal, { status: 'ALMOST_DONE' })).rejects.toThrow();
  });

  it('rejects a sort field outside the allowlist', async () => {
    const { service } = makeService([baseJob()]);
    await expect(service.listJobs(principal, { sort: 'error_message:asc' })).rejects.toThrow();
  });
});

describe('JobsService.replayJob', () => {
  it('refuses to replay a job that is not terminal-failed', async () => {
    const { service } = makeService([baseJob({ status: 'RUNNING' })]);
    await expect(service.replayJob(principal, 'job-1')).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses to replay a job with no recorded dispatch envelope', async () => {
    const { service } = makeService([baseJob({ status: 'DEAD_LETTERED', dispatchEnvelope: null })]);
    // Inventing a payload would dispatch a job the service never described.
    await expect(service.replayJob(principal, 'job-1')).rejects.toBeInstanceOf(ConflictError);
  });

  it('creates a NEW job and leaves the original untouched', async () => {
    const { service, byId } = makeService([
      baseJob({
        status: 'DEAD_LETTERED',
        dispatchEnvelope: { job_id: 'job-1', payload: { tts_job_id: 't-1' } },
      }),
    ]);

    const replayed = await service.replayJob(principal, 'job-1');

    expect(replayed.id).not.toBe('job-1');
    expect(byId.get('job-1')?.status).toBe('DEAD_LETTERED');
    // Lineage: the replay points back at what it replaced.
    expect(byId.get(replayed.id)?.causationId).toBe('job-1');
    expect(byId.get(replayed.id)?.correlationId).toBe('corr-1');
  });
});
