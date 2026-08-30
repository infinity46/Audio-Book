import { Controller, Get, Header, HttpCode, Inject, Res, UseGuards } from '@nestjs/common';
import type { PrismaClient } from '@audio-book/database';
import { pingDatabase } from '@audio-book/database';
import { composeReadiness } from '@audio-book/observability';
import type { MetricsRegistry } from '@audio-book/observability';
import type { StorageProvider } from '@audio-book/storage';
import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { MetricsAuthGuard } from '../common/guards/metrics-auth.guard.js';
import { METRICS, PRISMA, REDIS, STORAGE_PROVIDER } from '../common/tokens.js';

/**
 * Exact health surface from api-specification.md §19. None of these routes
 * are exposed through the public ingress — only reachable internally /
 * by the orchestrator's health-check probes and authenticated scrapers.
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(METRICS) private readonly metrics: MetricsRegistry,
  ) {}

  /** Liveness only — never touches DB/Redis/storage. */
  @Get('health')
  @HttpCode(200)
  liveness(): { status: 'alive' } {
    return { status: 'alive' };
  }

  /** Readiness — cheap dependency checks, 503 + reason_code (never naming the dependency) on failure. */
  @Get('ready')
  async readiness(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ status: string; reason_code?: string }> {
    const result = await composeReadiness(this.dependencyChecks());
    if (result.status !== 'ready') {
      reply.status(503).header('Retry-After', '5');
    }
    return { status: result.status, reason_code: result.reason_code };
  }

  /** Per-dependency detail — service-token gated, never public. */
  @UseGuards(MetricsAuthGuard)
  @Get('health/dependencies')
  async dependencies(): Promise<{ status: string; dependencies: Record<string, boolean> }> {
    const result = await composeReadiness(this.dependencyChecks());
    return { status: result.status, dependencies: result.dependencies };
  }

  /** Prometheus scrape endpoint — service-token gated, never public. */
  @UseGuards(MetricsAuthGuard)
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async metricsText(): Promise<string> {
    return this.metrics.toPrometheusText();
  }

  private dependencyChecks() {
    return [
      { name: 'database', check: () => pingDatabase(this.prisma) },
      { name: 'redis', check: async () => (await this.redis.ping()) === 'PONG' },
      { name: 'storage', check: () => this.storage.ping() },
    ];
  }
}
