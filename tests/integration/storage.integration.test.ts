import { S3StorageProvider } from '@audio-book/storage';
import { runStorageProviderContractTests } from '@audio-book/storage/contract';

/**
 * Runs the shared StorageProvider contract suite (packages/storage/src/contract.ts)
 * against a real S3-compatible MinIO instance, proving put/head/get/checksum/delete
 * work end-to-end against real infrastructure — not just the in-memory fake used by
 * packages/storage's own unit tests. Requires docker-compose's `minio` (and
 * `minio-init`, to create the bucket) to be running, or the equivalent CI service
 * container (see .github/workflows/ci.yml `integration` job).
 */
runStorageProviderContractTests(
  'S3StorageProvider (MinIO)',
  () =>
    new S3StorageProvider({
      endpoint: process.env.STORAGE_ENDPOINT ?? 'http://localhost:9000',
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      bucket: process.env.STORAGE_BUCKET ?? 'audiobook-dev',
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'minioadmin',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'minioadmin',
      forcePathStyle: true,
    }),
);
