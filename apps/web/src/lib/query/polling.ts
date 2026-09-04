/**
 * Adaptive polling (Phase 9 rules 43, 44, 88).
 *
 * `api-usage-guide.md` §7 is explicit that **polling is the baseline and is
 * always sufficient**, and that SSE exists only to spare the client a *fast*
 * poll. This app therefore does both, and the intervals reflect it:
 *
 *  - When a live stream is attached, polling drops to a slow backstop. The
 *    stream drives freshness; the poll only catches a stream that died quietly.
 *  - When nothing is running, polling stops entirely rather than idling at a
 *    fixed rate.
 *  - Polling never runs in a hidden tab (TanStack Query's default), which is
 *    what keeps ten open project tabs from behaving like ten users.
 *
 * The numbers are deliberately conservative: the `read` rate-limit bucket is
 * per user *and* per tenant, so a studio with several projects open must not
 * spend a tenant's budget on progress bars.
 */

export interface PollingInput {
  /** Whether the backend reports work actively in flight. */
  active: boolean;
  /** Whether an SSE stream is currently connected for this resource. */
  streaming: boolean;
  /** Whether the resource has reached a terminal state and cannot change. */
  terminal?: boolean;
}

export const POLL_INTERVALS = {
  /** Active work, no stream: the fastest this app ever polls. */
  activeUnstreamed: 5_000,
  /** Active work with a live stream: a backstop, not the freshness mechanism. */
  activeStreamed: 30_000,
  /** Nothing running, but the state can still change from elsewhere. */
  idle: 60_000,
} as const;

export function pollInterval(input: PollingInput): number | false {
  if (input.terminal) return false;
  if (input.active) {
    return input.streaming ? POLL_INTERVALS.activeStreamed : POLL_INTERVALS.activeUnstreamed;
  }
  return input.streaming ? false : POLL_INTERVALS.idle;
}
