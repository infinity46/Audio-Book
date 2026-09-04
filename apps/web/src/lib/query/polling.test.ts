import { describe, expect, it } from 'vitest';
import { POLL_INTERVALS, pollInterval } from './polling';

/**
 * `api-usage-guide.md` §7: polling is the baseline, SSE only spares a *fast*
 * poll. The adaptive policy has to reflect that, and must never poll a
 * finished resource.
 */
describe('pollInterval', () => {
  it('polls fastest when work is running and no stream is attached', () => {
    expect(pollInterval({ active: true, streaming: false })).toBe(POLL_INTERVALS.activeUnstreamed);
  });

  it('backs off substantially once a live stream is carrying updates', () => {
    const streamed = pollInterval({ active: true, streaming: true });
    expect(streamed).toBe(POLL_INTERVALS.activeStreamed);
    expect(streamed).toBeGreaterThan(POLL_INTERVALS.activeUnstreamed);
  });

  it('stops polling entirely when idle and streaming', () => {
    expect(pollInterval({ active: false, streaming: true })).toBe(false);
  });

  it('keeps a slow poll when idle without a stream — state can change elsewhere', () => {
    expect(pollInterval({ active: false, streaming: false })).toBe(POLL_INTERVALS.idle);
  });

  it('never polls a terminal resource', () => {
    expect(pollInterval({ active: true, streaming: false, terminal: true })).toBe(false);
  });

  it('never polls faster than five seconds', () => {
    // The `read` rate-limit bucket is per user *and* per tenant; several open
    // project tabs must not spend a tenant's budget on progress bars.
    const fastest = Math.min(
      ...[true, false].flatMap((streaming) =>
        [true, false].map((active) => {
          const value = pollInterval({ active, streaming });
          return value === false ? Infinity : value;
        }),
      ),
    );
    expect(fastest).toBeGreaterThanOrEqual(5000);
  });
});
