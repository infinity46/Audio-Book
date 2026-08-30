import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { buildApiConfig } from '@audio-book/config';
import { disconnectPrisma, type PrismaClient } from '@audio-book/database';
import type { QueueManager } from '@audio-book/queue';
import type { Redis } from 'ioredis';
import { AppModule } from './app.module.js';
import { LOGGER, PRISMA, QUEUE_MANAGER, REDIS } from './common/tokens.js';
import type { Logger } from '@audio-book/logging';

async function bootstrap(): Promise<void> {
  const config = buildApiConfig();

  const adapter = new FastifyAdapter({
    bodyLimit: config.http.bodySizeLimitBytes,
    trustProxy: true,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  app.enableCors({
    origin: config.http.corsAllowedOrigins,
    credentials: true,
  });

  // Default to no-store on every authenticated response; individual routes
  // may override this explicitly if they ever need to be cacheable.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (_req, reply, payload, done) => {
      if (!reply.getHeader('Cache-Control')) {
        reply.header('Cache-Control', 'no-store');
      }
      done(null, payload);
    });

  await app.listen(config.http.port, '0.0.0.0');

  const logger = app.get<Logger>(LOGGER);
  logger.info({ port: config.http.port }, `${config.app.serviceName} listening`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Received shutdown signal — starting graceful shutdown');
    try {
      // 1. Stop accepting new HTTP work. This also runs Nest's module
      //    lifecycle (ProvidersModule.onModuleDestroy), which stops the
      //    OutboxPublisher's poll loop before we tear down its dependencies.
      await app.close();
      // 2. Drain queue workers/connections.
      const queueManager = app.get<QueueManager>(QUEUE_MANAGER, { strict: false });
      await queueManager?.close();
      // 3. Close DB/Redis.
      const prisma = app.get<PrismaClient>(PRISMA, { strict: false });
      if (prisma) await disconnectPrisma(prisma);
      const redis = app.get<Redis>(REDIS, { strict: false });
      redis?.disconnect();
      logger.info({ signal }, 'Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal error during bootstrap:', err);
  process.exit(1);
});
