import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@audio-book/database';
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
import { assertTenantOwnership } from '../common/tenant.js';
import type { AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { UploadSessionStore, type UploadSessionRecord } from './upload-session.store.js';

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

const ACTIVE_JOB_STATUSES = ['CREATED', 'QUEUED', 'RUNNING', 'RETRYING', 'BLOCKED'] as const;

@Injectable()
export class BooksService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(QUEUE_MANAGER) private readonly queueManager: QueueManager,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly uploadSessions: UploadSessionStore,
  ) {}

  // ---- Books ----

  async createBook(principal: AuthenticatedPrincipal, body: CreateBookBody) {
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

  async listBooks(principal: AuthenticatedPrincipal) {
    const books = await this.prisma.book.findMany({
      where: { tenantId: principal.tenantId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return books.map(toBookDto);
  }

  async getBook(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.prisma.book.findFirst({
      where: { id: bookId, tenantId: principal.tenantId },
    });
    assertTenantOwnership(book, principal, 'Book not found.');
    return toBookDto(book);
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
  status: string;
  pipelineVersion: string;
  needsReview: boolean;
  currentBookVersionId: string | null;
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
    status: book.status,
    pipeline_version: book.pipelineVersion,
    needs_review: book.needsReview,
    current_book_version_id: book.currentBookVersionId,
    created_at: book.createdAt,
    updated_at: book.updatedAt,
    deleted_at: book.deletedAt,
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
