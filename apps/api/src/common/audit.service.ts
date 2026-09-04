import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient, Tx } from '@audio-book/database';
import { generateId } from '@audio-book/events';
import { logError, type Logger } from '@audio-book/logging';
import { LOGGER, PRISMA } from './tokens.js';
import type { AuthenticatedPrincipal } from './guards/jwt-auth.guard.js';

/**
 * The user-action audit trail (`api-specification.md` §14.12,
 * `database-schema.md` §17.1).
 *
 * `audit_log` is append-only and polymorphic: `resource_id` deliberately
 * carries no foreign key so an entry survives the purge of its target. Rows
 * are written with the **same** correlation and trace ids the HTTP response
 * carried, which is what makes "who started this generation, and which jobs
 * did it create" answerable from one identifier (§39 of the Phase 8 brief).
 *
 * Two deliberate properties:
 *
 * 1. **Never fails the request.** An audit write that throws must not turn a
 *    successful cancellation into a 500 — the user's work happened. Failures
 *    are logged at `error` so they are alertable, not swallowed silently.
 *    A caller that needs the audit row to be atomic with the domain write
 *    passes a transaction via `recordIn`, where a failure *does* roll the
 *    whole thing back, because there the audit row is part of the operation.
 * 2. **Never carries content.** `metadata` holds identifiers, counts, and
 *    state names only. Book text, Story Bible content, signed URLs, and
 *    provider secrets are forbidden here exactly as they are in errors and
 *    logs (§8.2, §14.11).
 */

/** Subset of `AuditAction` this application layer emits. Kept as a type so a typo is a compile error. */
export type AuditActionName =
  | 'BOOK_CREATED'
  | 'BOOK_DELETED'
  | 'BOOK_RESTORED'
  | 'UPLOAD_FINALIZED'
  | 'DIRECTOR_REGENERATION_REQUESTED'
  | 'TTS_REGENERATION_REQUESTED'
  | 'ASSEMBLY_REQUESTED'
  | 'FORCED_REGENERATION'
  | 'ACCESS_URL_MINTED'
  | 'VOICE_ASSIGNED'
  | 'QUOTA_CHANGED'
  | 'JOB_CANCELLED'
  | 'JOB_REPLAYED'
  | 'ADMIN_CROSS_TENANT_READ'
  // --- Phase 10: identity and deletion lifecycle -----------------------
  | 'BOOK_PURGED'
  | 'USER_REGISTERED'
  | 'LOGIN_SUCCEEDED'
  | 'SESSION_REVOKED'
  | 'REFRESH_TOKEN_REUSE_DETECTED';

export type AuditResourceType =
  | 'book'
  | 'book_file'
  | 'job'
  | 'tenant'
  | 'user'
  | 'audiobook'
  | 'chapter_audio'
  | 'audio_chunk'
  | 'voice_profile'
  | 'voice_profile_version';

export interface AuditEntry {
  principal: AuthenticatedPrincipal;
  action: AuditActionName;
  resourceType: AuditResourceType;
  resourceId?: string;
  bookId?: string;
  /** The tenant the *resource* belongs to. Differs from the actor's tenant only on admin paths. */
  tenantId?: string;
  outcome?: 'SUCCESS' | 'FAILURE';
  correlation?: CorrelationContext;
  /** Identifiers, counts, and state names only — never content. */
  metadata?: Record<string, string | number | boolean | null | string[]>;
}

export interface CorrelationContext {
  correlationId?: string;
  traceId?: string;
  requestId?: string;
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Best-effort audit write. Never throws. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: buildRow(entry) });
    } catch (err) {
      logError(this.logger, err, 'Audit log write failed — the audited action itself succeeded');
    }
  }

  /** Transactional audit write: the audit row and the domain write commit or roll back together. */
  async recordIn(tx: Tx, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({ data: buildRow(entry) });
  }
}

function buildRow(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
  return {
    id: generateId(),
    occurredAt: new Date(),
    tenantId: entry.tenantId ?? entry.principal.tenantId,
    actorKind: 'USER',
    actorUserId: entry.principal.sub,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    bookId: entry.bookId,
    requestId: entry.correlation?.requestId ?? entry.correlation?.correlationId,
    traceId: entry.correlation?.traceId,
    correlationId: entry.correlation?.correlationId,
    outcome: entry.outcome ?? 'SUCCESS',
    metadata: entry.metadata,
  };
}

/**
 * Reads the correlation ids off the response headers `CorrelationMiddleware`
 * already set. Deliberately not the request object: that middleware receives
 * the raw Node request while Nest hands controllers the Fastify wrapper — two
 * different objects — so the response headers are the only thing both sides
 * share (the same reasoning `AllExceptionsFilter` documents).
 */
export function correlationFromReply(reply: {
  getHeader(name: string): number | string | string[] | undefined;
}): CorrelationContext {
  const first = (value: number | string | string[] | undefined): string | undefined => {
    if (Array.isArray(value)) return value[0];
    if (typeof value === 'number') return String(value);
    return value;
  };
  const requestId = first(reply.getHeader('X-Request-Id'));
  return { requestId, correlationId: requestId, traceId: first(reply.getHeader('X-Trace-Id')) };
}
