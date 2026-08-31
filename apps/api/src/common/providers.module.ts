import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { buildApiConfig, type ApiConfig } from '@audio-book/config';
import { createPrismaClient, disconnectPrisma, type PrismaClient } from '@audio-book/database';
import { OutboxPublisher, type ClaimedOutboxRow } from '@audio-book/events';
import { createLogger, logError, type Logger } from '@audio-book/logging';
import { MetricsRegistry } from '@audio-book/observability';
import { QueueManager } from '@audio-book/queue';
import { S3StorageProvider, type StorageProvider } from '@audio-book/storage';
import { Redis } from 'ioredis';
import { IdempotencyService } from './idempotency.service.js';
import {
  API_CONFIG,
  LOGGER,
  METRICS,
  OUTBOX_PUBLISHER,
  PRISMA,
  QUEUE_MANAGER,
  REDIS,
  STORAGE_PROVIDER,
} from './tokens.js';

const configProvider = {
  provide: API_CONFIG,
  useFactory: (): ApiConfig => buildApiConfig(),
};

const loggerProvider = {
  provide: LOGGER,
  useFactory: (config: ApiConfig): Logger =>
    createLogger({
      serviceName: config.app.serviceName,
      environment: config.app.nodeEnv,
      logLevel: config.app.logLevel,
      pretty: config.app.nodeEnv === 'development',
    }),
  inject: [API_CONFIG],
};

const metricsProvider = {
  provide: METRICS,
  useFactory: (config: ApiConfig): MetricsRegistry => new MetricsRegistry(config.app.serviceName),
  inject: [API_CONFIG],
};

const prismaProvider = {
  provide: PRISMA,
  useFactory: (config: ApiConfig): PrismaClient =>
    createPrismaClient({
      databaseUrl: config.secrets.databaseUrl,
      poolMax: config.databasePool.max,
    }),
  inject: [API_CONFIG],
};

const redisProvider = {
  provide: REDIS,
  useFactory: (config: ApiConfig): Redis =>
    new Redis(config.secrets.redisUrl, { maxRetriesPerRequest: 3 }),
  inject: [API_CONFIG],
};

const queueManagerProvider = {
  provide: QUEUE_MANAGER,
  useFactory: (config: ApiConfig): QueueManager =>
    new QueueManager({ redisUrl: config.secrets.redisUrl }),
  inject: [API_CONFIG],
};

const storageProvider = {
  provide: STORAGE_PROVIDER,
  useFactory: (config: ApiConfig): StorageProvider => new S3StorageProvider(config.secrets.storage),
  inject: [API_CONFIG],
};

/**
 * Phase 1's OutboxPublisher.publish transport relayed EVERY outbox row onto
 * the `maintenance` BullMQ queue as an event-shaped job, because the only
 * outbox row ever produced at the time was the synthetic `job.created`
 * (`cleanup_artifacts`) row the Phase 1 integration test creates —
 * `processMaintenanceJob` unconditionally treats that row's `entity_id` as
 * a ProcessingJob id and marks it SUCCEEDED. Phase 2 introduces real
 * domain events (`book.uploaded`, `book.parsed`, `book.parse_failed`,
 * `book.structure_ready`) whose `entity_id`/aggregate is NOT a
 * ProcessingJob id — routing those through the same path would silently
 * flip the status of an unrelated job. There is no real event-broadcast
 * consumer for domain events yet (no Director, no SSE — later phases), so
 * they are acknowledged (marked PUBLISHED) without being forwarded
 * anywhere: the Outbox's job here is durability, not fabricating a
 * distribution mechanism that doesn't exist. The one existing test path
 * keeps working unchanged.
 */
const outboxPublisherProvider = {
  provide: OUTBOX_PUBLISHER,
  useFactory: (
    prisma: PrismaClient,
    queueManager: QueueManager,
    config: ApiConfig,
    logger: Logger,
  ): OutboxPublisher =>
    new OutboxPublisher({
      prisma,
      pollIntervalMs: config.outboxPublisher.pollIntervalMs,
      batchSize: config.outboxPublisher.batchSize,
      publish: async (row: ClaimedOutboxRow) => {
        const payload = row.payload as { job_type?: string } | undefined;
        if (row.eventType === 'job.created' && payload?.job_type === 'cleanup_artifacts') {
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
                payload: row.payload,
              },
            },
            { jobName: row.eventType, maxAttempts: 5 },
          );
          return;
        }

        logger.info(
          { event_id: row.eventId, event_type: row.eventType, book_id: row.bookId },
          'Outbox event durably published (no downstream broadcast consumer yet)',
        );
      },
      onError: (err) => logError(logger, err, 'Outbox publish failed for a batch row'),
    }),
  inject: [PRISMA, QUEUE_MANAGER, API_CONFIG, LOGGER],
};

const idempotencyServiceProvider = IdempotencyService;

/**
 * Global module wiring every shared infrastructure dependency exactly once
 * per process (config, logger, metrics, Prisma, Redis, queue manager,
 * storage) — business modules inject these by token rather than
 * constructing their own.
 */
@Global()
@Module({
  providers: [
    configProvider,
    loggerProvider,
    metricsProvider,
    prismaProvider,
    redisProvider,
    queueManagerProvider,
    storageProvider,
    outboxPublisherProvider,
    idempotencyServiceProvider,
  ],
  exports: [
    API_CONFIG,
    LOGGER,
    METRICS,
    PRISMA,
    REDIS,
    QUEUE_MANAGER,
    STORAGE_PROVIDER,
    OUTBOX_PUBLISHER,
    IdempotencyService,
  ],
})
// Graceful shutdown (stop intake -> drain -> close DB/Redis/queue -> flush
// logs -> exit) is orchestrated from main.ts's SIGTERM handler, which holds
// direct references to these instances and can sequence the shutdown
// correctly. The OutboxPublisher is the one exception — it must start
// polling as soon as the app is up, so that starts here.
export class ProvidersModule implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(@Inject(OUTBOX_PUBLISHER) private readonly outboxPublisher: OutboxPublisher) {}

  onApplicationBootstrap(): void {
    this.outboxPublisher.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.outboxPublisher.stop();
  }
}

export { disconnectPrisma };
