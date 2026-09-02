/**
 * Consumes the `assemble_audiobook` command: concatenates every current,
 * `ASSEMBLED` `ChapterAudio` of a book's current `BookVersion` (in
 * `Chapter.orderIndex` order — never `spinePosition` string sort, never
 * completion time) into one book-level master WAV, runs a book-wide
 * loudness-CONSISTENCY pass (a gentle per-chapter gain trim, never a
 * `loudnorm` re-run — chapters are already individually mastered), and
 * persists the `Audiobook` + `AudiobookChapter` rows. `Audiobook.status`
 * stays `ASSEMBLING` here — the SOLE place it flips to `READY` is
 * `processEncodeDeliveryFormatJob` in assembly-encode.ts, once every
 * requested delivery format has a `READY` rendition.
 *
 * Enqueues one `encode_delivery_format` job per requested format after this
 * transaction commits.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Prisma, PrismaClient, Tx } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import type { ProcessingJob } from '@prisma/client';
import { generateId, writeOutboxMessage } from '@audio-book/events';
import type { Logger } from '@audio-book/logging';
import type { QueueJobEnvelope } from '@audio-book/queue';
import { enqueueProcessingJob, QueueManager } from '@audio-book/queue';
import { buildStorageKey, type StorageProvider } from '@audio-book/storage';
import {
  applyGainAndConvert,
  concatDemuxCopy,
  measureEbur128,
  probeAudio,
  writeConcatFileList,
} from '../lib/ffmpeg.js';
import { MASTERING_POLICY_V1 } from '../lib/mastering-policy.js';
import {
  ASSEMBLY_PIPELINE_VERSION,
  PRODUCER,
  PRODUCER_VERSION,
  checkAudiobookReadiness,
  computeManifestHash,
  errorClassOf,
  errorCodeOf,
  errorMessage,
  resolveAudioToolModelVersionId,
  withTempDir,
} from './assembly-shared.js';

export interface AssembleAudiobookCommandPayload {
  book_id: string;
  delivery_formats: string[];
}

export interface ProcessAssembleAudiobookJobDeps {
  prisma: PrismaClient;
  storage: StorageProvider;
  logger: Logger;
  envelope: QueueJobEnvelope<AssembleAudiobookCommandPayload>;
  queueManager: QueueManager;
  attemptsMade: number;
  maxAttempts: number;
}

/** Book-level chapter-to-chapter consistency threshold — a gentle trim, not a re-master. */
const LOUDNESS_CONSISTENCY_TOLERANCE_LU = 1;

export async function processAssembleAudiobookJob(deps: ProcessAssembleAudiobookJobDeps): Promise<void> {
  const { prisma, storage, logger, envelope, queueManager, attemptsMade, maxAttempts } = deps;

  const processingJobId = envelope.entity_id;
  if (!processingJobId) {
    throw new Error('assemble_audiobook envelope is missing entity_id (the ProcessingJob id)');
  }

  const job = await prisma.processingJob.findUnique({ where: { id: processingJobId } });
  if (!job) {
    throw new Error(`ProcessingJob ${processingJobId} not found`);
  }
  if (job.status === 'SUCCEEDED' || job.status === 'FAILED') {
    logger.info(
      { job_id: processingJobId, status: job.status },
      'Audiobook assembly job already terminal; skipping redelivered message',
    );
    return;
  }
  if (!job.bookId) {
    throw new Error(`ProcessingJob ${processingJobId} has no bookId`);
  }

  const deliveryFormats = envelope.payload.delivery_formats;
  if (!deliveryFormats || deliveryFormats.length === 0) {
    throw new Error(`assemble_audiobook envelope for job ${job.id} has no delivery_formats`);
  }

  const book = await prisma.book.findUnique({ where: { id: job.bookId } });
  if (!book) {
    throw new Error(`Book ${job.bookId} not found`);
  }

  // --- Readiness: a DB query, never a queue-message count (event-contracts.md §31.2). The
  // API-side enqueuer is expected to have checked this before creating this job, but a
  // worker-side assertion is cheap and this is what keeps the guarantee true "by
  // construction" rather than by trusting a caller. ---
  const readiness = await checkAudiobookReadiness(prisma, job.bookId);
  if (!readiness.ready || !readiness.bookVersionId) {
    await handleAudiobookNotReady({ prisma, logger, job });
    return;
  }
  const bookVersionId = readiness.bookVersionId;

  const chapters = await prisma.chapter.findMany({
    where: { bookVersionId },
    orderBy: { orderIndex: 'asc' },
    include: {
      chapterAudios: {
        where: { isCurrent: true, status: 'ASSEMBLED' },
        take: 1,
      },
    },
  });
  const orderedChapterAudios = chapters.map((c) => ({ chapter: c, chapterAudio: c.chapterAudios[0]! }));
  if (orderedChapterAudios.some((c) => !c.chapterAudio)) {
    // The readiness check above and this query can race with a concurrent supersession —
    // treat it the same as "not ready" rather than crashing.
    await handleAudiobookNotReady({ prisma, logger, job });
    return;
  }

  const directorVersions = new Set(orderedChapterAudios.map((c) => c.chapterAudio.directorVersion));
  if (directorVersions.size > 1) {
    await handleAudiobookAssemblyFailure({
      prisma,
      logger,
      job,
      errorCode: 'DIRECTOR_VERSION_MIXING_FORBIDDEN',
      message: `Book's chapters span multiple Director versions: ${[...directorVersions].join(', ')}.`,
    });
    return;
  }
  const directorVersion = orderedChapterAudios[0]!.chapterAudio.directorVersion;

  const manifestParts = orderedChapterAudios.map(
    (c) => `${c.chapterAudio.id}:${c.chapterAudio.contentHash}`,
  );
  const chapterManifestHash = computeManifestHash(manifestParts);

  // --- Idempotency + packaging-only resumability. ---
  const existing = await prisma.audiobook.findFirst({
    where: {
      bookVersionId,
      chapterManifestHash,
      status: { notIn: ['FAILED', 'SUPERSEDED'] },
    },
    orderBy: { version: 'desc' },
  });
  if (existing) {
    const missingFormats: string[] = [];
    for (const format of deliveryFormats) {
      const ready = await isDeliveryFormatReady(prisma, existing.id, format, orderedChapterAudios.length);
      if (!ready) missingFormats.push(format);
    }
    await withTransaction(prisma, async (tx: Tx) => {
      await tx.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'SUCCEEDED',
          statusChangedAt: new Date(),
          completedAt: new Date(),
          progress: 1,
          resultResourceType: 'audiobook',
          resultResourceId: existing.id,
          resultVersion: existing.version,
        },
      });
    });
    if (missingFormats.length === 0) {
      logger.info(
        { job_id: job.id, audiobook_id: existing.id },
        'Audiobook assembly is a no-op: manifest unchanged and every requested format is already READY',
      );
      return;
    }
    logger.info(
      { job_id: job.id, audiobook_id: existing.id, missing_formats: missingFormats },
      'Audiobook manifest unchanged; resuming with a packaging-only retry for the missing formats — no re-concatenation',
    );
    await enqueueEncodeJobs({ prisma, queueManager, job, audiobookId: existing.id, formats: missingFormats });
    return;
  }

  await prisma.processingJob.update({
    where: { id: job.id },
    data: {
      status: 'RUNNING',
      statusChangedAt: new Date(),
      startedAt: job.startedAt ?? new Date(),
      progressStage: 'ASSEMBLING',
      attemptCount: { increment: 1 },
    },
  });

  try {
    const audioToolModelVersionId = await resolveAudioToolModelVersionId(prisma);

    const bookVersion = await prisma.bookVersion.findUniqueOrThrow({ where: { id: bookVersionId } });
    const storyBibleChunk = await prisma.audioScriptChunk.findFirst({
      where: { bookId: job.bookId, isCurrent: true },
      orderBy: { sequenceIndex: 'asc' },
      select: { storyBibleVersionId: true },
    });
    if (!storyBibleChunk) {
      throw new Error(`No AudioScriptChunk found for book ${job.bookId} to resolve storyBibleVersionId`);
    }
    const chapterIds = orderedChapterAudios.map((c) => c.chapter.id);
    const ttsModelVersionRows = await prisma.audioChunk.findMany({
      where: { chapterId: { in: chapterIds }, isCurrent: true },
      select: { ttsModelVersionId: true },
      distinct: ['ttsModelVersionId'],
    });
    const ttsModelVersionIds = ttsModelVersionRows.map((r) => r.ttsModelVersionId);

    const nextVersion =
      ((await prisma.audiobook.aggregate({ where: { bookId: job.bookId! }, _max: { version: true } }))
        ._max.version ?? 0) + 1;
    const versionedKey = buildStorageKey({
      tenantId: job.tenantId,
      segments: ['books', job.bookId!, 'audiobook', `v${nextVersion}-master.wav`],
    });

    // Read + upload from WITHIN the temp-dir callback — `withTempDir` deletes the directory the
    // instant its callback resolves, so touching `assembled.masterPath` afterward would race a
    // deleted file (see the identical fix/comment in assembly-chapter.ts).
    const { assembled, putMeta } = await withTempDir(`assembly-audiobook-${job.id}-`, async (dir) => {
      const assembled = await assembleAudiobookMaster({ storage, dir, orderedChapterAudios });
      const bytes = await readFile(assembled.masterPath);
      const putMeta = await storage.put({ key: versionedKey, body: bytes, contentType: 'audio/wav' });
      return { assembled, putMeta };
    });

    const audiobookId = generateId();
    await withTransaction(prisma, async (tx: Tx) => {
      await tx.audiobook.updateMany({
        where: { bookId: job.bookId!, isCurrent: true },
        data: { isCurrent: false, supersededAt: new Date() },
      });
      await tx.audiobook.create({
        data: {
          id: audiobookId,
          tenantId: job.tenantId,
          bookId: job.bookId!,
          bookVersionId,
          version: nextVersion,
          isCurrent: true,
          isPreviewBuild: false,
          status: 'ASSEMBLING',
          containerFormat: deliveryFormats[0]!,
          durationMs: assembled.durationMs,
          chapterCount: orderedChapterAudios.length,
          metadataTitle: book.title,
          metadataAuthor: book.author,
          metadataNarratorCredit: null,
          aiNarrationDisclosed: true,
          metadataSeries: book.series,
          metadataSeriesIndex: book.seriesIndex,
          metadataPublisher: book.publisher,
          metadataLanguage: book.language,
          metadataPublicationYear: book.publicationYear,
          metadataDescription: book.description,
          bookWer: null,
          chunksFlagged: 0,
          asrCoverage: null,
          pipelineVersion: ASSEMBLY_PIPELINE_VERSION,
          directorVersion,
          ttsModelVersionIds,
          audioToolModelVersionId,
          sourceContentHash: bookVersion.contentHash,
          storyBibleVersionId: storyBibleChunk.storyBibleVersionId,
          chapterManifestHash,
          jobId: job.id,
          storageKey: versionedKey,
          storageBucket: putMeta.bucket,
          contentHash: putMeta.checksum.hash,
          sizeBytes: BigInt(putMeta.sizeBytes),
          objectVerifiedAt: new Date(),
        },
      });
      await tx.audiobookChapter.createMany({
        data: assembled.chapters.map((c, index) => ({
          audiobookId,
          orderIndex: index,
          chapterId: c.chapterId,
          chapterAudioId: c.chapterAudioId,
          bookId: job.bookId!,
          title: c.title,
          startMs: c.startMs,
          durationMs: c.durationMs,
        })),
      });
      await tx.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'SUCCEEDED',
          statusChangedAt: new Date(),
          completedAt: new Date(),
          progress: 1,
          progressStage: 'DONE',
          resultResourceType: 'audiobook',
          resultResourceId: audiobookId,
          resultVersion: nextVersion,
        },
      });
      await writeOutboxMessage(tx, {
        eventType: 'audiobook.assembly_started',
        schemaVersion: '1.0',
        tenantId: job.tenantId,
        bookId: job.bookId!,
        jobId: job.id,
        correlationId: job.correlationId,
        causationId: job.correlationId,
        producer: PRODUCER,
        producerVersion: PRODUCER_VERSION,
        aggregateType: 'audiobook',
        aggregateId: audiobookId,
        payload: {
          audiobook_id: audiobookId,
          book_version_id: bookVersionId,
          chapter_count: orderedChapterAudios.length,
          container_format: deliveryFormats[0]!,
        },
      });
    });

    logger.info(
      {
        job_id: job.id,
        book_id: job.bookId,
        audiobook_id: audiobookId,
        version: nextVersion,
        chapter_count: orderedChapterAudios.length,
        duration_ms: assembled.durationMs,
      },
      'Audiobook master assembled',
    );

    await enqueueEncodeJobs({ prisma, queueManager, job, audiobookId, formats: deliveryFormats });
  } catch (err) {
    await handleAudiobookAssemblyFailure({
      prisma,
      logger,
      job,
      errorCode: errorCodeOf(err, 'AUDIOBOOK_ASSEMBLY_FAILED'),
      message: errorMessage(err),
      errorClass: errorClassOf(err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------- assembly pipeline ----

interface AssembledAudiobookChapter {
  chapterId: string;
  chapterAudioId: string;
  title: string | null;
  startMs: number;
  durationMs: number;
}

interface AssembledAudiobook {
  masterPath: string;
  durationMs: number;
  chapters: AssembledAudiobookChapter[];
}

async function assembleAudiobookMaster(args: {
  storage: StorageProvider;
  dir: string;
  orderedChapterAudios: {
    chapter: { id: string; title: string | null };
    chapterAudio: { id: string; storageKey: string; directorVersion: string };
  }[];
}): Promise<AssembledAudiobook> {
  const { storage, dir, orderedChapterAudios } = args;
  const { canonicalSampleRateHz: sampleRate, canonicalChannels: channels } = MASTERING_POLICY_V1;

  // 1. Download every chapter master and measure its own integrated loudness (chapters are
  // already individually mastered — this measurement drives ONLY the consistency gain trim
  // below, never a re-run of loudnorm).
  const downloaded: { chapterId: string; chapterAudioId: string; title: string | null; path: string; integratedLufs: number; durationMs: number }[] =
    [];
  for (let i = 0; i < orderedChapterAudios.length; i++) {
    const { chapter, chapterAudio } = orderedChapterAudios[i]!;
    const rawPath = join(dir, `chapter-${i}-raw.wav`);
    await downloadToFile(storage, chapterAudio.storageKey, rawPath);
    const [probed, loudness] = await Promise.all([probeAudio(rawPath), measureEbur128(rawPath)]);
    downloaded.push({
      chapterId: chapter.id,
      chapterAudioId: chapterAudio.id,
      title: chapter.title,
      path: rawPath,
      integratedLufs: loudness.integratedLufs,
      durationMs: probed.durationMs,
    });
  }

  const meanLufs =
    downloaded.reduce((sum, c) => sum + c.integratedLufs, 0) / Math.max(downloaded.length, 1);

  // 2. Gentle per-chapter gain trim for chapters that drift more than the tolerance from the
  // book-wide mean — a plain `volume` filter, never a full `loudnorm` re-run (that would
  // re-flatten each chapter's already-correct internal dynamics).
  const finalPieces: { chapterId: string; chapterAudioId: string; title: string | null; path: string; durationMs: number }[] =
    [];
  for (let i = 0; i < downloaded.length; i++) {
    const c = downloaded[i]!;
    const deviation = c.integratedLufs - meanLufs;
    if (Math.abs(deviation) > LOUDNESS_CONSISTENCY_TOLERANCE_LU) {
      const gainDb = -deviation; // pull the outlier back toward the mean
      const trimmedPath = join(dir, `chapter-${i}-gaintrim.wav`);
      await applyGainAndConvert(c.path, trimmedPath, gainDb, { sampleRate, channels });
      const reprobed = await probeAudio(trimmedPath);
      finalPieces.push({
        chapterId: c.chapterId,
        chapterAudioId: c.chapterAudioId,
        title: c.title,
        path: trimmedPath,
        durationMs: reprobed.durationMs,
      });
    } else {
      finalPieces.push({
        chapterId: c.chapterId,
        chapterAudioId: c.chapterAudioId,
        title: c.title,
        path: c.path,
        durationMs: c.durationMs,
      });
    }
  }

  // 3. Concatenate — chapters are already individually mastered, so this is a lossless
  // `-c copy` concat, never a re-encode.
  const listPath = join(dir, 'audiobook-list.txt');
  await writeConcatFileList(listPath, finalPieces.map((p) => p.path));
  const masterPath = join(dir, 'audiobook-master.wav');
  await concatDemuxCopy(listPath, masterPath);

  // 4. Exact chapter start timestamps from the ACTUAL rendered per-chapter durations, verified
  // by assertion (not just documented) before being handed back for persistence.
  const chapters: AssembledAudiobookChapter[] = [];
  let cumulativeMs = 0;
  for (const piece of finalPieces) {
    chapters.push({
      chapterId: piece.chapterId,
      chapterAudioId: piece.chapterAudioId,
      title: piece.title,
      startMs: cumulativeMs,
      durationMs: piece.durationMs,
    });
    cumulativeMs += piece.durationMs;
  }
  for (let i = 0; i < chapters.length; i++) {
    const expectedStart = chapters.slice(0, i).reduce((sum, c) => sum + c.durationMs, 0);
    if (chapters[i]!.startMs !== expectedStart) {
      throw new Error(
        `Audiobook chapter start-time assertion failed at index ${i}: expected ${expectedStart}ms, got ${chapters[i]!.startMs}ms`,
      );
    }
  }

  const finalProbe = await probeAudio(masterPath);
  return { masterPath, durationMs: finalProbe.durationMs, chapters };
}

async function downloadToFile(storage: StorageProvider, key: string, destPath: string): Promise<void> {
  const { body } = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
  }
  await writeFile(destPath, Buffer.concat(chunks));
}

async function isDeliveryFormatReady(
  prisma: PrismaClient,
  audiobookId: string,
  format: string,
  chapterCount: number,
): Promise<boolean> {
  if (format === 'MP3_PER_CHAPTER') {
    const readyCount = await prisma.audiobookRendition.count({
      where: { audiobookId, format: 'MP3_PER_CHAPTER', status: 'READY', chapterId: { not: null } },
    });
    return readyCount === chapterCount;
  }
  const rendition = await prisma.audiobookRendition.findFirst({
    where: { audiobookId, format: format as never, status: 'READY', chapterId: null },
  });
  return Boolean(rendition);
}

async function enqueueEncodeJobs(args: {
  prisma: PrismaClient;
  queueManager: QueueManager;
  job: ProcessingJob;
  audiobookId: string;
  formats: string[];
}): Promise<void> {
  const { prisma, queueManager, job, audiobookId, formats } = args;
  for (const format of formats) {
    const encodeJobId = generateId();
    // Built once: persisted on the row and reused by the dispatch, so an
    // orphaned encode job can be recovered by ProcessingJobSweeper (F-4).
    const envelope = {
      job_id: encodeJobId,
      entity_id: encodeJobId,
      correlation_id: job.correlationId,
      tenant_id: job.tenantId,
      payload: { audiobook_id: audiobookId, format },
    };
    const now = new Date();
    await prisma.processingJob.create({
      data: {
        id: encodeJobId,
        tenantId: job.tenantId,
        bookId: job.bookId,
        type: 'encode_delivery_format',
        queue: 'audio',
        priority: job.priority,
        relatedResourceType: 'audiobook',
        relatedResourceId: audiobookId,
        parentJobId: job.id,
        // Reused (like assemble_chapter/assemble_audiobook reuse it for AssemblyJobScope) to
        // record which format THIS job encodes. `resolveRequestedDeliveryFormats`
        // (assembly-shared.ts) unions this across every encode_delivery_format job that has
        // ever pointed at this audiobookId — including ones created by an earlier,
        // already-superseded assemble_audiobook resumption — to recover "the full originally-
        // requested set" without a dedicated Audiobook column for it.
        scope: { format } as Prisma.InputJsonValue,
        status: 'CREATED',
        statusChangedAt: now,
        maxAttempts: 3,
        idempotencyKey: `encode_delivery_format:${audiobookId}:${format}`,
        idempotencyFingerprint: `${audiobookId}:${format}`,
        correlationId: job.correlationId,
        createdByUserId: job.createdByUserId,
        dispatchEnvelope: envelope,
      },
    });
    await enqueueProcessingJob(prisma, queueManager, {
      processingJobId: encodeJobId,
      queue: 'audio',
      envelope,
      jobName: 'encode_delivery_format',
      maxAttempts: 3,
    });
  }
}

// ---------------------------------------------------------------- failure handlers ----

async function handleAudiobookNotReady(args: {
  prisma: PrismaClient;
  logger: Logger;
  job: ProcessingJob;
}): Promise<void> {
  const { prisma, logger, job } = args;
  await handleAudiobookAssemblyFailure({
    prisma,
    logger,
    job,
    errorCode: 'CHAPTER_MANIFEST_INCOMPLETE',
    message: 'Not every current chapter of this book has a current ASSEMBLED ChapterAudio yet.',
  });
}

async function handleAudiobookAssemblyFailure(args: {
  prisma: PrismaClient;
  logger: Logger;
  job: ProcessingJob;
  errorCode: string;
  message: string;
  errorClass?: string;
}): Promise<void> {
  const { prisma, logger, job, errorCode, message, errorClass } = args;
  const now = new Date();
  await withTransaction(prisma, async (tx: Tx) => {
    const current = await tx.processingJob.findUnique({ where: { id: job.id } });
    if (!current || current.status === 'FAILED' || current.status === 'SUCCEEDED') return;
    await tx.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        statusChangedAt: now,
        completedAt: now,
        errorCode,
        errorClass: errorClass ?? 'ConflictError',
        errorMessage: message,
        errorRetryable: false,
        errorTerminal: true,
      },
    });
    await writeOutboxMessage(tx, {
      eventType: 'job.failed',
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
        job_id: job.id,
        error_code: errorCode,
        error_class: errorClass ?? 'ConflictError',
        failing_precondition: errorCode,
      },
    });
  });
  logger.info({ job_id: job.id, error_code: errorCode }, 'Audiobook assembly job failed terminally');
}

// Re-exported for tests that want to assert on the exact same tolerance the assembly pipeline
// uses without duplicating the literal.
export { LOUDNESS_CONSISTENCY_TOLERANCE_LU };
