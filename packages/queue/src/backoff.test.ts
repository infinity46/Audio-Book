import { describe, expect, it } from 'vitest';
import { fullJitterBackoffMs } from './backoff.js';

describe('fullJitterBackoffMs', () => {
  it('never exceeds the ceiling', () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const delay = fullJitterBackoffMs(attempt, 1000, 30_000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });

  it('grows the jitter ceiling exponentially with attempt before capping', () => {
    const samples = (attempt: number) =>
      Array.from({ length: 200 }, () => fullJitterBackoffMs(attempt, 100, 100_000));
    const maxAt1 = Math.max(...samples(1));
    const maxAt4 = Math.max(...samples(4));
    expect(maxAt4).toBeGreaterThan(maxAt1);
  });
});
