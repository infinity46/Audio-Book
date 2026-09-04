import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@audio-book/database';
import { processMaintenanceJob } from './maintenance.js';

function makeMockPrisma() {
  const eventInboxRows = new Map<string, boolean>();
  const processingJobUpdates: unknown[] = [];

  const mockTx = {
    eventInbox: {
      create: vi.fn(({ data }: { data: { consumerName: string; eventId: string } }) => {
        const key = `${data.consumerName}:${data.eventId}`;
        if (eventInboxRows.has(key)) {
          // Real code path throws Prisma's own error class — match it here so
          // this mock actually exercises inbox.ts's `instanceof` check rather
          // than a shape that only looks similar.
          throw new Prisma.PrismaClientKnownRequestError('duplicate key', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        eventInboxRows.set(key, true);
        return Promise.resolve();
      }),
    },
    processingJob: {
      update: vi.fn((args: unknown) => {
        processingJobUpdates.push(args);
        return Promise.resolve();
      }),
    },
  };

  const prisma = {
    $transaction: vi.fn((fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
  };

  return { prisma, processingJobUpdates };
}

describe('processMaintenanceJob', () => {
  it('processes a cleanup_artifacts event exactly once and marks the job SUCCEEDED', async () => {
    const { prisma, processingJobUpdates } = makeMockPrisma();
    const logger = { info: vi.fn() } as unknown as Parameters<
      typeof processMaintenanceJob
    >[0]['logger'];

    await processMaintenanceJob({
      prisma: prisma as never,
      storage: {} as never,
      logger,
      envelope: {
        job_id: 'outbox-msg-1',
        entity_id: 'processing-job-1',
        correlation_id: 'corr-1',
        tenant_id: 'tenant-1',
        payload: {
          event_id: 'event-1',
          event_type: 'job.created',
          schema_version: '1.0',
          payload: {
            job_id: 'processing-job-1',
            job_type: 'cleanup_artifacts',
            queue: 'maintenance',
          },
        },
      },
    });

    expect(processingJobUpdates).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'PROCESSED' }),
      expect.any(String),
    );
  });

  it('safely skips a redelivered event without a duplicate side effect', async () => {
    const { prisma, processingJobUpdates } = makeMockPrisma();
    const logger = { info: vi.fn() } as unknown as Parameters<
      typeof processMaintenanceJob
    >[0]['logger'];
    const envelope = {
      job_id: 'outbox-msg-1',
      entity_id: 'processing-job-1',
      correlation_id: 'corr-1',
      tenant_id: 'tenant-1',
      payload: {
        event_id: 'event-1',
        event_type: 'job.created' as const,
        schema_version: '1.0',
        payload: {
          job_id: 'processing-job-1',
          job_type: 'cleanup_artifacts',
          queue: 'maintenance',
        },
      },
    };

    await processMaintenanceJob({ prisma: prisma as never, storage: {} as never, logger, envelope });
    await processMaintenanceJob({ prisma: prisma as never, storage: {} as never, logger, envelope });

    expect(processingJobUpdates).toHaveLength(1);
    expect(logger.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'SKIPPED' }),
      expect.any(String),
    );
  });

  it('throws when the envelope is missing entity_id', async () => {
    const { prisma } = makeMockPrisma();
    const logger = { info: vi.fn() } as unknown as Parameters<
      typeof processMaintenanceJob
    >[0]['logger'];

    await expect(
      processMaintenanceJob({
        prisma: prisma as never,
        storage: {} as never,
        logger,
        envelope: {
          job_id: 'outbox-msg-1',
          correlation_id: 'corr-1',
          tenant_id: 'tenant-1',
          payload: {
            event_id: 'event-1',
            event_type: 'job.created',
            schema_version: '1.0',
            payload: { job_id: '', job_type: 'cleanup_artifacts', queue: 'maintenance' },
          },
        },
      }),
    ).rejects.toThrow(/entity_id/);
  });
});
