import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../common/tokens.js';

export interface CoverUploadSessionRecord {
  id: string;
  tenantId: string;
  bookId: string;
  audiobookId: string;
  declaredMimeType: string;
  declaredSizeBytes: number;
  declaredContentHash: { algorithm: 'SHA256'; value: string };
  storageKey: string;
  createdAt: string;
  expiresAt: string;
}

const TTL_SECONDS = 60 * 60;

function key(tenantId: string, sessionId: string): string {
  return `cover-upload-session:${tenantId}:${sessionId}`;
}

/**
 * Ephemeral Redis-backed session for the `PUT .../audiobooks/:id/cover`
 * two-phase upload (declare -> client PUTs bytes to the signed target ->
 * confirm), mirroring `books/upload-session.store.ts`'s design for the
 * same reason: the session only needs to live long enough to bridge the
 * client's direct-to-storage upload, so it is never a database table.
 */
@Injectable()
export class CoverUploadSessionStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async create(record: CoverUploadSessionRecord): Promise<void> {
    await this.redis.set(
      key(record.tenantId, record.id),
      JSON.stringify(record),
      'EX',
      TTL_SECONDS,
    );
  }

  async get(tenantId: string, sessionId: string): Promise<CoverUploadSessionRecord | null> {
    const raw = await this.redis.get(key(tenantId, sessionId));
    return raw ? (JSON.parse(raw) as CoverUploadSessionRecord) : null;
  }

  async delete(tenantId: string, sessionId: string): Promise<void> {
    await this.redis.del(key(tenantId, sessionId));
  }
}
