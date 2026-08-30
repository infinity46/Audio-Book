import { buildWorkerConfig } from '@audio-book/config';
import { createPrismaClient, disconnectPrisma, pingDatabase } from '@audio-book/database';
import { createLogger, logError, runWithCorrelation } from '@audio-book/logging';
import { WorkerHealthStateMachine } from '@audio-book/observability';
import { QueueManager, type QueueJobEnvelope } from '@audio-book/queue';
import { S3StorageProvider } from '@audio-book/storage';
import { Redis } from 'ioredis';
import { startHealthServer } from './health-server.js';
import { processMaintenanceJob, type MaintenanceEventPayload } from './processors/maintenance.js';

// Setup below is synchronous, but main() stays async so `main().catch(...)`
// below catches synchronous throws the same way it catches rejected
// promises from future awaited setup steps.
// eslint-disable-next-line @typescript-eslint/require-await
async function main(): Promise<void> {
  const config = buildWorkerConfig();
  const logger = createLogger({
    serviceName: config.app.serviceName,
    environment: config.app.nodeEnv,
    logLevel: config.app.logLevel,
    pretty: config.app.nodeEnv === 'development',
  });

  const stateMachine = new WorkerHealthStateMachine();

  const prisma = createPrismaClient({
    databaseUrl: config.secrets.databaseUrl,
    poolMax: config.databasePool.max,
  });
  const redis = new Redis(config.secrets.redisUrl, { maxRetriesPerRequest: 3 });
  const storage = new S3StorageProvider(config.secrets.storage);
  const queueManager = new QueueManager({ redisUrl: config.secrets.redisUrl });

  stateMachine.transition('HEALTHY');
  // worker-cpu runs deterministic, non-AI, non-GPU work — there is no model
  // to load, so it promotes straight to MODEL_READY (the generic
  // "ready to accept work" state in the shared health state machine) rather
  // than staying in HEALTHY. worker-ai/worker-gpu (Python) use this same
  // state name for an actual model-load step.
  stateMachine.transition('MODEL_READY');
  stateMachine.transition('IDLE');

  const healthServer = startHealthServer(
    Number(process.env.WORKER_HEALTH_PORT ?? 8080),
    stateMachine,
    [
      { name: 'database', check: () => pingDatabase(prisma) },
      { name: 'redis', check: async () => (await redis.ping()) === 'PONG' },
      { name: 'storage', check: () => storage.ping() },
    ],
  );

  const worker = queueManager.createWorker<MaintenanceEventPayload>(
    'maintenance',
    async (job) => {
      stateMachine.transition('PROCESSING');
      const envelope: QueueJobEnvelope<MaintenanceEventPayload> = job.data;
      try {
        await runWithCorrelation(
          {
            correlationId: envelope.correlation_id,
            jobId: envelope.job_id,
            workerId: config.app.serviceName,
          },
          () => processMaintenanceJob({ prisma, logger, envelope }),
        );
      } finally {
        stateMachine.transition('IDLE');
      }
    },
    { concurrency: config.worker.concurrency, maxAttempts: 3 },
  );

  worker.on('error', (err) => logError(logger, err, 'Worker error'));

  logger.info(
    { concurrency: config.worker.concurrency },
    `${config.app.serviceName} ready, consuming maintenance queue`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Received shutdown signal — starting graceful shutdown');
    stateMachine.transition('DRAINING');
    try {
      await queueManager.close();
      await disconnectPrisma(prisma);
      redis.disconnect();
      healthServer.close();
      stateMachine.transition('STOPPED');
      logger.info({ signal }, 'Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logError(logger, err, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('Fatal error during worker-cpu bootstrap:', err);
  process.exit(1);
});
