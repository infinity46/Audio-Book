import { createHash } from 'node:crypto';

/**
 * SHA-256 hex digest for text-shaped artifacts (paragraph/chapter/book
 * content, normalization config fingerprints). Matches the algorithm used
 * for binary artifacts in packages/storage/src/checksum.ts so every hash
 * column in the schema (all `char(64)` / `^[0-9a-f]{64}$`) is produced the
 * same way regardless of what's being hashed.
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable fingerprint of a config object, independent of key insertion order. */
export function configHash(config: unknown): string {
  return sha256Hex(stableStringify(config));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(',')}}`;
}
