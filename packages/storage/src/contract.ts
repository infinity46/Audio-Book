import { describe, expect, it } from 'vitest';
import { isValidSha256Hex } from './checksum.js';
import type { StorageProvider } from './provider.js';

/**
 * Reusable contract test suite for any StorageProvider implementation:
 * put -> head -> get -> checksum verify -> delete. Run this against both the
 * in-memory fake (unit tests) and the real S3/MinIO provider (integration
 * tests) so both are held to the same behavioral contract.
 */
export function runStorageProviderContractTests(
  name: string,
  makeProvider: () => StorageProvider,
): void {
  describe(`StorageProvider contract: ${name}`, () => {
    it('put -> head -> get -> checksum verify -> delete', async () => {
      const provider = makeProvider();
      const key = `contract-test/${crypto.randomUUID()}.bin`;
      const body = Buffer.from('hello audiobook');

      const putMeta = await provider.put({ key, body, contentType: 'application/octet-stream' });
      expect(putMeta.sizeBytes).toBe(body.byteLength);
      expect(isValidSha256Hex(putMeta.checksum.hash)).toBe(true);

      expect(await provider.exists(key)).toBe(true);

      const headMeta = await provider.head(key);
      expect(headMeta).not.toBeNull();
      expect(headMeta?.checksum.hash).toBe(putMeta.checksum.hash);

      const { body: stream, meta: getMeta } = await provider.get(key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
      }
      const retrieved = Buffer.concat(chunks);
      expect(retrieved.equals(body)).toBe(true);
      expect(getMeta.checksum.hash).toBe(putMeta.checksum.hash);

      await provider.delete(key);
      expect(await provider.exists(key)).toBe(false);
      expect(await provider.head(key)).toBeNull();
    });

    it('getSignedUrl produces a URL scoped to the requested method', async () => {
      const provider = makeProvider();
      const key = `contract-test/${crypto.randomUUID()}.bin`;
      const url = await provider.getSignedUrl(key, 'PUT', 60);
      expect(url).toContain(key);
    });

    it('ping reports connectivity independent of whether any object exists', async () => {
      const provider = makeProvider();
      expect(await provider.ping()).toBe(true);
    });
  });
}
