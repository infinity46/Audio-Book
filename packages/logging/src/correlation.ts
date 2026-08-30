import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Threads correlation_id / job_id / worker_id across async boundaries within
 * a single process so every log line emitted during a request or job carries
 * them without having to pass them explicitly through every function call.
 *
 * This does NOT survive process boundaries by itself — crossing an HTTP call,
 * a BullMQ job payload, or an event envelope requires explicitly copying the
 * ids into that payload (see @audio-book/events) and re-entering this context
 * on the receiving side.
 */
export interface CorrelationContext {
  correlationId: string;
  causationId?: string;
  jobId?: string;
  workerId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function runWithCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}
