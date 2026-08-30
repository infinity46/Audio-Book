/**
 * Full-jitter exponential backoff, exact formula from event-contracts.md
 * §21.4: delay(attempt) = random_between(0, min(base * 2^(attempt-1), ceiling))
 */
export function fullJitterBackoffMs(attempt: number, baseMs: number, ceilingMs: number): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(attempt - 1, 0), ceilingMs);
  return Math.floor(Math.random() * exponential);
}

/**
 * BullMQ custom backoff strategy adapter. `attemptsMade` is 1-based on the
 * first retry per BullMQ's contract.
 */
export function bullmqFullJitterBackoff(baseMs: number, ceilingMs: number) {
  return (attemptsMade: number): number => fullJitterBackoffMs(attemptsMade, baseMs, ceilingMs);
}
