import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

export interface Checksum {
  algorithm: 'SHA256';
  hash: string;
  sizeBytes: number;
}

/**
 * Computes SHA-256 + byte size for a buffer, consistently, so every artifact
 * type (uploads, generated audio, IR content, cover art) uses the same
 * checksum shape rather than each call site rolling its own.
 */
export function checksumBuffer(buffer: Buffer | Uint8Array): Checksum {
  const hash = createHash('sha256').update(buffer).digest('hex');
  return { algorithm: 'SHA256', hash, sizeBytes: buffer.byteLength };
}

/** Streams through the input once, computing the checksum without buffering it all in memory. */
export async function checksumStream(stream: Readable): Promise<Checksum> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
    hash.update(buf);
    sizeBytes += buf.byteLength;
  }
  return { algorithm: 'SHA256', hash: hash.digest('hex'), sizeBytes };
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function isValidSha256Hex(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value);
}
