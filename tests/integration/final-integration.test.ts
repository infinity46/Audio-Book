import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPrismaClient,
  disconnectPrisma,
  withTransaction,
  type PrismaClient,
} from '@audio-book/database';
import { generateId, OutboxPublisher, writeOutboxMessage } from '@audio-book/events';
import { QueueManager, type QueueJobEnvelope } from '@audio-book/queue';
import {
  processMaintenanceJob,
  type MaintenanceEventPayload,
} from '@audio-book/worker-cpu/processors/maintenance';

/**
 * Phase 1 final integration test (task §76): proves the whole infrastructure
 * spine end to end using a synthetic `cleanup_artifacts` ProcessingJob — no
 * real business logic (ingestion/Director/TTS) is involved.
 *
 *   Postgres tx (ProcessingJob row + outbox_message row) -> commit
 *     -> OutboxPublisher (FOR UPDATE SKIP LOCKED poll)
 *       -> Redis (BullMQ `maintenance` queue)
 *         -> worker-cpu's real processMaintenanceJob (same function the
 *            actual worker process runs, imported directly rather than
 *            reimplemented)
 *           -> Inbox-guarded processing -> ProcessingJob.status = SUCCEEDED
 *
 * This exercises the exact same OutboxPublisher/QueueManager/Inbox classes
 * apps/api and apps/worker-cpu use in production, just orchestrated
 * in-process instead of across two OS processes, so the test is
 * deterministic rather than racing against two separately-started servers.
 *
 * Requires Postgres + Redis reachable (see docker-compose.yml).
 */
describe('Final Phase 1 integration test: HTTP-shaped trigger -> Outbox -> Redis -> worker -> Inbox -> DB update', () => {
  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://audiobook:audiobook_dev_password@localhost:5432/audiobook';
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

  let prisma: PrismaClient;
  let tenantId: string;
  let queueManager: QueueManager;
  let publisher: OutboxPublisher;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl });
    tenantId = generateId();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Final Integration Test Tenant',
        status: 'ACTIVE',
        planCode: 'test',
      },
    });

    queueManager = new QueueManager({ redisUrl, backoff: { baseMs: 10, ceilingMs: 100 } });
  });

  afterAll(async () => {
    await publisher?.stop();
    await queueManager?.close();
    // FK order: eventInbox has no FK to tenant, but outboxMessage and
    // processingJob do — both must go before the tenant itself.
    await prisma.outboxMessage.deleteMany({ where: { tenantId } });
    await prisma.processingJob.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    await disconnectPrisma(prisma);
  });

  it('carries a synthetic cleanup_artifacts job through the entire spine', async () => {
    // ---- 1. "HTTP request" equivalent: create the domain row + outbox row
    //         in one transaction, exactly as MaintenanceTestController does.
    const jobId = generateId();
    const correlationId = generateId();
    const idempotencyKey = `cleanup_artifacts:${jobId}`;

    await withTransaction(prisma, async (tx) => {
      await tx.processingJob.create({
        data: {
          id: jobId,
          tenantId,
          type: 'cleanup_artifacts',
          queue: 'maintenance',
          priority: 'BULK',
          relatedResourceType: 'tenant',
          relatedResourceId: tenantId,
          status: 'CREATED',
          statusChangedAt: new Date(),
          maxAttempts: 3,
          idempotencyKey,
          idempotencyFingerprint: createHash('sha256').update(idempotencyKey).digest('hex'),
          correlationId,
        },
      });

      await writeOutboxMessage(tx, {
        eventType: 'job.created',
        schemaVersion: '1.0',
        tenantId,
        jobId,
        correlationId,
        causationId: correlationId,
        producer: 'test',
        producerVersion: '0.0.0',
        payload: { job_id: jobId, job_type: 'cleanup_artifacts', queue: 'maintenance' },
        aggregateType: 'processing_job',
        aggregateId: jobId,
      });
    });

    const outboxRowBeforePublish = await prisma.outboxMessage.findFirst({ where: { jobId } });
    expect(outboxRowBeforePublish?.status).toBe('PENDING');

    // ---- 2. worker-cpu's real consumer, wired exactly as apps/worker-cpu/src/main.ts wires it.
    const processed = new Promise<void>((resolve, reject) => {
      const worker = queueManager.createWorker<MaintenanceEventPayload>(
        'maintenance',
        async (job) => {
          const envelope: QueueJobEnvelope<MaintenanceEventPayload> = job.data;
          await processMaintenanceJob({ prisma, logger: silentLogger, envelope });
        },
        { concurrency: 1, maxAttempts: 3 },
      );
      worker.on('completed', () => resolve());
      worker.on('failed', (_job, err) => reject(err));
    });

    // ---- 3. OutboxPublisher: the only thing that crosses the Postgres/Redis boundary.
    publisher = new OutboxPublisher({
      prisma,
      pollIntervalMs: 100,
      batchSize: 10,
      publish: async (row) => {
        await queueManager.enqueue(
          'maintenance',
          {
            job_id: row.id,
            entity_id: row.aggregateId,
            correlation_id: row.correlationId,
            tenant_id: row.tenantId,
            payload: {
              event_id: row.eventId,
              event_type: row.eventType,
              schema_version: row.schemaVersion,
              payload: row.payload as MaintenanceEventPayload['payload'],
            },
          },
          { jobName: row.eventType, maxAttempts: 5 },
        );
      },
    });
    publisher.start();

    await processed;

    // ---- 4. Assert the full trail: outbox published, DB state updated, Inbox recorded.
    const outboxRowAfterPublish = await prisma.outboxMessage.findFirst({ where: { jobId } });
    expect(outboxRowAfterPublish?.status).toBe('PUBLISHED');

    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe('SUCCEEDED');
    expect(job.correlationId).toBe(correlationId);

    const inboxRow = await prisma.eventInbox.findUnique({
      where: {
        consumerName_eventId: {
          consumerName: 'worker-cpu:maintenance',
          eventId: outboxRowAfterPublish!.eventId,
        },
      },
    });
    expect(inboxRow?.outcome).toBe('PROCESSED');
  }, 20_000);

  it('redelivering the same event is a safe no-op (Inbox dedup)', async () => {
    const jobId = generateId();
    const correlationId = generateId();
    const idempotencyKey = `cleanup_artifacts:${jobId}`;

    await withTransaction(prisma, async (tx) => {
      await tx.processingJob.create({
        data: {
          id: jobId,
          tenantId,
          type: 'cleanup_artifacts',
          queue: 'maintenance',
          priority: 'BULK',
          relatedResourceType: 'tenant',
          relatedResourceId: tenantId,
          status: 'SUCCEEDED',
          statusChangedAt: new Date(),
          completedAt: new Date(),
          maxAttempts: 3,
          idempotencyKey,
          idempotencyFingerprint: createHash('sha256').update(idempotencyKey).digest('hex'),
          correlationId,
        },
      });
    });

    const eventId = randomUUID();
    const envelope: QueueJobEnvelope<MaintenanceEventPayload> = {
      job_id: 'redelivery-test',
      entity_id: jobId,
      correlation_id: correlationId,
      tenant_id: tenantId,
      payload: {
        event_id: eventId,
        event_type: 'job.created',
        schema_version: '1.0',
        payload: { job_id: jobId, job_type: 'cleanup_artifacts', queue: 'maintenance' },
      },
    };

    await processMaintenanceJob({ prisma, logger: silentLogger, envelope });
    // Redelivery — must not throw, must not double-process.
    await expect(
      processMaintenanceJob({ prisma, logger: silentLogger, envelope }),
    ).resolves.toBeUndefined();

    const inboxCount = await prisma.eventInbox.count({
      where: { consumerName: 'worker-cpu:maintenance', eventId },
    });
    expect(inboxCount).toBe(1);
  });
});

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Parameters<typeof processMaintenanceJob>[0]['logger'];
