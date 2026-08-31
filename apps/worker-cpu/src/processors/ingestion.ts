/**
 * Consumes the `parse_book` command (event-contracts.md §11.1) enqueued by
 * the API's upload-completion/ingestion-request handlers. Runs the pure
 * @audio-book/ingestion pipeline against the source bytes, then persists
 * the canonical BookVersion/ParsedPage/Chapter/Section/Paragraph structure
 * and emits `book.parsed` + `book.structure_ready` (or `book.parse_failed`)
 * through the Outbox — all in one transaction, so a partial write can never
 * be mistaken for a completed BookVersion (task §108/§109/§125).
 *
 * Mirrors processors/maintenance.ts's shape (envelope -> deps -> transaction)
 * but is considerably richer since ingestion has real business state to
 * build, not just a status flip.
 */
import type { Prisma, PrismaClient, Tx } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import type { BookFile, ProcessingJob } from '@prisma/client';
import { generateId, writeOutboxMessage } from '@audio-book/events';
import type { Logger } from '@audio-book/logging';
import type { QueueJobEnvelope } from '@audio-book/queue';
import { buildStorageKey, type StorageProvider } from '@audio-book/storage';
import { DependencyFailureError } from '@audio-book/errors';
import {
  FileTooLargeError,
  UnavailableOcrProvider,
  defaultIngestionConfig,
  isTerminalIngestionError,
  runIngestionPipeline,
  sha256Hex,
  type CanonicalChapter,
  type IngestionConfig,
  type IngestionResult,
  type OCRProvider,
} from '@audio-book/ingestion';

export interface ParseBookCommandPayload {
  book_file_id: string;
  parser_version: string;
}

export interface ProcessIngestionJobDeps {
  prisma: PrismaClient;
  storage: StorageProvider;
  logger: Logger;
  envelope: QueueJobEnvelope<ParseBookCommandPayload>;
  config?: IngestionConfig;
  /** Defaults to UnavailableOcrProvider — pages needing OCR are flagged, never silently emptied. */
  ocrProvider?: OCRProvider;
  /** BullMQ's own attempt counters — used only to decide whether THIS attempt is the last one allowed, so a retryable failure isn't recorded as terminal prematurely. */
  attemptsMade: number;
  maxAttempts: number;
}

const PRODUCER = 'worker-cpu';
const PRODUCER_VERSION = '1.0.0';
const NORMALIZER_IDENTITY = { providerId: 'audio-book-normalizer', modelId: 'text-normalizer' };

export async function processIngestionJob(deps: ProcessIngestionJobDeps): Promise<void> {
  const { prisma, storage, logger, envelope, attemptsMade, maxAttempts } = deps;
  const config = deps.config ?? defaultIngestionConfig();
  const ocrProvider = deps.ocrProvider ?? new UnavailableOcrProvider();

  const processingJobId = envelope.entity_id;
  if (!processingJobId) {
    throw new Error('parse_book envelope is missing entity_id (the ProcessingJob id)');
  }

  const job = await prisma.processingJob.findUnique({ where: { id: processingJobId } });
  if (!job) {
    throw new Error(`ProcessingJob ${processingJobId} not found`);
  }
  if (job.status === 'SUCCEEDED' || job.status === 'FAILED') {
    // At-least-once redelivery of an already-terminal job (task §14/§107) — a safe no-op.
    logger.info(
      { job_id: processingJobId, status: job.status },
      'Ingestion job already terminal; skipping redelivered message',
    );
    return;
  }

  const bookFile = await prisma.bookFile.findUnique({
    where: { id: envelope.payload.book_file_id },
  });
  if (!bookFile) {
    throw new Error(`BookFile ${envelope.payload.book_file_id} not found`);
  }

  await prisma.processingJob.update({
    where: { id: processingJobId },
    data: {
      status: 'RUNNING',
      statusChangedAt: new Date(),
      startedAt: job.startedAt ?? new Date(),
      progressStage: 'FETCHING_SOURCE',
      attemptCount: { increment: 1 },
    },
  });

  try {
    const buffer = await downloadToBuffer(storage, bookFile.storageKey, config.maxFileSizeBytes);

    await prisma.processingJob.update({
      where: { id: processingJobId },
      data: { progressStage: 'PARSING', progress: 0.2 },
    });

    const result = await runIngestionPipeline({
      buffer,
      declaredMimeType: bookFile.sniffedMimeType ?? bookFile.mimeType,
      config,
      ocrProvider,
    });

    await prisma.processingJob.update({
      where: { id: processingJobId },
      data: { progressStage: 'PERSISTING', progress: 0.8 },
    });

    const bookVersionId = await persistIngestionResult({
      prisma,
      storage,
      job,
      bookFile,
      result,
      config,
    });

    logger.info(
      {
        job_id: processingJobId,
        book_id: job.bookId,
        book_version_id: bookVersionId,
        chapters: result.chapters.length,
        paragraphs: result.chapters.reduce((sum, c) => sum + c.paragraphs.length, 0),
        pages: result.pages?.length,
        quality_outcome: result.qualityReport.outcome,
      },
      'Ingestion completed',
    );
  } catch (err) {
    await handleIngestionFailure({ prisma, logger, job, err, attemptsMade, maxAttempts });
    throw err; // let BullMQ's own retry/DLQ policy (packages/queue) decide what happens next
  }
}

async function downloadToBuffer(
  storage: StorageProvider,
  key: string,
  maxBytes: number,
): Promise<Buffer> {
  const { body } = await storage.get(key);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
    total += buf.byteLength;
    if (total > maxBytes) {
      body.destroy();
      throw new FileTooLargeError({
        message: `Source object exceeds the configured size limit of ${maxBytes} bytes.`,
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

interface PersistArgs {
  prisma: PrismaClient;
  storage: StorageProvider;
  job: ProcessingJob;
  bookFile: BookFile;
  result: IngestionResult;
  config: IngestionConfig;
}

async function persistIngestionResult(args: PersistArgs): Promise<string> {
  const { prisma, storage, job, bookFile, result, config } = args;
  const tenantId = job.tenantId;
  const bookId = job.bookId;
  if (!bookId) throw new Error(`ProcessingJob ${job.id} has no bookId`);

  const parserModelVersionId = await resolveModelVersionId(
    prisma,
    'PARSER',
    result.parserIdentity.providerId,
    result.parserIdentity.modelId,
    result.parserIdentity.version,
  );
  const normalizerModelVersionId = await resolveModelVersionId(
    prisma,
    'NORMALIZER',
    NORMALIZER_IDENTITY.providerId,
    NORMALIZER_IDENTITY.modelId,
    config.normalizationVersion,
  );
  // result.ocrIdentity reflects the CONFIGURED provider (null only for
  // UnavailableOcrProvider) — recorded whenever a real OCR engine was
  // available for this run, whether or not any page actually needed it.
  const ocrModelVersionId = result.ocrIdentity
    ? await resolveModelVersionId(
        prisma,
        'OCR',
        result.ocrIdentity.providerId,
        result.ocrIdentity.modelId,
        result.ocrIdentity.version,
      )
    : null;

  const latest = await prisma.bookVersion.aggregate({ where: { bookId }, _max: { version: true } });
  const version = (latest._max.version ?? 0) + 1;

  const canonicalTextStorageKey = buildStorageKey({
    tenantId,
    segments: ['books', bookId, 'versions', String(version), 'normalized', 'canonical.md'],
  });

  // The artifact is written BEFORE any DB row references it (task
  // §108/§109): a BookVersion must never point at a storage key that
  // doesn't exist yet. The reproducibility audit trail (task §95) is NOT a
  // separate file — it's already the BookVersion row's own typed columns
  // (parserModelVersionId, normalizerModelVersionId, pipelineVersion,
  // contentHash, rawTextContentHash, textQc), all queryable via the DB
  // without needing to parse a side-car JSON blob out of object storage.
  const markdownMeta = await storage.put({
    key: canonicalTextStorageKey,
    body: Buffer.from(result.markdown, 'utf8'),
    contentType: 'text/markdown; charset=utf-8',
  });

  const status = deriveBookVersionStatus(result);
  const pagesTotal = result.pages?.length;
  const pagesOk = result.pages?.filter((p) => p.status === 'OK').length;
  const pagesNeedsReview = result.pages?.filter((p) => p.status !== 'OK').length;
  const extractionMethod = result.sourceKind === 'EPUB' ? 'EPUB_SPINE' : 'DIGITAL_TEXT';
  const degraded = (pagesNeedsReview ?? 0) > 0 || result.qualityReport.outcome !== 'PASS';

  return withTransaction(prisma, async (tx) => {
    // Idempotency's final safety net (task §60/§121): identical content
    // already ingested under this pipeline version is a merge, not an error.
    const existing = await tx.bookVersion.findFirst({
      where: {
        bookId,
        pipelineVersion: config.pipelineVersion,
        contentHash: result.contentHash,
        supersededAt: null,
      },
    });
    if (existing) {
      await tx.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'SUCCEEDED',
          statusChangedAt: new Date(),
          completedAt: new Date(),
          progress: 1,
          resultResourceType: 'book_version',
          resultResourceId: existing.id,
          resultVersion: existing.version,
        },
      });
      return existing.id;
    }

    const bookVersionId = generateId();
    const now = new Date();

    await tx.bookVersion.create({
      data: {
        id: bookVersionId,
        tenantId,
        bookId,
        bookFileId: bookFile.id,
        version,
        structureVersionLabel: 'structure.v1',
        isCurrent: true,
        contentHash: result.contentHash,
        rawTextContentHash: result.rawTextContentHash,
        pipelineVersion: config.pipelineVersion,
        parserStrategyUsed: result.parserIdentity.providerId,
        parserModelVersionId,
        ocrModelVersionId,
        normalizerModelVersionId,
        parserOptions: { force_ocr: false, ocr_language_hints: [config.ocrLanguage] },
        canonicalTextManifestStorageKey: canonicalTextStorageKey,
        canonicalTextManifestContentHash: markdownMeta.checksum.hash,
        canonicalTextManifestObjectVerifiedAt: now,
        storageBucket: markdownMeta.bucket,
        status,
        textQcOutcome: result.qualityReport.outcome,
        textQc: result.qualityReport as unknown as Prisma.InputJsonValue,
        pagesTotal,
        pagesOk,
        pagesNeedsReview,
        degraded,
        startedAt: job.startedAt ?? now,
        completedAt: now,
      },
    });

    // Supersede any previous "current" version of this book (task §58/§59:
    // a new parser/config run creates a new BookVersion, never mutates one).
    await tx.bookVersion.updateMany({
      where: { bookId, isCurrent: true, id: { not: bookVersionId } },
      data: { isCurrent: false, supersededAt: now, supersededByBookVersionId: bookVersionId },
    });

    if (result.pages && result.pages.length > 0) {
      const parsedPageIds = new Map<number, string>();
      for (const page of result.pages) parsedPageIds.set(page.pageNumber, generateId());

      await tx.parsedPage.createMany({
        data: result.pages.map((page) => ({
          id: parsedPageIds.get(page.pageNumber)!,
          tenantId,
          bookId,
          bookVersionId,
          pageNumber: page.pageNumber,
          extractionMethod: page.extractionMethod,
          // Per-page, not per-version: only pages actually routed through
          // OCR carry the OCR model reference, even if the provider was
          // configured for the whole run (mixed PDFs have digital pages too).
          ocrModelVersionId:
            page.extractionMethod === 'OCR' || page.extractionMethod === 'IMAGE_OCR'
              ? ocrModelVersionId
              : null,
          confidence: page.confidence,
          charCount: page.charCount,
          status: page.status,
          failureReasonCode: page.failureReasonCode,
          blockConfidence: page.blockConfidence ?? undefined,
        })),
      });

      await persistStructure(tx, {
        tenantId,
        bookId,
        bookVersionId,
        chapters: result.chapters,
        parsedPageIdByPage: parsedPageIds,
      });
    } else {
      await persistStructure(tx, { tenantId, bookId, bookVersionId, chapters: result.chapters });
    }

    const needsReview = status === 'NEEDS_REVIEW' || status === 'PARTIAL_OCR';
    await tx.book.update({
      where: { id: bookId },
      data: {
        status: needsReview ? 'NEEDS_REVIEW' : 'STRUCTURED',
        statusChangedAt: now,
        needsReview,
        currentBookVersionId: bookVersionId,
      },
    });

    await tx.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'SUCCEEDED',
        statusChangedAt: now,
        completedAt: now,
        progress: 1,
        progressStage: 'DONE',
        resultResourceType: 'book_version',
        resultResourceId: bookVersionId,
        resultVersion: version,
      },
    });

    const chapterCount = result.chapters.length;
    const paragraphCount = result.chapters.reduce((sum, c) => sum + c.paragraphs.length, 0);

    await writeOutboxMessage(tx, {
      eventType: 'book.parsed',
      schemaVersion: '1.0',
      tenantId,
      bookId,
      jobId: job.id,
      correlationId: job.correlationId,
      causationId: job.correlationId,
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      aggregateType: 'book_version',
      aggregateId: bookVersionId,
      payload: {
        book_version_id: bookVersionId,
        content_hash: result.contentHash,
        pages_ok: pagesOk ?? paragraphCount,
        pages_needs_review: pagesNeedsReview ?? 0,
        extraction_method: extractionMethod,
        degraded,
      },
    });

    await writeOutboxMessage(tx, {
      eventType: 'book.structure_ready',
      schemaVersion: '1.0',
      tenantId,
      bookId,
      jobId: job.id,
      correlationId: job.correlationId,
      causationId: job.correlationId,
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      aggregateType: 'book_version',
      aggregateId: bookVersionId,
      payload: {
        book_version_id: bookVersionId,
        structure_version_label: 'structure.v1',
        chapter_count: chapterCount,
        paragraph_count: paragraphCount,
        text_qc_outcome: result.qualityReport.outcome,
      },
    });

    return bookVersionId;
  });
}

interface PersistStructureArgs {
  tenantId: string;
  bookId: string;
  bookVersionId: string;
  chapters: CanonicalChapter[];
  parsedPageIdByPage?: Map<number, string>;
}

async function persistStructure(tx: Tx, args: PersistStructureArgs): Promise<void> {
  const { tenantId, bookId, bookVersionId, chapters, parsedPageIdByPage } = args;

  const chapterIds = chapters.map(() => generateId());
  const sectionIdsByChapter = chapters.map((chapter) => chapter.sections.map(() => generateId()));

  await tx.chapter.createMany({
    data: chapters.map((chapter, i) => ({
      id: chapterIds[i]!,
      tenantId,
      bookId,
      bookVersionId,
      orderIndex: chapter.orderIndex,
      spineStart: chapter.spineStart,
      spineEnd: chapter.spineEnd,
      title: chapter.title,
      matterType: chapter.matterType,
      charCount: chapter.paragraphs.reduce((sum, p) => sum + p.text.length, 0),
    })),
  });

  const sectionRows = chapters.flatMap((chapter, i) =>
    chapter.sections.map((section, j) => ({
      id: sectionIdsByChapter[i]![j]!,
      tenantId,
      bookId,
      bookVersionId,
      chapterId: chapterIds[i]!,
      orderIndex: section.orderIndex,
      spineStart: section.spineStart,
      spineEnd: section.spineEnd,
      title: section.title,
    })),
  );
  if (sectionRows.length > 0) {
    await tx.section.createMany({ data: sectionRows });
  }

  const paragraphRows = chapters.flatMap((chapter, i) =>
    chapter.paragraphs.map((paragraph) => ({
      id: generateId(),
      tenantId,
      bookId,
      bookVersionId,
      chapterId: chapterIds[i]!,
      sectionId:
        paragraph.sectionOrderIndex !== undefined
          ? (sectionIdsByChapter[i]![paragraph.sectionOrderIndex] ?? null)
          : null,
      orderIndex: paragraph.orderIndex,
      spinePosition: paragraph.spinePosition,
      text: paragraph.text,
      contentHash: sha256Hex(paragraph.text),
      charCount: paragraph.text.length,
      sourcePageNumber: paragraph.sourcePageNumber,
      sourcePageEndNumber: paragraph.sourcePageEndNumber,
      sourceLocator: paragraph.sourceLocator,
      rawTextContentHash: sha256Hex(paragraph.rawText),
      extractionMethod: paragraph.extractionMethod,
      extractionConfidence: paragraph.extractionConfidence,
      parsedPageId:
        paragraph.sourcePageNumber !== undefined
          ? (parsedPageIdByPage?.get(paragraph.sourcePageNumber) ?? null)
          : null,
    })),
  );

  if (paragraphRows.length > 0) {
    await tx.paragraph.createMany({ data: paragraphRows });
  }
}

async function resolveModelVersionId(
  prisma: PrismaClient,
  role: 'PARSER' | 'NORMALIZER' | 'OCR',
  providerId: string,
  modelId: string,
  version: string,
): Promise<string> {
  const registry = await prisma.modelRegistry.findUnique({
    where: { role_providerId_modelId: { role, providerId, modelId } },
  });
  if (!registry) {
    throw new DependencyFailureError({
      message: `No ModelRegistry entry for ${role}/${providerId}/${modelId}. Run the seed script before ingesting.`,
    });
  }
  const modelVersion = await prisma.modelVersion.findFirst({
    where: { modelRegistryId: registry.id, version },
  });
  if (!modelVersion) {
    throw new DependencyFailureError({
      message: `No ModelVersion ${version} registered for ${role}/${providerId}/${modelId}. Run the seed script before ingesting.`,
    });
  }
  return modelVersion.id;
}

function deriveBookVersionStatus(
  result: IngestionResult,
): 'READY' | 'PARTIAL_OCR' | 'NEEDS_REVIEW' {
  const hasFailedPages = result.pages?.some((p) => p.status === 'FAILED') ?? false;
  const hasReviewPages = result.pages?.some((p) => p.status === 'NEEDS_REVIEW') ?? false;
  if (result.qualityReport.outcome === 'NEEDS_REVIEW' || hasFailedPages) return 'NEEDS_REVIEW';
  if (hasReviewPages) return 'PARTIAL_OCR';
  return 'READY';
}

interface HandleFailureArgs {
  prisma: PrismaClient;
  logger: Logger;
  job: ProcessingJob;
  err: unknown;
  attemptsMade: number;
  maxAttempts: number;
}

async function handleIngestionFailure(args: HandleFailureArgs): Promise<void> {
  const { prisma, logger, job, err, attemptsMade, maxAttempts } = args;
  const terminal = isTerminalIngestionError(err);
  const isFinalAttempt = attemptsMade + 1 >= maxAttempts;

  if (!terminal && !isFinalAttempt) {
    logger.info(
      { job_id: job.id, error: errorMessage(err), attempts_made: attemptsMade },
      'Ingestion attempt failed; will retry',
    );
    return;
  }

  const now = new Date();
  await withTransaction(prisma, async (tx) => {
    const current = await tx.processingJob.findUnique({ where: { id: job.id } });
    if (!current || current.status === 'FAILED') return; // already recorded (redelivery safety)

    await tx.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        statusChangedAt: now,
        completedAt: now,
        errorCode: errorCode(err),
        errorClass: err instanceof Error ? err.constructor.name : 'UnknownError',
        errorMessage: errorMessage(err),
        errorRetryable: !terminal,
        errorTerminal: terminal,
      },
    });

    if (job.bookId) {
      await tx.book.update({
        where: { id: job.bookId },
        data: { status: 'FAILED', statusChangedAt: now, needsReview: true },
      });
    }

    await writeOutboxMessage(tx, {
      eventType: 'book.parse_failed',
      schemaVersion: '1.0',
      tenantId: job.tenantId,
      bookId: job.bookId ?? undefined,
      jobId: job.id,
      correlationId: job.correlationId,
      causationId: job.correlationId,
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      aggregateType: 'processing_job',
      aggregateId: job.id,
      payload: {
        book_version_id: null,
        error_code: errorCode(err),
        error_class: err instanceof Error ? err.constructor.name : 'UnknownError',
        failed_stage: job.progressStage ?? 'UNKNOWN',
        retryable: !terminal,
      },
    });
  });

  logger.info(
    { job_id: job.id, error: errorMessage(err), terminal, final_attempt: isFinalAttempt },
    'Ingestion job failed terminally',
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string {
  return err instanceof Error &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : 'INGESTION_FAILED';
}
