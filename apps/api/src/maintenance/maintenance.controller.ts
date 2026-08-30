import { createHash } from 'node:crypto';
import { Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { PrismaClient } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import { generateId, writeOutboxMessage } from '@audio-book/events';
import { MetricsAuthGuard } from '../common/guards/metrics-auth.guard.js';
import { PRISMA } from '../common/tokens.js';

/**
 * Matches infra/scripts/seed.ts's dev tenant — this endpoint exists solely
 * to drive the Phase 1 final integration test (task §76: HTTP -> Postgres
 * tx (domain row + outbox row) -> commit -> Outbox Publisher -> Redis ->
 * worker -> Inbox -> processing -> DB update). `cleanup_artifacts` is a
 * real job_type/queue pairing from the architecture (event-contracts.md),
 * not a fabricated one — this is infrastructure plumbing, not a business
 * feature, and is gated behind the same service-token guard as /metrics
 * since it's an internal-only proof surface, not a public route.
 */
const DEV_TENANT_ID = '018f4e1a-dead-7000-8000-000000000001';

@Controller('internal/v1/test')
export class MaintenanceTestController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @UseGuards(MetricsAuthGuard)
  @Post('cleanup-jobs')
  @HttpCode(202)
  async triggerCleanupJob(): Promise<{ job_id: string; correlation_id: string }> {
    const jobId = generateId();
    const correlationId = generateId();
    const now = new Date();
    const idempotencyKey = `cleanup_artifacts:${jobId}`;

    await withTransaction(this.prisma, async (tx) => {
      await tx.processingJob.create({
        data: {
          id: jobId,
          tenantId: DEV_TENANT_ID,
          type: 'cleanup_artifacts',
          queue: 'maintenance',
          priority: 'BULK',
          relatedResourceType: 'tenant',
          relatedResourceId: DEV_TENANT_ID,
          status: 'CREATED',
          statusChangedAt: now,
          maxAttempts: 3,
          idempotencyKey,
          idempotencyFingerprint: createHash('sha256').update(idempotencyKey).digest('hex'),
          correlationId,
        },
      });

      await writeOutboxMessage(tx, {
        eventType: 'job.created',
        schemaVersion: '1.0',
        tenantId: DEV_TENANT_ID,
        jobId,
        correlationId,
        causationId: correlationId,
        producer: 'api',
        producerVersion: '0.0.0',
        payload: { job_id: jobId, job_type: 'cleanup_artifacts', queue: 'maintenance' },
        aggregateType: 'processing_job',
        aggregateId: jobId,
      });
    });

    return { job_id: jobId, correlation_id: correlationId };
  }
}
