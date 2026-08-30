/**
 * The five queues per event-contracts.md §4.1 / §12 — partitioned by
 * runtime/scaling profile, not business domain. No other queue names exist;
 * adding one is an architecture change, not a Phase 1 implementation detail.
 */
export const QUEUE_NAMES = ['parse', 'ai', 'gpu', 'audio', 'maintenance'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export function isQueueName(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}

/** BullMQ queue names may not contain `:` (it's used internally as BullMQ's own Redis key separator). */
export function dlqName(name: QueueName): string {
  return `${name}-dlq`;
}
