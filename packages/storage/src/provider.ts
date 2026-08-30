import type { Readable } from 'node:stream';
import type { Checksum } from './checksum.js';

export interface StorageObjectMeta {
  key: string;
  bucket: string;
  sizeBytes: number;
  contentType: string;
  checksum: Checksum;
}

export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
}

export interface GetObjectResult {
  body: Readable;
  meta: StorageObjectMeta;
}

export type SignedUrlMethod = 'GET' | 'PUT';

/**
 * Provider-neutral object storage boundary. Business code must depend only
 * on this interface — never import an S3/MinIO SDK directly — so the
 * production provider can change without touching call sites. Large binary
 * artifacts (PDFs, EPUBs, images, audio, voice references, embeddings)
 * always go through here; they must never pass through Redis or a database
 * row.
 */
export interface StorageProvider {
  put(input: PutObjectInput): Promise<StorageObjectMeta>;
  get(key: string): Promise<GetObjectResult>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  head(key: string): Promise<StorageObjectMeta | null>;
  getSignedUrl(key: string, method: SignedUrlMethod, expiresInSeconds: number): Promise<string>;
  /**
   * Lightweight connectivity/credentials check for readiness probes — verifies
   * the bucket is reachable, independent of whether any particular object
   * exists. Deliberately NOT the same thing as `exists(key)`: a healthy
   * connection legitimately returns `false` from `exists()` for a key that
   * simply hasn't been written yet, so using `exists()` on a sentinel key for
   * health checks conflates "object absent" with "storage unreachable."
   */
  ping(): Promise<boolean>;
}
