import { describe, expect, it } from 'vitest';
import { configHash, sha256Hex } from './hashing.js';

describe('sha256Hex', () => {
  it('is deterministic for the same input', () => {
    expect(sha256Hex('hello world')).toBe(sha256Hex('hello world'));
  });

  it('produces a 64-char lowercase hex digest', () => {
    expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different input', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});

describe('configHash', () => {
  it('is independent of key insertion order', () => {
    const a = configHash({ x: 1, y: 2 });
    const b = configHash({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it('differs when a value changes', () => {
    expect(configHash({ x: 1 })).not.toBe(configHash({ x: 2 }));
  });
});
