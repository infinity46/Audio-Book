import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../common/tokens.js';

export type UploadSessionStatus =
  'AWAITING_UPLOAD' | 'UPLOADING' | 'VALIDATING' | 'ADMITTED' | 'REJECTED' | 'EXPIRED';

export interface UploadSessionRecord {
  id: string;
  tenantId: string;
  bookId: string;
  status: UploadSessionStatus;
  sourceKind: 'PDF' | 'EPUB';
  fileName: string;
  declaredMimeType: string;
  declaredSizeBytes: number;
  declaredContentHash: { algorithm: 'SHA256'; value: string };
  storageKey: string;
  validation?: Record<string, unknown>;
  rejectionReasonCode?: string;
  bookFileId?: string;
  createdAt: string;
  expiresAt: string;
}

const TTL_SECONDS = 60 * 60; // 1 hour — sessions are ephemeral by design (task/database-schema.md OQ-DB-7).

function key(tenantId: string, sessionId: string): string {
  return `upload-session:${tenantId}:${sessionId}`;
}

/**
 * Upload sessions are intentionally NOT a database table (matches
 * api-specification.md §20.6 / database-schema.md's "ephemeral Redis
 * upload session" design) — they exist only long enough for the client to
 * PUT bytes to object storage and call completion; once admitted, the
 * durable record is the immutable `BookFile` row, not the session.
 */
@Injectable()
export class UploadSessionStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async create(record: UploadSessionRecord): Promise<void> {
    await this.redis.set(
      key(record.tenantId, record.id),
      JSON.stringify(record),
      'EX',
      TTL_SECONDS,
    );
  }

  async get(tenantId: string, sessionId: string): Promise<UploadSessionRecord | null> {
    const raw = await this.redis.get(key(tenantId, sessionId));
    return raw ? (JSON.parse(raw) as UploadSessionRecord) : null;
  }

  async update(record: UploadSessionRecord): Promise<void> {
    const ttl = await this.redis.ttl(key(record.tenantId, record.id));
    await this.redis.set(
      key(record.tenantId, record.id),
      JSON.stringify(record),
      'EX',
      ttl > 0 ? ttl : TTL_SECONDS,
    );
  }

  async delete(tenantId: string, sessionId: string): Promise<void> {
    await this.redis.del(key(tenantId, sessionId));
  }
}
