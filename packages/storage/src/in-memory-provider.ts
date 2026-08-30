import { Readable } from 'node:stream';
import { checksumBuffer } from './checksum.js';
import type {
  GetObjectResult,
  PutObjectInput,
  SignedUrlMethod,
  StorageObjectMeta,
  StorageProvider,
} from './provider.js';

/**
 * In-memory StorageProvider for unit tests only — never a production
 * implementation. Business code should never import this directly outside
 * of test setup.
 */
export class InMemoryStorageProvider implements StorageProvider {
  private readonly objects = new Map<string, { body: Buffer; meta: StorageObjectMeta }>();

  constructor(private readonly bucket: string = 'test-bucket') {}

  put(input: PutObjectInput): Promise<StorageObjectMeta> {
    const body = Buffer.from(input.body);
    const checksum = checksumBuffer(body);
    const meta: StorageObjectMeta = {
      key: input.key,
      bucket: this.bucket,
      sizeBytes: checksum.sizeBytes,
      contentType: input.contentType,
      checksum,
    };
    this.objects.set(input.key, { body, meta });
    return Promise.resolve(meta);
  }

  get(key: string): Promise<GetObjectResult> {
    const entry = this.objects.get(key);
    if (!entry) return Promise.reject(new Error(`Object not found: ${key}`));
    return Promise.resolve({ body: Readable.from(entry.body), meta: entry.meta });
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }

  head(key: string): Promise<StorageObjectMeta | null> {
    return Promise.resolve(this.objects.get(key)?.meta ?? null);
  }

  getSignedUrl(key: string, method: SignedUrlMethod): Promise<string> {
    return Promise.resolve(`https://test-storage.local/${this.bucket}/${key}?method=${method}`);
  }

  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
