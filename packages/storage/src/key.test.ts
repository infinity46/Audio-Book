import { describe, expect, it } from 'vitest';
import { buildStorageKey } from './key.js';

describe('buildStorageKey', () => {
  it('builds a tenant-prefixed key from validated segments', () => {
    const key = buildStorageKey({
      tenantId: 'tenant-1',
      segments: ['books', 'book-1', 'audio', 'chunks', 'chunk-1', 'v1.wav'],
    });
    expect(key).toBe('tenant-1/books/book-1/audio/chunks/chunk-1/v1.wav');
  });

  it('rejects path traversal attempts', () => {
    expect(() =>
      buildStorageKey({ tenantId: 'tenant-1', segments: ['..', '..', 'etc', 'passwd'] }),
    ).toThrow();
  });

  it('rejects segments smuggling a slash', () => {
    expect(() => buildStorageKey({ tenantId: 'tenant-1', segments: ['a/b'] })).toThrow();
  });
});
