import { describe, expect, it, vi } from 'vitest';
import { processMaintenanceJob } from './maintenance.js';

/**
 * A generic in-memory Prisma stand-in covering every model
 * `runPurgeBook` touches. Rows are plain objects keyed by `id`; every
 * delegate supports the subset of Prisma's query shape the purge processor
 * actually calls (`findMany`/`findFirst`/`findUnique`/`deleteMany`/`update`/
 * `create`), matched generically by `where` rather than per-model, since the
 * purge order (`database-schema.md` §27.4) is what this test verifies, not
 * each model's full real schema.
 */
function makeStore() {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();

  function table(name: string): Map<string, Record<string, unknown>> {
    let t = tables.get(name);
    if (!t) {
      t = new Map();
      tables.set(name, t);
    }
    return t;
  }

  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, condition]) => {
      if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
        const cond = condition as { in?: unknown[]; not?: unknown };
        if (cond.in) return cond.in.includes(row[key]);
        if ('not' in cond) return row[key] !== cond.not;
      }
      // Two distinct Date instances for the same instant are not `===`
      // equal — this store compares them by value like Postgres would.
      if (condition instanceof Date && row[key] instanceof Date) {
        return row[key].getTime() === condition.getTime();
      }
      return row[key] === condition;
    });
  }

  function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    if (where.OR) {
      return (where.OR as Record<string, unknown>[]).some((clause) => matches(row, clause));
    }
    return matches(row, where);
  }

  function delegate(name: string) {
    return {
      findMany: vi.fn(({ where = {} }: { where?: Record<string, unknown> } = {}) =>
        Promise.resolve([...table(name).values()].filter((r) => matchesWhere(r, where))),
      ),
      findFirst: vi.fn(({ where = {} }: { where?: Record<string, unknown> } = {}) =>
        Promise.resolve([...table(name).values()].find((r) => matchesWhere(r, where)) ?? null),
      ),
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(table(name).get(where.id) ?? null),
      ),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        table(name).set(data.id as string, data);
        return Promise.resolve(data);
      }),
      update: vi.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = table(name).get(where.id);
        if (row) table(name).set(where.id, { ...row, ...data });
        return Promise.resolve(table(name).get(where.id));
      }),
      upsert: vi.fn(
        ({
          where,
          create,
          update,
        }: {
          where: Record<string, Record<string, unknown>>;
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const compositeKey = Object.values(where)[0] as Record<string, unknown>;
          const existing = [...table(name).values()].find((r) => matches(r, compositeKey));
          if (!existing) {
            table(name).set(create.id as string, create);
            return Promise.resolve(create);
          }
          const increment = (update.usedValue as { increment?: bigint } | undefined)?.increment;
          const next = {
            ...existing,
            usedValue: increment !== undefined ? (existing.usedValue as bigint) + increment : existing.usedValue,
          };
          table(name).set(existing.id as string, next);
          return Promise.resolve(next);
        },
      ),
      deleteMany: vi.fn(({ where = {} }: { where?: Record<string, unknown> } = {}) => {
        let count = 0;
        for (const [id, row] of table(name)) {
          if (matchesWhere(row, where)) {
            table(name).delete(id);
            count++;
          }
        }
        return Promise.resolve({ count });
      }),
    };
  }

  const MODEL_NAMES = [
    'processingJob',
    'auditLog',
    'audiobookRendition',
    'audiobookCover',
    'audiobookChapter',
    'audiobook',
    'chapterAudioMember',
    'chapterAudio',
    'audioChunk',
    'ttsJob',
    'audioScriptChunkSource',
    'audioScriptChunk',
    'audioScript',
    'voicePreview',
    'voiceAssignment',
    'voiceProfile',
    'voiceProfileVersion',
    'narrativeEmbedding',
    'narrativeSummary',
    'narrativeLocation',
    'narrativeTimelineEvent',
    'narrativeObject',
    'narrativeFaction',
    'narrativeThread',
    'characterRelationship',
    'sceneSemantics',
    'narrativeState',
    'storyBibleVersion',
    'storyBible',
    'pronunciationEntry',
    'characterAlias',
    'characterMerge',
    'character',
    'paragraph',
    'scene',
    'section',
    'chapter',
    'parsedPage',
    'bookVersion',
    'bookFile',
    'processingAttempt',
    'jobDependency',
    'bookCounter',
    'book',
    'tenantUsageCounter',
  ] as const;

  const prisma: Record<string, ReturnType<typeof delegate>> = {};
  for (const name of MODEL_NAMES) prisma[name] = delegate(name);

  return { prisma, table };
}

function makeStorage() {
  const deleted: string[] = [];
  return {
    storage: {
      delete: vi.fn((key: string) => {
        deleted.push(key);
        return Promise.resolve();
      }),
    },
    deleted,
  };
}

function purgeEnvelope(jobId: string, bookId: string, tenantId = 'tenant-1') {
  return {
    job_id: jobId,
    entity_id: jobId,
    correlation_id: 'corr-1',
    tenant_id: tenantId,
    payload: { operation: 'purge_book' as const, book_id: bookId },
  };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('processMaintenanceJob — purge_book (database-schema.md §27.4)', () => {
  it('deletes storage objects, then rows, and writes the closing audit row', async () => {
    const { prisma, table } = makeStore();
    const { storage, deleted } = makeStorage();
    const bookId = 'book-1';
    const jobId = 'purge-job-1';

    table('processingJob').set(jobId, {
      id: jobId,
      bookId,
      tenantId: 'tenant-1',
      correlationId: 'corr-1',
      status: 'CREATED',
      type: 'cleanup_artifacts',
    });
    table('audiobook').set('ab-1', { id: 'ab-1', bookId, storageKey: 'tenant-1/books/book-1/audiobooks/ab-1.m4b' });
    table('audioChunk').set('chunk-1', { id: 'chunk-1', bookId, storageKey: 'tenant-1/books/book-1/audio/c1.wav' });
    table('character').set('char-1', { id: 'char-1', bookId });
    table('bookFile').set('file-1', {
      id: 'file-1',
      bookId,
      storageKey: 'tenant-1/books/book-1/uploads/f1.pdf',
      sizeBytes: 12345n,
    });
    table('book').set(bookId, { id: bookId, tenantId: 'tenant-1', deletedAt: new Date() });

    await processMaintenanceJob({
      prisma: prisma as never,
      storage: storage as never,
      logger: logger as never,
      envelope: purgeEnvelope(jobId, bookId),
    });

    // Storage objects deleted before rows.
    expect(deleted).toEqual(
      expect.arrayContaining([
        'tenant-1/books/book-1/audiobooks/ab-1.m4b',
        'tenant-1/books/book-1/audio/c1.wav',
        'tenant-1/books/book-1/uploads/f1.pdf',
      ]),
    );

    // Rows gone.
    expect(table('audiobook').size).toBe(0);
    expect(table('audioChunk').size).toBe(0);
    expect(table('character').size).toBe(0);
    expect(table('bookFile').size).toBe(0);
    expect(table('book').size).toBe(0);

    // The closing audit row — what BookPurgeGuard checks for.
    const auditRows = [...table('auditLog').values()];
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: 'BOOK_PURGED', resourceType: 'book', resourceId: bookId });

    // The purge job itself survives and is marked SUCCEEDED.
    expect(table('processingJob').get(jobId)).toMatchObject({ status: 'SUCCEEDED' });

    // STORAGE_BYTES accounting ran (Phase 10 quota completion). A fresh
    // counter with no prior increment floors at zero rather than going
    // negative — the increment side is `completeUploadSession`'s job, not
    // exercised in this worker-only test.
    const usageRows = [...table('tenantUsageCounter').values()];
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({ metric: 'STORAGE_BYTES', usedValue: 0n });
  });

  it('decrements an existing STORAGE_BYTES counter by the freed BookFile size', async () => {
    const { prisma, table } = makeStore();
    const { storage } = makeStorage();
    const bookId = 'book-1';
    const jobId = 'purge-job-6';
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    table('processingJob').set(jobId, {
      id: jobId,
      bookId,
      tenantId: 'tenant-1',
      correlationId: 'corr-1',
      status: 'CREATED',
    });
    table('bookFile').set('file-1', {
      id: 'file-1',
      bookId,
      storageKey: 'tenant-1/books/book-1/uploads/f1.pdf',
      sizeBytes: 500n,
    });
    table('tenantUsageCounter').set('counter-1', {
      id: 'counter-1',
      tenantId: 'tenant-1',
      periodStart,
      metric: 'STORAGE_BYTES',
      usedValue: 2000n,
    });
    table('book').set(bookId, { id: bookId, tenantId: 'tenant-1' });

    await processMaintenanceJob({
      prisma: prisma as never,
      storage: storage as never,
      logger: logger as never,
      envelope: purgeEnvelope(jobId, bookId),
    });

    expect(table('tenantUsageCounter').get('counter-1')).toMatchObject({ usedValue: 1500n });
  });

  it('never deletes a BookFile object still referenced by another book (content-hash dedup)', async () => {
    const { prisma, table } = makeStore();
    const { storage, deleted } = makeStorage();
    const bookId = 'book-1';
    const jobId = 'purge-job-2';
    const sharedKey = 'tenant-1/books/shared/source.pdf';

    table('processingJob').set(jobId, {
      id: jobId,
      bookId,
      tenantId: 'tenant-1',
      correlationId: 'corr-1',
      status: 'CREATED',
    });
    table('bookFile').set('f1', { id: 'f1', bookId, storageKey: sharedKey });
    table('bookFile').set('f2', { id: 'f2', bookId: 'other-book', storageKey: sharedKey });
    table('book').set(bookId, { id: bookId, tenantId: 'tenant-1' });

    await processMaintenanceJob({
      prisma: prisma as never,
      storage: storage as never,
      logger: logger as never,
      envelope: purgeEnvelope(jobId, bookId),
    });

    expect(deleted).not.toContain(sharedKey);
    // This book's row is gone; the other book's row (and the shared object) survive.
    expect(table('bookFile').has('f1')).toBe(false);
    expect(table('bookFile').has('f2')).toBe(true);
  });

  it('preserves the purge job\'s own ProcessingJob row while deleting every other job for the book', async () => {
    const { prisma, table } = makeStore();
    const { storage } = makeStorage();
    const bookId = 'book-1';
    const jobId = 'purge-job-3';

    table('processingJob').set(jobId, {
      id: jobId,
      bookId,
      tenantId: 'tenant-1',
      correlationId: 'corr-1',
      status: 'CREATED',
    });
    table('processingJob').set('old-parse-job', { id: 'old-parse-job', bookId, status: 'SUCCEEDED' });
    table('book').set(bookId, { id: bookId, tenantId: 'tenant-1' });

    await processMaintenanceJob({
      prisma: prisma as never,
      storage: storage as never,
      logger: logger as never,
      envelope: purgeEnvelope(jobId, bookId),
    });

    expect(table('processingJob').has('old-parse-job')).toBe(false);
    expect(table('processingJob').get(jobId)).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('is idempotent: re-running after a completed purge is a safe no-op', async () => {
    const { prisma, table } = makeStore();
    const { storage } = makeStorage();
    const bookId = 'book-1';
    const jobId = 'purge-job-4';

    table('processingJob').set(jobId, {
      id: jobId,
      bookId,
      tenantId: 'tenant-1',
      correlationId: 'corr-1',
      status: 'CREATED',
    });
    table('book').set(bookId, { id: bookId, tenantId: 'tenant-1' });

    await processMaintenanceJob({
      prisma: prisma as never,
      storage: storage as never,
      logger: logger as never,
      envelope: purgeEnvelope(jobId, bookId),
    });
    // Second delivery of the same job — BullMQ at-least-once semantics.
    await expect(
      processMaintenanceJob({
        prisma: prisma as never,
        storage: storage as never,
        logger: logger as never,
        envelope: purgeEnvelope(jobId, bookId),
      }),
    ).resolves.toBeUndefined();

    expect([...table('auditLog').values()]).toHaveLength(1); // not double-audited
  });

  it('leaves the job FAILED and retryable when a step throws, without silently swallowing the error', async () => {
    const { prisma, table } = makeStore();
    const { storage } = makeStorage();
    const bookId = 'book-1';
    const jobId = 'purge-job-5';

    table('processingJob').set(jobId, {
      id: jobId,
      bookId,
      tenantId: 'tenant-1',
      correlationId: 'corr-1',
      status: 'CREATED',
    });
    table('book').set(bookId, { id: bookId, tenantId: 'tenant-1' });
    // Force a failure inside the purge.
    prisma.character!.deleteMany = vi.fn(() => Promise.reject(new Error('boom')));

    await expect(
      processMaintenanceJob({
        prisma: prisma as never,
        storage: storage as never,
        logger: logger as never,
        envelope: purgeEnvelope(jobId, bookId),
      }),
    ).rejects.toThrow('boom');

    expect(table('processingJob').get(jobId)).toMatchObject({ status: 'FAILED' });
    expect(table('book').has(bookId)).toBe(true); // never reached the terminal steps
  });
});
