import { describe, expect, it } from 'vitest';
import { withConnectionLimit } from './client.js';

describe('withConnectionLimit', () => {
  it('leaves the URL unchanged when no pool max is given', () => {
    const url = 'postgresql://user:pass@localhost:5432/audiobook';
    expect(withConnectionLimit(url)).toBe(url);
  });

  it('appends connection_limit when a pool max is given', () => {
    const url = withConnectionLimit('postgresql://user:pass@localhost:5432/audiobook', 10);
    expect(new URL(url).searchParams.get('connection_limit')).toBe('10');
  });
});
