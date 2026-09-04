import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatEstimate,
  formatProgress,
  formatTimecode,
} from './format';

/**
 * The rule under test is the one `api-usage-guide.md` §7 states and that a
 * naive UI gets wrong: **`null` is not `0`**.
 */
describe('formatProgress', () => {
  it('returns null — not "0%" — when the server could not measure progress', () => {
    // `total_units: null` means the denominator is unknowable yet. Rendering
    // 0% would claim a measurement the server explicitly declined to make.
    expect(formatProgress(null)).toBeNull();
    expect(formatProgress(undefined)).toBeNull();
  });

  it('renders a real zero as 0%', () => {
    expect(formatProgress(0)).toBe('0%');
  });

  it('converts the 0..1 float the API sends, not a percentage', () => {
    expect(formatProgress(0.58)).toBe('58%');
    expect(formatProgress(1)).toBe('100%');
  });

  it('never rounds up to 100% before the work is complete', () => {
    // 99.6% rounding to "100%" while a stage is still RUNNING is the classic
    // progress-bar lie.
    expect(formatProgress(0.996)).toBe('99%');
    expect(formatProgress(0.9999)).toBe('99%');
  });

  it('clamps out-of-range values instead of rendering them', () => {
    expect(formatProgress(1.5)).toBe('100%');
    expect(formatProgress(-1)).toBe('0%');
  });
});

describe('formatEstimate', () => {
  it('renders nothing when the server declined to estimate', () => {
    // confidence NONE means remaining_ms is null and the server refuses to
    // guess. The UI must not substitute one of its own.
    expect(formatEstimate({ remaining_ms: null, confidence: 'NONE' })).toBeNull();
    expect(formatEstimate({ remaining_ms: 5000, confidence: 'NONE' })).toBeNull();
  });

  it('labels a measured estimate as an estimate and never as a promise', () => {
    const text = formatEstimate({ remaining_ms: 9_420_000, confidence: 'LOW' });
    expect(text).toContain('Estimated');
    expect(text).toContain('remaining');
    expect(text).not.toMatch(/will finish|complete at|guaranteed/i);
  });
});

describe('formatDuration', () => {
  it('formats hours, minutes, and seconds at the right granularity', () => {
    expect(formatDuration(9_420_000)).toBe('2h 37m');
    expect(formatDuration(243_000)).toBe('4m 03s');
    expect(formatDuration(9_000)).toBe('9s');
  });

  it('returns null for unknown rather than a fake zero', () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
});

describe('formatTimecode', () => {
  it('drops the hour segment below an hour', () => {
    expect(formatTimecode(243_000)).toBe('4:03');
    expect(formatTimecode(3_843_000)).toBe('1:04:03');
  });

  it('shows a placeholder rather than 0:00 when the position is unknown', () => {
    expect(formatTimecode(null)).toBe('--:--');
  });
});

describe('formatBytes', () => {
  it('scales units and keeps a real zero distinct from unknown', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBeNull();
    // Values at or above 100 lose the decimal — "488 MB" reads better than
    // "488.3 MB" and the extra digit is noise at that magnitude.
    expect(formatBytes(512_000_000)).toBe('488 MB');
    expect(formatBytes(8_123_456)).toBe('7.7 MB');
  });
});
