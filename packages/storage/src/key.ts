/**
 * Centralized object-storage key construction. Per context.md §12.3, every
 * key is tenant-prefixed and built server-side from validated identifiers —
 * never from a user-supplied filename (path traversal boundary, api-spec
 * §18.3 / context.md §18.3). Business services should always go through this
 * builder rather than concatenating strings themselves.
 */

const SAFE_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/;

export interface StorageKeyInput {
  tenantId: string;
  /** Path segments after the tenant prefix, e.g. ['books', bookId, 'audio', 'chunks', chunkId, 'v1.wav']. */
  segments: string[];
}

export function buildStorageKey({ tenantId, segments }: StorageKeyInput): string {
  if (!SAFE_SEGMENT_PATTERN.test(tenantId)) {
    throw new Error(`Invalid tenantId for storage key: ${tenantId}`);
  }
  for (const segment of segments) {
    if (segment.includes('..') || segment.includes('/') || !SAFE_SEGMENT_PATTERN.test(segment)) {
      throw new Error(`Invalid storage key segment: ${segment}`);
    }
  }
  return [tenantId, ...segments].join('/');
}
