import { withTransaction, type PrismaClient } from '@audio-book/database';
import { withInbox } from '@audio-book/events';
import type { Logger } from '@audio-book/logging';
import type { QueueJobEnvelope } from '@audio-book/queue';

export interface MaintenanceEventPayload {
  event_id: string;
  event_type: string;
  schema_version: string;
  payload: { job_id: string; job_type: string; queue: string };
}

export interface ProcessMaintenanceJobDeps {
  prisma: PrismaClient;
  logger: Logger;
  envelope: QueueJobEnvelope<MaintenanceEventPayload>;
}

/**
 * Consumes the `job.created` event the OutboxPublisher relayed for a
 * `cleanup_artifacts` ProcessingJob (see apps/api's MaintenanceTestController
 * and packages/events' OutboxPublisher). This is the Phase 1 final
 * integration test's proof of the queue -> worker -> Inbox -> DB-update
 * spine (task §76) — `cleanup_artifacts` is a real job_type/queue pairing
 * from the architecture, used here with no other business meaning attached.
 *
 * Inbox-guarded (event-contracts.md §20.2): at-least-once BullMQ delivery
 * means this can run more than once for the same event_id; withInbox makes
 * a redelivery a safe no-op rather than a duplicate state transition.
 */
export async function processMaintenanceJob({
  prisma,
  logger,
  envelope,
}: ProcessMaintenanceJobDeps): Promise<void> {
  const processingJobId = envelope.entity_id;
  if (!processingJobId) {
    throw new Error('maintenance event envelope is missing entity_id (the ProcessingJob id)');
  }

  const { outcome } = await withTransaction(prisma, (tx) =>
    withInbox(tx, 'worker-cpu:maintenance', envelope.payload.event_id, async () => {
      await tx.processingJob.update({
        where: { id: processingJobId },
        data: {
          status: 'SUCCEEDED',
          statusChangedAt: new Date(),
          completedAt: new Date(),
          progress: 1,
        },
      });
    }),
  );

  logger.info(
    { job_id: processingJobId, event_id: envelope.payload.event_id, outcome },
    outcome === 'SKIPPED'
      ? 'Duplicate maintenance event skipped (already processed)'
      : 'Processed cleanup_artifacts job',
  );
}
