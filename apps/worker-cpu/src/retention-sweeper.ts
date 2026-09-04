import type { PrismaClient } from '@audio-book/database';
import type { Logger } from '@audio-book/logging';
import type { StorageProvider } from '@audio-book/storage';
import { runRetentionSweep, type RetentionSweepConfig } from './processors/maintenance.js';

export interface RetentionSweeperDeps {
  prisma: PrismaClient;
  storage: StorageProvider;
  logger: Logger;
  config: RetentionSweepConfig;
  intervalMs: number;
  onError?: (err: unknown) => void;
}

/**
 * Runs `runRetentionSweep` on a timer. Mirrors `ProcessingJobSweeper`'s
 * `start()`/`stop()`/`setTimeout`-loop shape deliberately — this is the same
 * class of concern (in-process periodic maintenance, one instance per
 * worker replica), not a `ProcessingJob`/queue-dispatched operation:
 * retention is cross-tenant by nature (§27.5 gives no single tenant to
 * attribute the sweep to), and every `ProcessingJob` row in this schema
 * requires a `tenant_id` — forcing this into that table would mean picking
 * an arbitrary owning tenant for a scan that touches every tenant, which is
 * worse than not using the table at all.
 */
export class RetentionSweeper {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<unknown> | undefined;

  constructor(private readonly deps: RetentionSweeperDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(this.deps.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = runRetentionSweep(this.deps.prisma, this.deps.storage, this.deps.logger, this.deps.config)
        .catch((err: unknown) => this.deps.onError?.(err))
        .finally(() => this.scheduleNext(this.deps.intervalMs));
    }, delayMs);
  }
}
