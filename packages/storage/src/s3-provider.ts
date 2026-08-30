import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import { checksumBuffer } from './checksum.js';
import type {
  GetObjectResult,
  PutObjectInput,
  SignedUrlMethod,
  StorageObjectMeta,
  StorageProvider,
} from './provider.js';

export interface S3StorageProviderOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** S3-compatible implementation — works against real S3 or MinIO (local dev) via the same client config. */
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StorageProviderOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(input: PutObjectInput): Promise<StorageObjectMeta> {
    const checksum = checksumBuffer(input.body);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        // Stored as custom object metadata (x-amz-meta-sha256-checksum),
        // read back on head()/get() — NOT via S3's native ChecksumSHA256
        // request/response fields. That native feature needs
        // `ChecksumMode: 'ENABLED'` on HeadObject to even echo back, and its
        // support is inconsistent across S3-compatible providers (MinIO
        // does not reliably return it), so it silently produced an empty
        // checksum in practice. Custom metadata is universally supported.
        Metadata: { 'sha256-checksum': checksum.hash },
      }),
    );
    return {
      key: input.key,
      bucket: this.bucket,
      sizeBytes: checksum.sizeBytes,
      contentType: input.contentType,
      checksum,
    };
  }

  async get(key: string): Promise<GetObjectResult> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const meta = await this.head(key);
    if (!meta) {
      throw new Error(`Object metadata unavailable immediately after GET for key: ${key}`);
    }
    return { body: result.Body as Readable, meta };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async head(key: string): Promise<StorageObjectMeta | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const sizeBytes = result.ContentLength ?? 0;
      const hash = result.Metadata?.['sha256-checksum'] ?? '';
      return {
        key,
        bucket: this.bucket,
        sizeBytes,
        contentType: result.ContentType ?? 'application/octet-stream',
        checksum: { algorithm: 'SHA256', hash, sizeBytes },
      };
    } catch (err) {
      if (err instanceof NotFound) return null;
      throw err;
    }
  }

  async getSignedUrl(
    key: string,
    method: SignedUrlMethod,
    expiresInSeconds: number,
  ): Promise<string> {
    const command =
      method === 'GET'
        ? new GetObjectCommand({ Bucket: this.bucket, Key: key })
        : new PutObjectCommand({ Bucket: this.bucket, Key: key });
    return presign(this.client, command, { expiresIn: expiresInSeconds });
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}
