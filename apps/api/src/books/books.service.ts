import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import {
  ConflictError,
  NotFoundError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '@audio-book/errors';
import { generateId, writeOutboxMessage } from '@audio-book/events';
import {
  defaultIngestionConfig,
  detectFormat,
  PARSER_VERSION_FOR_IDEMPOTENCY,
} from '@audio-book/ingestion';
import type { Logger } from '@audio-book/logging';
import { enqueueProcessingJob, QueueManager } from '@audio-book/queue';
import { buildStorageKey, checksumBuffer, type StorageProvider } from '@audio-book/storage';
import { LOGGER, PRISMA, QUEUE_MANAGER, STORAGE_PROVIDER } from '../common/tokens.js';
import { assertTenantOwnership, requireRole } from '../common/tenant.js';
import { decodeCursor, encodeCursor, parseLimit } from '../common/pagination.js';
import { assertIfMatch } from '../users/users.service.js';
import type { AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { QuotaService } from '../common/quota.service.js';
import { UploadSessionStore, type UploadSessionRecord } from './upload-session.store.js';

export interface PurgeBookBody {
  confirm_book_id: string;
}

const PRODUCER = 'api';
const PRODUCER_VERSION = '1.0.0';
const PIPELINE_VERSION = defaultIngestionConfig().pipelineVersion;
const UPLOAD_URL_TTL_SECONDS = 900;

/**
 * The single definition of the `parse_book` queue envelope.
 *
 * It is written onto the ProcessingJob row (`dispatch_envelope`) inside the
 * same transaction that creates the row, and used verbatim by the dispatch
 * that follows the commit. One definition, two uses: the job's recorded
 * intent and its actual dispatch cannot drift, and ProcessingJobSweeper can
 * recover the job from the row alone if the process dies in between
 * (QA finding F-4).
 */
function parseBookEnvelope(args: {
  jobId: string;
  bookFileId: string;
  tenantId: string;
  correlationId: string;
}) {
  return {
    job_id: args.jobId,
    entity_id: args.jobId,
    correlation_id: args.correlationId,
    tenant_id: args.tenantId,
    payload: { book_file_id: args.bookFileId, parser_version: PARSER_VERSION_FOR_IDEMPOTENCY },
  };
}

/**
 * The `cleanup_artifacts` dispatch envelope for a book purge
 * (`database-schema.md` §27.4). Dispatched directly via
 * `enqueueProcessingJob`, the same low-latency path `parseBookEnvelope`
 * uses — not the Phase 1 outbox-relay path
 * (`common/providers.module.ts`'s `outboxPublisherProvider`), which only
 * exists to prove the outbox->queue->worker plumbing for that one synthetic
 * test event and wraps payloads in an unrelated shape.
 * `apps/worker-cpu/src/processors/maintenance.ts` branches on
 * `payload.operation` to run the real purge logic for this shape, while
 * leaving that Phase 1 fixture's own (`operation`-less) payload shape and
 * behavior untouched.
 */
function purgeBookEnvelope(args: { jobId: string; bookId: string; tenantId: string; correlationId: string }) {
  return {
    job_id: args.jobId,
    entity_id: args.jobId,
    correlation_id: args.correlationId,
    tenant_id: args.tenantId,
    payload: { operation: 'purge_book' as const, book_id: args.bookId },
  };
}

export interface CreateBookBody {
  title: string;
  author?: string;
  language: string;
  description?: string;
  metadata?: {
    series?: string;
    series_index?: number;
    publication_year?: number;
    publisher?: string;
  };
}

export interface CreateUploadSessionBody {
  file_name: string;
  declared_mime_type: string;
  declared_size_bytes: number;
  declared_content_hash: { algorithm: 'SHA256'; value: string };
  source_kind: 'PDF' | 'EPUB';
}

export interface CompleteUploadSessionBody {
  observed_size_bytes: number;
  allow_duplicate?: boolean;
}

export interface RequestIngestionBody {
  book_file_id: string;
  force?: boolean;
  priority?: 'INTERACTIVE' | 'NORMAL' | 'BULK';
}

export interface ListBooksQuery {
  cursor?: string;
  limit?: string;
  status?: string;
  include_deleted?: string;
}

export interface UpdateBookBody {
  title?: string;
  author?: string | null;
  language?: string;
  description?: string | null;
  metadata?: {
    series?: string | null;
    series_index?: number | null;
    publication_year?: number | null;
    publisher?: string | null;
  };
}

/** `api-specification.md` §20.1 — the closed book lifecycle vocabulary. */
const BOOK_STATUSES = [
  'CREATED',
  'UPLOADED',
  'PARSING',
  'PARSED',
  'STRUCTURED',
  'ANALYZING',
  'ANALYZED',
  'CASTING',
  'SCRIPTING',
  'SCRIPTED',
  'GENERATING',
  'ASSEMBLING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'NEEDS_REVIEW',
] as const;

const ACTIVE_JOB_STATUSES = ['CREATED', 'QUEUED', 'RUNNING', 'RETRYING', 'BLOCKED'] as const;

@Injectable()
export class BooksService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(QUEUE_MANAGER) private readonly queueManager: QueueManager,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly uploadSessions: UploadSessionStore,
    private readonly quotas: QuotaService,
  ) {}

  // ---- Books ----

  async createBook(principal: AuthenticatedPrincipal, body: CreateBookBody) {
    // The one quota QuotaGuard cannot check: there is no bookId yet, and the
    // limit is on library size rather than on active generation.
    await this.quotas.assertCanCreateBook(principal);
    const id = generateId();
    const now = new Date();
    const book = await this.prisma.book.create({
      data: {
        id,
        tenantId: principal.tenantId,
        title: body.title,
        author: body.author,
        language: body.language,
        description: body.description,
        series: body.metadata?.series,
        seriesIndex: body.metadata?.series_index,
        publicationYear: body.metadata?.publication_year,
        publisher: body.metadata?.publisher,
        status: 'CREATED',
        statusChangedAt: now,
        pipelineVersion: PIPELINE_VERSION,
        createdByUserId: principal.sub,
      },
    });
    return toBookDto(book);
  }

  /**
   * `api-specification.md` §16.4.
   *
   * Phase 1 returned a flat `take: 50` with no cursor, which silently truncated
   * any library larger than that — a user with 51 books could not reach the
   * 51st through the API at all. §46/§54 of the Phase 8 brief require
   * pagination on every potentially large collection, so this is now a proper
   * keyset page over the same `(created_at desc, id desc)` order the
   * `book_tenant_created` index already serves.
   */
  async listBooks(principal: AuthenticatedPrincipal, query: ListBooksQuery = {}) {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    const where: Prisma.BookWhereInput = { tenantId: principal.tenantId };
    // §16.6.1: "The book disappears from `GET /books` unless
    // `include_deleted=true`."
    if (query.include_deleted !== 'true') where.deletedAt = null;
    if (query.status) {
      const statuses = query.status
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      const invalid = statuses.filter((s) => !(BOOK_STATUSES as readonly string[]).includes(s));
      if (invalid.length > 0) {
        throw new ValidationError({
          message: `status contains ${invalid.length} unrecognized value(s).`,
          details: [{ field: 'status', issue: 'invalid_enum' }],
        });
      }
      if (statuses.length > 0) where.status = { in: statuses as never };
    }
    if (cursor) {
      where.OR = [
        { createdAt: { lt: new Date(String(cursor.v)) } },
        { AND: [{ createdAt: new Date(String(cursor.v)) }, { id: { lt: cursor.id } }] },
      ];
    }

    const rows = await this.prisma.book.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map(toBookDto),
      page: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
        prev_cursor: null,
        total: null,
      },
    };
  }

  async getBook(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.prisma.book.findFirst({
      where: { id: bookId, tenantId: principal.tenantId },
    });
    assertTenantOwnership(book, principal, 'Book not found.');
    return { data: toBookDto(book), etag: bookEtag(book) };
  }

  /**
   * `api-specification.md` §16.5 — user-editable metadata only.
   *
   * Two refusals worth naming, both from the spec rather than invented here:
   *
   * - `status` is not patchable. It is absent from the request schema, so the
   *   attempt is a `422 unknown_field` at the validation pipe. Pipeline state
   *   changes because work happened, never because a client asked.
   * - `language` cannot change once ingestion has produced canonical text.
   *   Language participates in parsing and in Director decisions, so a book
   *   whose language changed after ingestion would carry chapters parsed under
   *   one language and an Audio Script directed under another. §16.5 makes
   *   this `409 INVALID_STATE_TRANSITION` with a message pointing at creating
   *   a new book.
   */
  async updateBook(
    principal: AuthenticatedPrincipal,
    bookId: string,
    body: UpdateBookBody,
    ifMatch?: string,
  ) {
    const book = await this.requireOwnedBook(principal, bookId);
    if (book.deletedAt) {
      throw new ConflictError({
        code: 'INVALID_STATE_TRANSITION',
        message: 'This book is deleted and cannot be edited.',
      });
    }
    assertIfMatch(ifMatch, bookEtag(book));

    if (body.language !== undefined && body.language !== book.language) {
      if (book.currentBookVersionId !== null) {
        throw new ConflictError({
          code: 'INVALID_STATE_TRANSITION',
          message:
            'language cannot be changed after ingestion has produced canonical text. Create a new book instead.',
        });
      }
    }

    // `updated_at` alone is not enough to make If-Match work: Prisma's
    // @updatedAt has millisecond granularity, so two writes in the same
    // millisecond would share an ETag. `row_version` is the schema's own
    // concurrency column (§8.1) and is incremented on every patch here.
    const updated = await this.prisma.book.update({
      where: { id: bookId },
      data: {
        title: body.title,
        author: body.author === null ? null : body.author,
        language: body.language,
        description: body.description === null ? null : body.description,
        series: body.metadata?.series === null ? null : body.metadata?.series,
        seriesIndex: body.metadata?.series_index === null ? null : body.metadata?.series_index,
        publicationYear:
          body.metadata?.publication_year === null ? null : body.metadata?.publication_year,
        publisher: body.metadata?.publisher === null ? null : body.metadata?.publisher,
        rowVersion: { increment: 1 },
      },
    });

    this.logger.info({ book_id: bookId }, 'Book metadata updated');
    return { data: toBookDto(updated), etag: bookEtag(updated) };
  }

  /**
   * `api-specification.md` §16.6.1 — **soft** delete.
   *
   * `context.md` §4.1 mandates soft deletion for user-facing entities and §4.4
   * defines no `ARCHIVED` state, so "archive" is not a separate concept here:
   * deletion is a `deleted_at` stamp. Artifacts are retained for the retention
   * window (§12.3) — this method deliberately deletes no bytes.
   *
   * Refusing while jobs are live is not tidiness: deleting a book out from
   * under running GPU work orphans the spend and leaves artifacts whose parent
   * is gone. The caller is told to cancel first, and `POST
   * /jobs/{id}/cancellation` is how.
   */
  async deleteBook(principal: AuthenticatedPrincipal, bookId: string): Promise<void> {
    const book = await this.requireOwnedBook(principal, bookId);
    if (book.deletedAt) return; // §16.6.1: naturally idempotent.

    const activeJobs = await this.prisma.processingJob.count({
      where: { bookId, status: { in: ['QUEUED', 'RUNNING', 'RETRYING'] } },
    });
    if (activeJobs > 0) {
      throw new ConflictError({
        code: 'BOOK_HAS_ACTIVE_JOBS',
        message: `${activeJobs} job(s) are still running for this book. Cancel them before deleting it.`,
      });
    }

    await this.prisma.book.update({
      where: { id: bookId },
      data: { deletedAt: new Date(), rowVersion: { increment: 1 } },
    });
    this.logger.info({ book_id: bookId }, 'Book soft-deleted');
  }

  /**
   * `api-specification.md` §16.6.2 — undo a soft delete within the retention
   * window. `TENANT_OWNER` only (a stricter check than the controller's
   * `TenantRoleGuard`, which admits any tenant member). Never touches
   * `status`: the book returns to exactly the lifecycle state it held at
   * deletion, matching "restoration never advances or rewinds the pipeline."
   * `BookPurgeGuard` (on the controller) has already turned a purged book
   * into `410` before this method would ever run — a book reaching here
   * that is not soft-deleted is a genuine `409`, not a purge case.
   */
  async restoreBook(principal: AuthenticatedPrincipal, bookId: string) {
    requireRole(principal, 'TENANT_OWNER');
    const book = await this.requireOwnedBook(principal, bookId);
    if (!book.deletedAt) {
      throw new ConflictError({
        code: 'INVALID_STATE_TRANSITION',
        message: 'This book is not deleted.',
      });
    }
    const restored = await this.prisma.book.update({
      where: { id: bookId },
      data: { deletedAt: null, rowVersion: { increment: 1 } },
    });
    this.logger.info({ book_id: bookId }, 'Book restored');
    return { data: toBookDto(restored) };
  }

  /**
   * `api-specification.md` §16.6.3 — irreversible purge. `TENANT_OWNER`
   * only, `Idempotency-Key` required (enforced by the controller via
   * `IdempotencyService`, the same pattern `createBook` uses), and
   * `confirm_book_id` must equal the path id — a destructive irreversible
   * operation needs an explicit confirmation token in the body, not just the
   * URL a script could construct blindly.
   *
   * This method only *admits* the purge: it validates preconditions and
   * enqueues the `cleanup_artifacts` job that does the actual bottom-up
   * deletion (`database-schema.md` §27.4) in `worker-cpu`. Returning `202`
   * with a job handle, not `204`, is deliberate — the spec is explicit that
   * purge is asynchronous because it can delete millions of objects.
   */
  async purgeBook(principal: AuthenticatedPrincipal, bookId: string, body: PurgeBookBody) {
    requireRole(principal, 'TENANT_OWNER');
    if (body.confirm_book_id !== bookId) {
      // §16.6.3 calls this `inconsistent_with` in prose; the closed
      // `details[].issue` vocabulary this codebase validates against
      // (api-specification.md §12.1) does not include that value, so this
      // maps to the closest member of the actual closed set instead of
      // inventing a tenth one.
      throw new ValidationError({
        message: 'confirm_book_id must equal the bookId in the path.',
        details: [{ field: 'confirm_book_id', issue: 'invalid_format' }],
      });
    }

    const book = await this.requireOwnedBook(principal, bookId);
    if (!book.deletedAt) {
      throw new ConflictError({
        code: 'INVALID_STATE_TRANSITION',
        message: 'The book must be soft-deleted before it can be purged.',
      });
    }
    const activeJobs = await this.prisma.processingJob.count({
      where: { bookId, status: { in: [...ACTIVE_JOB_STATUSES] } },
    });
    if (activeJobs > 0) {
      throw new ConflictError({
        code: 'BOOK_HAS_ACTIVE_JOBS',
        message: `${activeJobs} job(s) are still associated with this book. Cancel them before purging it.`,
      });
    }

    const jobId = generateId();
    const correlationId = generateId();
    const now = new Date();
    const idempotencyFingerprint = createHash('sha256').update(`purge:${bookId}`).digest('hex');

    await this.prisma.processingJob.create({
      data: {
        id: jobId,
        tenantId: principal.tenantId,
        bookId,
        type: 'cleanup_artifacts',
        queue: 'maintenance',
        priority: 'BULK',
        relatedResourceType: 'book',
        relatedResourceId: bookId,
        status: 'CREATED',
        statusChangedAt: now,
        maxAttempts: 3,
        idempotencyKey: `purge_book:${bookId}`,
        idempotencyFingerprint,
        correlationId,
        dispatchEnvelope: purgeBookEnvelope({ jobId, bookId, tenantId: principal.tenantId, correlationId }),
      },
    });

    await enqueueProcessingJob(this.prisma, this.queueManager, {
      processingJobId: jobId,
      queue: 'maintenance',
      envelope: purgeBookEnvelope({ jobId, bookId, tenantId: principal.tenantId, correlationId }),
      jobName: 'cleanup_artifacts',
      maxAttempts: 3,
    });
    this.logger.info({ book_id: bookId, job_id: jobId }, 'Book purge enqueued');

    return {
      job: { id: jobId, type: 'cleanup_artifacts' as const, status: 'CREATED' as const, book_id: bookId },
    };
  }

  /**
   * `api-specification.md` §15.3 / §4.2 — `BookFile` is created by the upload
   * flow and never edited, so this is read-only.
   */
  async listBookFiles(principal: AuthenticatedPrincipal, bookId: string) {
    await this.requireOwnedBook(principal, bookId);
    const files = await this.prisma.bookFile.findMany({
      where: { bookId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      data: files.map(toBookFileDto),
      page: { limit: 100, has_more: false, next_cursor: null, prev_cursor: null, total: null },
    };
  }

  async getBookFile(principal: AuthenticatedPrincipal, bookId: string, bookFileId: string) {
    await this.requireOwnedBook(principal, bookId);
    const file = await this.prisma.bookFile.findFirst({ where: { id: bookFileId, bookId } });
    if (!file) throw new NotFoundError({ message: 'Book file not found.' });
    return toBookFileDto(file);
  }

  private async requireOwnedBook(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.prisma.book.findFirst({
      where: { id: bookId, tenantId: principal.tenantId },
    });
    assertTenantOwnership(book, principal, 'Book not found.');
    return book;
  }

  // ---- Upload sessions ----

  async createUploadSession(
    principal: AuthenticatedPrincipal,
    bookId: string,
    body: CreateUploadSessionBody,
  ) {
    const book = await this.requireOwnedBook(principal, bookId);
    const config = defaultIngestionConfig();

    if (body.declared_size_bytes > config.maxFileSizeBytes) {
      throw new ValidationError({
        code: 'FILE_TOO_LARGE',
        message: `File exceeds the maximum allowed size of ${config.maxFileSizeBytes} bytes.`,
      });
    }
    const expectedMime = body.source_kind === 'PDF' ? 'application/pdf' : 'application/epub+zip';
    if (body.declared_mime_type !== expectedMime) {
      throw new UnsupportedMediaTypeError({
        code: 'UNSUPPORTED_FILE_FORMAT',
        message: `declared_mime_type ${body.declared_mime_type} does not match source_kind ${body.source_kind}.`,
      });
    }

    const sessionId = generateId();
    const storageKey = buildStorageKey({
      tenantId: principal.tenantId,
      segments: ['books', bookId, 'uploads', sessionId, sourceKindExtension(body.source_kind)],
    });
    const now = new Date();
    const record: UploadSessionRecord = {
      id: sessionId,
      tenantId: principal.tenantId,
      bookId: book.id,
      status: 'AWAITING_UPLOAD',
      sourceKind: body.source_kind,
      fileName: body.file_name,
      declaredMimeType: body.declared_mime_type,
      declaredSizeBytes: body.declared_size_bytes,
      declaredContentHash: body.declared_content_hash,
      storageKey,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    };
    await this.uploadSessions.create(record);

    const uploadUrl = await this.storage.getSignedUrl(storageKey, 'PUT', UPLOAD_URL_TTL_SECONDS);

    return {
      id: sessionId,
      object: 'upload_session' as const,
      book_id: bookId,
      status: record.status,
      upload_targets: [
        { part_number: 1, method: 'PUT' as const, url: uploadUrl, expires_at: record.expiresAt },
      ],
      max_size_bytes: config.maxFileSizeBytes,
      expires_at: record.expiresAt,
      created_at: record.createdAt,
    };
  }

  async getUploadSession(principal: AuthenticatedPrincipal, bookId: string, sessionId: string) {
    const session = await this.requireOwnedSession(principal, bookId, sessionId);
    return {
      id: session.id,
      object: 'upload_session' as const,
      book_id: session.bookId,
      status: session.status,
      validation: session.validation,
      rejection_reason_code: session.rejectionReasonCode,
      book_file_id: session.bookFileId,
    };
  }

  async abortUploadSession(
    principal: AuthenticatedPrincipal,
    bookId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.requireOwnedSession(principal, bookId, sessionId);
    if (session.status === 'ADMITTED') {
      throw new ConflictError({
        code: 'INVALID_STATE_TRANSITION',
        message: 'Upload session already admitted.',
      });
    }
    await this.uploadSessions.delete(principal.tenantId, sessionId);
  }

  private async requireOwnedSession(
    principal: AuthenticatedPrincipal,
    bookId: string,
    sessionId: string,
  ): Promise<UploadSessionRecord> {
    const session = await this.uploadSessions.get(principal.tenantId, sessionId);
    if (!session || session.bookId !== bookId) {
      throw new NotFoundError({ message: 'Upload session not found.' });
    }
    return session;
  }

  async completeUploadSession(
    principal: AuthenticatedPrincipal,
    bookId: string,
    sessionId: string,
    body: CompleteUploadSessionBody,
  ) {
    const session = await this.requireOwnedSession(principal, bookId, sessionId);
    if (session.status === 'ADMITTED') {
      throw new ConflictError({
        code: 'UPLOAD_SESSION_EXPIRED',
        message:
          'This upload session was already completed; retry with the same Idempotency-Key instead.',
      });
    }

    const config = defaultIngestionConfig();
    const { body: buffer } = await this.downloadObject(session.storageKey, config.maxFileSizeBytes);

    if (buffer.byteLength !== body.observed_size_bytes) {
      await this.rejectSession(session, 'UPLOAD_INCOMPLETE');
      throw new ConflictError({
        code: 'UPLOAD_INCOMPLETE',
        message: 'Uploaded object size does not match the observed size reported by the client.',
      });
    }

    const checksum = checksumBuffer(buffer);
    if (checksum.hash !== session.declaredContentHash.value) {
      await this.rejectSession(session, 'CHECKSUM_MISMATCH');
      throw new ConflictError({
        code: 'CHECKSUM_MISMATCH',
        message: 'Uploaded content hash does not match the declared hash.',
      });
    }

    const detected = await detectFormat(buffer, session.declaredMimeType).catch(() => null);
    if (!detected || detected.sourceKind !== session.sourceKind) {
      await this.rejectSession(session, 'UNSUPPORTED_FILE_FORMAT');
      throw new UnsupportedMediaTypeError({
        code: 'UNSUPPORTED_FILE_FORMAT',
        message: 'Uploaded file does not match the declared source kind.',
      });
    }

    const duplicate = await this.prisma.bookFile.findFirst({
      where: {
        tenantId: principal.tenantId,
        contentHash: checksum.hash,
        status: 'ADMITTED',
        deduplicatedFromBookFileId: null,
      },
    });
    if (duplicate && !body.allow_duplicate) {
      throw new ConflictError({
        code: 'DUPLICATE_CONTENT_HASH',
        message: 'A file with identical content has already been uploaded for this tenant.',
        details: [{ field: 'book_file_id', issue: 'duplicate' }],
      });
    }

    const bookFileId = generateId();
    const jobId = generateId();
    const correlationId = generateId();
    const now = new Date();
    const meta = await this.storage.head(session.storageKey);

    await withTransaction(this.prisma, async (tx) => {
      await tx.bookFile.create({
        data: {
          id: bookFileId,
          tenantId: principal.tenantId,
          bookId,
          sourceKind: session.sourceKind,
          originalFileName: session.fileName,
          mimeType: session.declaredMimeType,
          sniffedMimeType: detected.sniffedMimeType,
          sizeBytes: BigInt(buffer.byteLength),
          contentHash: checksum.hash,
          contentHashAlgorithm: 'SHA256',
          status: 'ADMITTED',
          validation: {
            declared_vs_sniffed_mime: detected.declaredVsSniffedMatch,
            sniffed_mime_type: detected.sniffedMimeType,
            size_check: true,
            checksum_check: true,
          },
          storageKey: session.storageKey,
          storageBucket: meta?.bucket ?? 'unknown',
        },
      });

      await tx.processingJob.create({
        data: {
          id: jobId,
          tenantId: principal.tenantId,
          bookId,
          type: 'parse_book',
          queue: 'parse',
          priority: 'NORMAL',
          relatedResourceType: 'book_file',
          relatedResourceId: bookFileId,
          status: 'CREATED',
          statusChangedAt: now,
          maxAttempts: 3,
          idempotencyKey: `parse:${bookFileId}:${PARSER_VERSION_FOR_IDEMPOTENCY}`,
          idempotencyFingerprint: checksum.hash,
          correlationId,
          dispatchEnvelope: parseBookEnvelope({
            jobId,
            bookFileId,
            tenantId: principal.tenantId,
            correlationId,
          }),
        },
      });

      await tx.book.update({
        where: { id: bookId },
        data: { status: 'UPLOADED', statusChangedAt: now },
      });

      await writeOutboxMessage(tx, {
        eventType: 'book.uploaded',
        schemaVersion: '1.0',
        tenantId: principal.tenantId,
        bookId,
        jobId,
        correlationId,
        causationId: correlationId,
        producer: PRODUCER,
        producerVersion: PRODUCER_VERSION,
        aggregateType: 'book_file',
        aggregateId: bookFileId,
        payload: {
          book_file_id: bookFileId,
          source_kind: session.sourceKind,
          size_bytes: buffer.byteLength,
          content_hash: checksum.hash,
          admitted: true,
        },
      });
    });

    await this.enqueueParseBook({
      jobId,
      bookFileId,
      bookId,
      tenantId: principal.tenantId,
      correlationId,
    });

    // Phase 10 quota completion: STORAGE_BYTES. The dominant, already-known
    // size at admission time — assembled-audio artifact sizes are a smaller,
    // separate follow-on (see docs/application/quota-and-usage-model.md).
    await this.quotas.recordUsage(principal.tenantId, 'STORAGE_BYTES', buffer.byteLength);

    session.status = 'ADMITTED';
    session.bookFileId = bookFileId;
    await this.uploadSessions.update(session);

    return {
      job: { id: jobId, type: 'parse_book' as const, status: 'CREATED' as const, book_id: bookId },
      accepted: {
        scope: 'BOOK_FILE' as const,
        book_file_id: bookFileId,
        upload_session_status: 'ADMITTED' as const,
      },
    };
  }

  private async rejectSession(session: UploadSessionRecord, reasonCode: string): Promise<void> {
    session.status = 'REJECTED';
    session.rejectionReasonCode = reasonCode;
    await this.uploadSessions.update(session);
  }

  private async downloadObject(key: string, maxBytes: number): Promise<{ body: Buffer }> {
    const { body } = await this.storage.get(key);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
      total += buf.byteLength;
      if (total > maxBytes) {
        body.destroy();
        throw new ValidationError({
          code: 'FILE_TOO_LARGE',
          message: 'Object exceeds the configured size limit.',
        });
      }
      chunks.push(buf);
    }
    return { body: Buffer.concat(chunks) };
  }

  private async enqueueParseBook(args: {
    jobId: string;
    bookFileId: string;
    bookId: string;
    tenantId: string;
    correlationId: string;
  }): Promise<void> {
    await enqueueProcessingJob(this.prisma, this.queueManager, {
      processingJobId: args.jobId,
      queue: 'parse',
      envelope: parseBookEnvelope(args),
      jobName: 'parse_book',
      maxAttempts: 3,
    });
    this.logger.info({ job_id: args.jobId, book_id: args.bookId }, 'Enqueued parse_book command');
  }

  // ---- Ingestion ----

  async requestIngestion(
    principal: AuthenticatedPrincipal,
    bookId: string,
    body: RequestIngestionBody,
  ) {
    await this.requireOwnedBook(principal, bookId);
    const bookFile = await this.prisma.bookFile.findFirst({
      where: { id: body.book_file_id, bookId, tenantId: principal.tenantId },
    });
    if (!bookFile) throw new NotFoundError({ message: 'BookFile not found.' });
    if (bookFile.status !== 'ADMITTED') {
      throw new ConflictError({
        code: 'BOOK_FILE_NOT_ADMITTED',
        message: 'BookFile has not been admitted.',
      });
    }

    const running = await this.prisma.processingJob.findFirst({
      where: {
        relatedResourceType: 'book_file',
        relatedResourceId: bookFile.id,
        status: { in: [...ACTIVE_JOB_STATUSES] },
      },
    });
    if (running && !body.force) {
      throw new ConflictError({
        code: 'INGESTION_ALREADY_RUNNING',
        message: 'Ingestion is already running for this file.',
      });
    }

    const jobId = generateId();
    const correlationId = generateId();
    const now = new Date();

    await withTransaction(this.prisma, async (tx) => {
      await tx.processingJob.create({
        data: {
          id: jobId,
          tenantId: principal.tenantId,
          bookId,
          type: 'parse_book',
          queue: 'parse',
          priority: body.priority ?? 'NORMAL',
          relatedResourceType: 'book_file',
          relatedResourceId: bookFile.id,
          status: 'CREATED',
          statusChangedAt: now,
          maxAttempts: 3,
          idempotencyKey: `parse:${bookFile.id}:${PARSER_VERSION_FOR_IDEMPOTENCY}:${jobId}`,
          idempotencyFingerprint: bookFile.contentHash,
          correlationId,
          forced: Boolean(body.force),
          dispatchEnvelope: parseBookEnvelope({
            jobId,
            bookFileId: bookFile.id,
            tenantId: principal.tenantId,
            correlationId,
          }),
        },
      });

      await tx.book.update({
        where: { id: bookId },
        data: { status: 'PARSING', statusChangedAt: now },
      });

      await writeOutboxMessage(tx, {
        eventType: 'book.parse_started',
        schemaVersion: '1.0',
        tenantId: principal.tenantId,
        bookId,
        jobId,
        correlationId,
        causationId: correlationId,
        producer: PRODUCER,
        producerVersion: PRODUCER_VERSION,
        aggregateType: 'book_file',
        aggregateId: bookFile.id,
        payload: {
          book_version_id: null,
          book_file_id: bookFile.id,
          parser_strategy: 'AUTO',
        },
      });
    });

    await this.enqueueParseBook({
      jobId,
      bookFileId: bookFile.id,
      bookId,
      tenantId: principal.tenantId,
      correlationId,
    });

    return {
      job: { id: jobId, type: 'parse_book' as const, status: 'CREATED' as const, book_id: bookId },
    };
  }

  async getIngestionStatus(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.requireOwnedBook(principal, bookId);
    const bookVersion = book.currentBookVersionId
      ? await this.prisma.bookVersion.findUnique({ where: { id: book.currentBookVersionId } })
      : null;
    const latestJob = await this.prisma.processingJob.findFirst({
      where: { bookId, type: 'parse_book' },
      orderBy: { createdAt: 'desc' },
    });

    const [chapterCount, paragraphCount] = bookVersion
      ? await Promise.all([
          this.prisma.chapter.count({ where: { bookVersionId: bookVersion.id } }),
          this.prisma.paragraph.count({ where: { bookVersionId: bookVersion.id } }),
        ])
      : [0, 0];

    return {
      object: 'ingestion_state' as const,
      book_id: bookId,
      status: deriveIngestionState(book.status, bookVersion?.status, latestJob?.status),
      book_file_id:
        latestJob?.relatedResourceType === 'book_file' ? latestJob.relatedResourceId : undefined,
      pipeline_version: bookVersion?.pipelineVersion,
      content_hash: bookVersion?.contentHash,
      structure_version: bookVersion?.structureVersionLabel,
      counts: {
        pages_total: bookVersion?.pagesTotal ?? undefined,
        pages_ok: bookVersion?.pagesOk ?? undefined,
        pages_needs_review: bookVersion?.pagesNeedsReview ?? undefined,
        chapters: chapterCount,
        paragraphs: paragraphCount,
      },
      text_qc: bookVersion?.textQc ?? undefined,
      degraded: bookVersion?.degraded ?? false,
      started_at: bookVersion?.startedAt ?? undefined,
      completed_at: bookVersion?.completedAt ?? undefined,
      current_job_id: latestJob?.id,
    };
  }

  // ---- Structural reads ----

  async listChapters(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.requireOwnedBook(principal, bookId);
    if (!book.currentBookVersionId) return [];
    const chapters = await this.prisma.chapter.findMany({
      where: { bookVersionId: book.currentBookVersionId },
      orderBy: { orderIndex: 'asc' },
    });
    return chapters.map(toChapterDto);
  }

  async getChapter(principal: AuthenticatedPrincipal, bookId: string, chapterId: string) {
    await this.requireOwnedBook(principal, bookId);
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, bookId } });
    if (!chapter) throw new NotFoundError({ message: 'Chapter not found.' });
    return toChapterDto(chapter);
  }

  async listSections(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.requireOwnedBook(principal, bookId);
    if (!book.currentBookVersionId) return [];
    const sections = await this.prisma.section.findMany({
      where: { bookVersionId: book.currentBookVersionId },
      orderBy: [{ chapterId: 'asc' }, { orderIndex: 'asc' }],
    });
    return sections.map((s) => ({
      id: s.id,
      chapter_id: s.chapterId,
      order_index: s.orderIndex,
      spine_start: s.spineStart,
      spine_end: s.spineEnd,
      title: s.title,
    }));
  }

  async listParagraphs(principal: AuthenticatedPrincipal, bookId: string, chapterId: string) {
    await this.requireOwnedBook(principal, bookId);
    const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, bookId } });
    if (!chapter) throw new NotFoundError({ message: 'Chapter not found.' });
    const paragraphs = await this.prisma.paragraph.findMany({
      where: { chapterId },
      orderBy: { orderIndex: 'asc' },
    });
    return paragraphs.map(toParagraphDto);
  }

  async createTextAccessUrl(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.requireOwnedBook(principal, bookId);
    if (!book.currentBookVersionId)
      throw new NotFoundError({ message: 'No ingested version available yet.' });
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: book.currentBookVersionId },
    });
    if (!version?.canonicalTextManifestStorageKey) {
      throw new NotFoundError({ message: 'Canonical text artifact not available.' });
    }
    const url = await this.storage.getSignedUrl(
      version.canonicalTextManifestStorageKey,
      'GET',
      300,
    );
    return {
      object: 'access_url' as const,
      url,
      method: 'GET' as const,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      content_hash: version.canonicalTextManifestContentHash,
    };
  }
}

function sourceKindExtension(sourceKind: 'PDF' | 'EPUB'): string {
  return sourceKind === 'PDF' ? 'source.pdf' : 'source.epub';
}

function deriveIngestionState(
  bookStatus: string,
  versionStatus: string | undefined,
  jobStatus: string | undefined,
): string {
  if (versionStatus === 'READY') return 'COMPLETED';
  if (versionStatus === 'PARTIAL_OCR') return 'PARTIAL_OCR';
  if (versionStatus === 'NEEDS_REVIEW' || bookStatus === 'NEEDS_REVIEW') return 'NEEDS_REVIEW';
  if (bookStatus === 'FAILED' || jobStatus === 'FAILED') return 'FAILED';
  if (jobStatus === 'CANCELLED') return 'CANCELLED';
  if (bookStatus === 'PARSING' || jobStatus === 'RUNNING') return 'PARSING';
  if (jobStatus === 'QUEUED' || jobStatus === 'CREATED') return 'QUEUED';
  return 'NOT_STARTED';
}

interface BookRow {
  id: string;
  tenantId: string;
  title: string;
  author: string | null;
  language: string;
  description: string | null;
  series: string | null;
  seriesIndex: number | null;
  publicationYear: number | null;
  publisher: string | null;
  status: string;
  pipelineVersion: string;
  needsReview: boolean;
  currentBookVersionId: string | null;
  currentAudioScriptId: string | null;
  currentAudiobookId: string | null;
  rowVersion: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function toBookDto(book: BookRow) {
  return {
    id: book.id,
    object: 'book' as const,
    tenant_id: book.tenantId,
    title: book.title,
    author: book.author,
    language: book.language,
    description: book.description,
    metadata: {
      series: book.series,
      series_index: book.seriesIndex,
      publication_year: book.publicationYear,
      publisher: book.publisher,
    },
    status: book.status,
    pipeline_version: book.pipelineVersion,
    needs_review: book.needsReview,
    current_book_version_id: book.currentBookVersionId,
    current_audio_script_id: book.currentAudioScriptId,
    // QA finding F-16: `book.current_audiobook_id` has no writer, so this is
    // reported from the column and will read `null` even for a book with a
    // READY audiobook. `GET /books/{id}/audiobook` derives the current
    // audiobook from the `Audiobook` table and is the reliable pointer today.
    current_audiobook_id: book.currentAudiobookId,
    created_at: book.createdAt,
    updated_at: book.updatedAt,
    deleted_at: book.deletedAt,
    links: {
      self: `/api/v1/books/${book.id}`,
      progress: `/api/v1/books/${book.id}/progress`,
      events: `/api/v1/books/${book.id}/events`,
      jobs: `/api/v1/jobs?book_id=${book.id}`,
      files: `/api/v1/books/${book.id}/files`,
    },
  };
}

/**
 * The optimistic-concurrency token of §2.8, derived from `row_version` rather
 * than from a hash of the response body: a body hash would change every time
 * this DTO gains a field, invalidating every client's stored `If-Match` on
 * deploy for no semantic reason.
 */
export function bookEtag(book: { id: string; rowVersion: number }): string {
  return `"${createHash('sha256').update(`${book.id}:${book.rowVersion}`).digest('hex').slice(0, 32)}"`;
}

interface BookFileRow {
  id: string;
  bookId: string;
  sourceKind: string;
  originalFileName: string;
  mimeType: string;
  sniffedMimeType: string | null;
  sizeBytes: bigint;
  contentHash: string;
  status: string;
  validation: unknown;
  createdAt: Date;
}

/**
 * `storage_key` and `storage_bucket` are deliberately absent: §14.8/§14.9 keep
 * object-storage keys and bucket names out of public responses, and a client
 * that needs the bytes mints an access URL instead.
 */
function toBookFileDto(file: BookFileRow) {
  return {
    id: file.id,
    object: 'book_file' as const,
    book_id: file.bookId,
    source_kind: file.sourceKind,
    original_file_name: file.originalFileName,
    mime_type: file.mimeType,
    sniffed_mime_type: file.sniffedMimeType,
    size_bytes: Number(file.sizeBytes),
    content_hash: { algorithm: 'sha256' as const, value: file.contentHash },
    status: file.status,
    validation: file.validation,
    created_at: file.createdAt.toISOString(),
    // BookFile is immutable (§4.2 "never edited") — §7.1's immutable rule.
    updated_at: file.createdAt.toISOString(),
  };
}

interface ChapterRow {
  id: string;
  orderIndex: number;
  spineStart: number;
  spineEnd: number;
  title: string | null;
  matterType: string;
  charCount: number;
  textQcOutcome: string | null;
}

function toChapterDto(chapter: ChapterRow) {
  return {
    id: chapter.id,
    order_index: chapter.orderIndex,
    spine_start: chapter.spineStart,
    spine_end: chapter.spineEnd,
    title: chapter.title,
    matter_type: chapter.matterType,
    char_count: chapter.charCount,
    text_qc_outcome: chapter.textQcOutcome,
  };
}

interface ParagraphRow {
  id: string;
  chapterId: string;
  sectionId: string | null;
  orderIndex: number;
  spinePosition: number;
  text: string;
  contentHash: string;
  sourcePageNumber: number | null;
  sourceLocator: unknown;
  extractionMethod: string;
  extractionConfidence: number | null;
}

function toParagraphDto(paragraph: ParagraphRow) {
  return {
    id: paragraph.id,
    chapter_id: paragraph.chapterId,
    section_id: paragraph.sectionId,
    order_index: paragraph.orderIndex,
    spine_position: paragraph.spinePosition,
    text: paragraph.text,
    content_hash: paragraph.contentHash,
    source_page_number: paragraph.sourcePageNumber,
    source_locator: paragraph.sourceLocator,
    extraction_method: paragraph.extractionMethod,
    extraction_confidence: paragraph.extractionConfidence,
  };
}
