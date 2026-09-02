import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPrismaClient,
  disconnectPrisma,
  type PrismaClient,
} from '@audio-book/database';
import { generateId } from '@audio-book/events';
import { PARSER_VERSION_FOR_IDEMPOTENCY } from '@audio-book/ingestion';
import { QueueManager, type QueueJobEnvelope } from '@audio-book/queue';
import { buildStorageKey, checksumBuffer, S3StorageProvider, type StorageProvider } from '@audio-book/storage';
import {
  processIngestionJob,
  type ParseBookCommandPayload,
} from '@audio-book/worker-cpu/processors/ingestion';
import { ProcessingJobSweeper } from '@audio-book/worker-cpu/processing-job-sweeper';

/**
 * Phase 7 reliability regression test for the orphaned-job-dispatch gap
 * (every API service commits a ProcessingJob row, then separately — not
 * transactionally — calls queueManager.enqueue(); a crash/outage between
 * those two steps used to strand the row at status=CREATED forever).
 *
 * Simulates exactly that crash: a `parse_book` ProcessingJob row is created
 * directly via Prisma with `queuedAt: null` and a backdated `createdAt` —
 * no `enqueue()` call ever happens, mirroring what a real crash between the
 * Postgres commit and the Redis call would leave behind. The real
 * ProcessingJobSweeper (apps/worker-cpu/src/processing-job-sweeper.ts) is
 * then run once and must recover it: re-enqueue it, and a real `parse`
 * worker running the actual `processIngestionJob` handler must pick it up.
 *
 * The uploaded BookFile content is deliberately not a real PDF/EPUB/image —
 * `processIngestionJob` will fail fast with a terminal `UnsupportedFormatError`
 * (packages/ingestion/src/detect-format.ts), which is fine: the point of
 * this test is proving dispatch/recovery, not full ingestion success. A
 * terminal error still exercises the real success path we care about —
 * `queuedAt` getting set, the real worker dequeuing the job, and
 * `processIngestionJob` actually running and updating ProcessingJob.status
 * away from CREATED — deterministically and on the very first attempt
 * (packages/ingestion/src/errors.ts's `isTerminalIngestionError`).
 *
 * Requires Postgres + Redis + MinIO reachable (see docker-compose.yml).
 */
describe('ProcessingJobSweeper: recovers a parse_book job orphaned by a commit-then-enqueue crash', () => {
  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://audiobook:audiobook_dev_password@localhost:5432/audiobook';
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const storageBucket = process.env.STORAGE_BUCKET ?? 'audiobook-dev';

  let prisma: PrismaClient;
  let storage: StorageProvider;
  let queueManager: QueueManager;
  let sweeper: ProcessingJobSweeper;
  const sweeperErrors: unknown[] = [];

  let tenantId: string;
  let userId: string;
  let bookId: string;
  let bookFileId: string;

  const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Parameters<typeof processIngestionJob>[0]['logger'];

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl });
    storage = new S3StorageProvider({
      endpoint: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      bucket: storageBucket,
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'minioadmin',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'minioadmin',
      forcePathStyle: true,
    });
    queueManager = new QueueManager({ redisUrl, backoff: { baseMs: 10, ceilingMs: 100 } });
    sweeper = new ProcessingJobSweeper({
      prisma,
      queueManager,
      logger: silentLogger,
      pollIntervalMs: 60_000, // never fires its own timer in this test — pollOnce() is called directly
      batchSize: 10,
      staleAfterMs: 5_000,
      onError: (err) => sweeperErrors.push(err),
    });

    tenantId = generateId();
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Sweeper Integration Test Tenant', status: 'ACTIVE', planCode: 'test' },
    });
    userId = generateId();
    await prisma.user.create({
      data: {
        id: userId,
        tenantId,
        email: `sweeper-test-${tenantId}@test.local`,
        displayName: 'Sweeper Test User',
        status: 'ACTIVE',
        roles: ['TENANT_OWNER'],
        preferences: {},
      },
    });

    bookId = generateId();
    await prisma.book.create({
      data: {
        id: bookId,
        tenantId,
        title: 'Sweeper Test Book',
        language: 'en',
        status: 'CREATED',
        statusChangedAt: new Date(),
        pipelineVersion: 'ingestion.v1',
        createdByUserId: userId,
      },
    });

    const buffer = Buffer.from('not a real pdf, epub, or image — deliberately unparseable');
    const checksum = checksumBuffer(buffer);
    const storageKey = buildStorageKey({ tenantId, segments: ['book-files', 'sweeper-test.bin'] });
    const meta = await storage.put({ key: storageKey, body: buffer, contentType: 'application/octet-stream' });

    bookFileId = generateId();
    await prisma.bookFile.create({
      data: {
        id: bookFileId,
        tenantId,
        bookId,
        sourceKind: 'PDF',
        originalFileName: 'sweeper-test.bin',
        mimeType: 'application/pdf',
        sniffedMimeType: 'application/octet-stream',
        sizeBytes: BigInt(buffer.byteLength),
        contentHash: checksum.hash,
        contentHashAlgorithm: 'SHA256',
        status: 'ADMITTED',
        validation: { size_check: true, checksum_check: true },
        storageKey,
        storageBucket: meta.bucket,
      },
    });
  });

  afterAll(async () => {
    await sweeper?.stop();
    await queueManager?.close();
    // Matches analysis.integration.test.ts's cleanup convention: some local
    // Postgres setups fail arbitrary queries with a pgvector extension load
    // error unrelated to the tables touched here — non-fatal for cleanup.
    try {
      await prisma.processingJob.deleteMany({ where: { tenantId } });
      await prisma.bookFile.deleteMany({ where: { tenantId } });
      await prisma.book.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    } catch (err) {
      console.warn('processing-job-sweeper.integration.test.ts cleanup failed (non-fatal):', err);
    }
    await disconnectPrisma(prisma);
  });

  it('re-enqueues an orphaned CREATED job with queued_at NULL, and the real parse worker processes it', async () => {
    // ---- 1. Simulate the crash: a ProcessingJob row exists (the Postgres
    //         commit succeeded) but was never handed to queueManager.enqueue()
    //         (the process died / Redis was unreachable right after).
    const jobId = generateId();
    const correlationId = generateId();
    const staleCreatedAt = new Date(Date.now() - 60_000); // well past staleAfterMs

    await prisma.processingJob.create({
      data: {
        id: jobId,
        tenantId,
        bookId,
        type: 'parse_book',
        queue: 'parse',
        priority: 'NORMAL',
        relatedResourceType: 'book_file',
        relatedResourceId: bookFileId,
        status: 'CREATED',
        statusChangedAt: staleCreatedAt,
        createdAt: staleCreatedAt,
        maxAttempts: 3,
        idempotencyKey: `parse:${bookFileId}:sweeper-test`,
        idempotencyFingerprint: 'a'.repeat(64),
        correlationId,
        // Written in the same transaction as the row by every real service, and
        // the only thing that lets the sweeper reconstruct the dispatch (F-4).
        dispatchEnvelope: {
          job_id: jobId,
          entity_id: jobId,
          correlation_id: correlationId,
          tenant_id: tenantId,
          payload: { book_file_id: bookFileId, parser_version: PARSER_VERSION_FOR_IDEMPOTENCY },
        },
      },
    });

    const before = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(before.status).toBe('CREATED');
    expect(before.queuedAt).toBeNull();

    // ---- 2. Register the REAL parse worker, running the REAL processIngestionJob
    //         handler — never a stub — exactly as apps/worker-cpu/src/main.ts wires it.
    const processed = new Promise<void>((resolve, reject) => {
      const worker = queueManager.createWorker<ParseBookCommandPayload>(
        'parse',
        async (job) => {
          const envelope: QueueJobEnvelope<ParseBookCommandPayload> = job.data;
          await processIngestionJob({
            prisma,
            storage,
            logger: silentLogger,
            envelope,
            attemptsMade: job.attemptsMade,
            maxAttempts: 3,
          });
        },
        { concurrency: 1, maxAttempts: 3 },
      );
      // The unparseable fixture makes the FIRST attempt throw a terminal
      // UnsupportedFormatError — BullMQ reports that as 'failed', even though
      // processIngestionJob already recorded the real, correct terminal
      // outcome (ProcessingJob.status = FAILED) before re-throwing. Filter by
      // this test's own jobId — the shared 'parse' queue/worker can still be
      // draining a leftover job from an earlier run.
      worker.on('completed', (job) => {
        if (job.id === jobId) resolve();
      });
      worker.on('failed', (job) => {
        if (job?.id === jobId) resolve();
      });
      setTimeout(() => reject(new Error('Timed out waiting for the swept job to be processed')), 15_000);
    });

    // ---- 3. Run the sweeper once — no timer, deterministic.
    const sweptCount = await sweeper.pollOnce();
    expect(sweptCount).toBe(1);

    const afterSweep = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(afterSweep.queuedAt).not.toBeNull();

    // ---- 4. The real worker must actually pick it up and run it.
    await processed;

    const finalJob = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(finalJob.status).not.toBe('CREATED');
    expect(finalJob.status).toBe('FAILED'); // terminal ingestion error, recorded by the real handler
    expect(finalJob.errorTerminal).toBe(true);
  }, 20_000);

  it('re-enqueuing an already-enqueued job is a safe no-op (BullMQ jobId dedup)', async () => {
    const jobId = generateId();
    const correlationId = generateId();
    const staleCreatedAt = new Date(Date.now() - 60_000);

    await prisma.processingJob.create({
      data: {
        id: jobId,
        tenantId,
        bookId,
        type: 'parse_book',
        queue: 'parse',
        priority: 'NORMAL',
        relatedResourceType: 'book_file',
        relatedResourceId: bookFileId,
        status: 'CREATED',
        statusChangedAt: staleCreatedAt,
        createdAt: staleCreatedAt,
        maxAttempts: 3,
        idempotencyKey: `parse:${bookFileId}:sweeper-dedup-test`,
        idempotencyFingerprint: 'b'.repeat(64),
        correlationId,
        dispatchEnvelope: {
          job_id: jobId,
          entity_id: jobId,
          correlation_id: correlationId,
          tenant_id: tenantId,
          payload: { book_file_id: bookFileId, parser_version: PARSER_VERSION_FOR_IDEMPOTENCY },
        },
      },
    });

    // First sweep enqueues it and marks queued_at.
    expect(await sweeper.pollOnce()).toBe(1);
    const afterFirstSweep = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(afterFirstSweep.queuedAt).not.toBeNull();

    // A second sweep must not re-select it — queued_at is no longer NULL,
    // so it no longer matches the sweeper's WHERE clause at all.
    expect(await sweeper.pollOnce()).toBe(0);

    // Directly verify BullMQ itself would also have deduped a same-jobId
    // re-add, independent of the sweeper's own WHERE-clause filtering.
    const queuedJob = await queueManager.queue('parse').getJob(jobId);
    expect(queuedJob).not.toBeNull();
  });

  it('recovers a NON-parse_book job type generically, from the envelope on the row', async () => {
    sweeperErrors.length = 0;
    // The sweeper used to be hard-coded to parse_book, because no other job
    // type's payload could be reconstructed from the row (F-4). Now every
    // service persists the envelope it intends to dispatch, so any job type is
    // recoverable. `assemble_chapter` on the `audio` queue exercises a
    // different type, queue and payload shape than everything above.
    const jobId = generateId();
    const correlationId = generateId();
    const chapterId = generateId();
    const staleCreatedAt = new Date(Date.now() - 60_000);

    await prisma.processingJob.create({
      data: {
        id: jobId,
        tenantId,
        bookId,
        type: 'assemble_chapter',
        queue: 'audio',
        priority: 'NORMAL',
        relatedResourceType: 'chapter',
        relatedResourceId: chapterId,
        status: 'CREATED',
        statusChangedAt: staleCreatedAt,
        createdAt: staleCreatedAt,
        maxAttempts: 3,
        idempotencyKey: `assemble_chapter:${chapterId}:sweeper-generic-test`,
        idempotencyFingerprint: 'c'.repeat(64),
        correlationId,
        dispatchEnvelope: {
          job_id: jobId,
          entity_id: jobId,
          correlation_id: correlationId,
          tenant_id: tenantId,
          payload: { chapter_id: chapterId },
        },
      },
    });

    const swept = await sweeper.pollOnce();
    expect(swept, `sweeper errors: ${sweeperErrors.map(String).join(' | ')}`).toBe(1);

    const after = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(after.queuedAt).not.toBeNull();

    // It must land on the queue the ROW names, with the row's own payload --
    // not on `parse`, and not with a payload the sweeper invented.
    const queued = await queueManager.queue('audio').getJob(jobId);
    expect(queued).not.toBeNull();
    expect((queued!.data as QueueJobEnvelope<{ chapter_id: string }>).payload).toEqual({
      chapter_id: chapterId,
    });
    expect(queued!.name).toBe('assemble_chapter');

    await queued!.remove().catch(() => undefined);
  });

  it('skips a job with no persisted envelope rather than inventing a payload', async () => {
    // A row predating the column, or one that is not queue-dispatched at all.
    // Guessing a payload here would dispatch a job the service never described,
    // so the sweeper must leave it alone -- and leave queued_at NULL, so the
    // row stays visibly unresolved instead of looking dispatched.
    const jobId = generateId();
    const staleCreatedAt = new Date(Date.now() - 60_000);

    await prisma.processingJob.create({
      data: {
        id: jobId,
        tenantId,
        bookId,
        type: 'parse_book',
        queue: 'parse',
        priority: 'NORMAL',
        relatedResourceType: 'book_file',
        relatedResourceId: bookFileId,
        status: 'CREATED',
        statusChangedAt: staleCreatedAt,
        createdAt: staleCreatedAt,
        maxAttempts: 3,
        idempotencyKey: `parse:${bookFileId}:sweeper-no-envelope-test`,
        idempotencyFingerprint: 'd'.repeat(64),
        correlationId: generateId(),
        // dispatchEnvelope deliberately absent.
      },
    });

    expect(await sweeper.pollOnce()).toBe(0);

    const after = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(after.queuedAt).toBeNull();
    expect(after.status).toBe('CREATED');
  });
});
