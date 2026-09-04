import type { Redis } from 'ioredis';

/**
 * Cooperative cancellation (`event-contracts.md` §29, `context.md` §11.4).
 *
 * Cancellation is deliberately **not** a queued command (E-23): a `job.cancel`
 * message would queue behind the very work it is trying to stop, and on a
 * saturated GPU queue might not be delivered for hours. Instead the API writes
 * `processing_job.cancellation_requested` (the durable truth) and sets a Redis
 * flag (the fast path); workers poll the flag at unit boundaries and before
 * expensive steps, exit cleanly, and release partial artifacts as `CANCELLED`.
 *
 * The flag is a cache, never the authority. It carries a TTL so an abandoned
 * flag cannot accumulate, and a worker that finds Redis unavailable falls back
 * to the database column rather than assuming "not cancelled" — see
 * `isCancellationRequested`.
 */

/**
 * Keys are namespaced per tenant so that a key built from an id can never
 * address another tenant's job, and so an operator reading Redis can attribute
 * a flag without a database round-trip.
 */
export function cancellationFlagKey(tenantId: string, jobId: string): string {
  return `job:cancel:${tenantId}:${jobId}`;
}

/**
 * Long enough that a job queued behind a full GPU backlog still observes the
 * flag when it finally starts; short enough that flags for jobs that never run
 * expire rather than leak. `processing_job.cancellation_requested` remains the
 * durable record after expiry (§23.3 step 5).
 */
export const CANCELLATION_FLAG_TTL_SECONDS = 24 * 60 * 60;

export interface CancellationFlagStore {
  set(tenantId: string, jobId: string): Promise<void>;
  isSet(tenantId: string, jobId: string): Promise<boolean>;
  clear(tenantId: string, jobId: string): Promise<void>;
}

export class RedisCancellationFlags implements CancellationFlagStore {
  constructor(private readonly redis: Redis) {}

  async set(tenantId: string, jobId: string): Promise<void> {
    await this.redis.set(
      cancellationFlagKey(tenantId, jobId),
      '1',
      'EX',
      CANCELLATION_FLAG_TTL_SECONDS,
    );
  }

  async isSet(tenantId: string, jobId: string): Promise<boolean> {
    const value = await this.redis.get(cancellationFlagKey(tenantId, jobId));
    return value !== null;
  }

  async clear(tenantId: string, jobId: string): Promise<void> {
    await this.redis.del(cancellationFlagKey(tenantId, jobId));
  }
}

export interface CancellationCheckDeps {
  flags?: CancellationFlagStore;
  /** Durable fallback — reads `processing_job.cancellation_requested`. */
  readDurableFlag: (jobId: string) => Promise<boolean>;
}

/**
 * The check a worker performs at a unit boundary.
 *
 * Redis first (cheap, and the whole point of the fast path); the database is
 * consulted only when Redis says "no" is unavailable rather than "no". A Redis
 * outage must not silently disable cancellation — that would let a cancelled
 * 20-hour render keep burning GPU time with the user told it had stopped.
 */
export async function isCancellationRequested(
  deps: CancellationCheckDeps,
  tenantId: string,
  jobId: string,
): Promise<boolean> {
  if (deps.flags) {
    try {
      if (await deps.flags.isSet(tenantId, jobId)) return true;
      return false;
    } catch {
      // Fall through to the durable read below.
    }
  }
  return deps.readDurableFlag(jobId);
}
