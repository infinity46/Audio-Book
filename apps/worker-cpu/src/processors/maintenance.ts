import { withTransaction, type PrismaClient } from '@audio-book/database';
import { generateId, withInbox } from '@audio-book/events';
import { logError, type Logger } from '@audio-book/logging';
import type { QueueJobEnvelope } from '@audio-book/queue';
import type { StorageProvider } from '@audio-book/storage';

export interface MaintenanceEventPayload {
  event_id: string;
  event_type: string;
  schema_version: string;
  payload: { job_id: string; job_type: string; queue: string };
}

/**
 * Phase 10's real `cleanup_artifacts` payload shape, dispatched directly by
 * `BooksService.purgeBook` (`enqueueProcessingJob`, not the outbox relay —
 * see `books.service.ts`'s `purgeBookEnvelope` docstring). Distinguished
 * from `MaintenanceEventPayload` at runtime by the presence of `operation`.
 */
export interface MaintenanceCommandPayload {
  operation: 'purge_book';
  book_id: string;
}

export interface ProcessMaintenanceJobDeps {
  prisma: PrismaClient;
  storage: StorageProvider;
  logger: Logger;
  envelope: QueueJobEnvelope<MaintenanceEventPayload | MaintenanceCommandPayload>;
}

function isCommandPayload(
  payload: MaintenanceEventPayload | MaintenanceCommandPayload,
): payload is MaintenanceCommandPayload {
  return 'operation' in payload;
}

/**
 * Consumes `cleanup_artifacts` jobs from the `maintenance` queue. Two
 * payload shapes share this queue:
 *
 * 1. **The Phase 1 plumbing-proof shape** (`MaintenanceEventPayload`, no
 *    `operation` field) — `apps/api`'s `MaintenanceTestController` and the
 *    outbox-relay path in `common/providers.module.ts` still produce this.
 *    Unchanged: marks the `ProcessingJob` `SUCCEEDED` and does nothing else,
 *    exactly as it always has, so its own Phase 1 integration test does not
 *    regress.
 * 2. **The Phase 10 purge shape** (`MaintenanceCommandPayload`,
 *    `operation: 'purge_book'`) — runs the real bottom-up deletion from
 *    `database-schema.md` §27.4.
 */
export async function processMaintenanceJob({
  prisma,
  storage,
  logger,
  envelope,
}: ProcessMaintenanceJobDeps): Promise<void> {
  const processingJobId = envelope.entity_id;
  if (!processingJobId) {
    throw new Error('maintenance event envelope is missing entity_id (the ProcessingJob id)');
  }

  const payload = envelope.payload;
  if (isCommandPayload(payload)) {
    await runPurgeBook({ prisma, storage, logger, processingJobId, bookId: payload.book_id });
    return;
  }

  const { outcome } = await withTransaction(prisma, (tx) =>
    withInbox(tx, 'worker-cpu:maintenance', payload.event_id, async () => {
      await tx.processingJob.update({
        where: { id: processingJobId },
        data: { status: 'SUCCEEDED', statusChangedAt: new Date(), completedAt: new Date(), progress: 1 },
      });
    }),
  );

  logger.info(
    { job_id: processingJobId, event_id: payload.event_id, outcome },
    outcome === 'SKIPPED'
      ? 'Duplicate maintenance event skipped (already processed)'
      : 'Processed cleanup_artifacts job',
  );
}

/**
 * `database-schema.md` §27.4's 17-step bottom-up purge. Each step is its own
 * statement (object deletion first, then the rows that referenced those
 * objects — never the reverse, so a crash mid-step never leaves a row
 * pointing at bytes that are already gone) rather than one transaction for
 * the whole book: a book with millions of chunks would otherwise hold a
 * single transaction open for an unbounded time, and a step that already
 * succeeded must not be redone on retry. Every step's delete is naturally
 * idempotent — `deleteMany` matching zero rows, or deleting an
 * already-absent object, is success, not an error — so re-running this
 * function for the same book after a partial failure resumes correctly
 * rather than double-processing.
 */
async function runPurgeBook(args: {
  prisma: PrismaClient;
  storage: StorageProvider;
  logger: Logger;
  processingJobId: string;
  bookId: string;
}): Promise<void> {
  const { prisma, storage, logger, processingJobId, bookId } = args;
  const job = await prisma.processingJob.findUnique({ where: { id: processingJobId } });
  if (!job) {
    logger.warn({ job_id: processingJobId, book_id: bookId }, 'purge_book: ProcessingJob row not found');
    return;
  }
  if (job.status === 'SUCCEEDED') {
    logger.info({ job_id: processingJobId, book_id: bookId }, 'purge_book: already completed, skipping');
    return;
  }

  await prisma.processingJob.update({
    where: { id: processingJobId },
    data: { status: 'RUNNING', statusChangedAt: new Date() },
  });

  try {
    // 1. audiobook_rendition, audiobook_cover (+ objects)
    await purgeArtifactTable(prisma, storage, logger, 'audiobookRendition', bookId);
    await purgeArtifactTable(prisma, storage, logger, 'audiobookCover', bookId);
    // 2. audiobook_chapter, audiobook (+ objects)
    await deleteManyByBookId(prisma, 'audiobookChapter', bookId);
    await purgeArtifactTable(prisma, storage, logger, 'audiobook', bookId);
    // 3. chapter_audio_member, chapter_audio (+ objects)
    await deleteManyByBookId(prisma, 'chapterAudioMember', bookId);
    await purgeArtifactTable(prisma, storage, logger, 'chapterAudio', bookId);
    // 4. audio_chunk (+ objects)
    await purgeArtifactTable(prisma, storage, logger, 'audioChunk', bookId);
    // 5. tts_job
    await deleteManyByBookId(prisma, 'ttsJob', bookId);
    // 6. audio_script_chunk_source, audio_script_chunk, audio_script
    await deleteManyByBookId(prisma, 'audioScriptChunkSource', bookId);
    await deleteManyByBookId(prisma, 'audioScriptChunk', bookId);
    await deleteManyByBookId(prisma, 'audioScript', bookId);
    // 7. voice_preview (book-scoped), voice_assignment
    await purgeArtifactTable(prisma, storage, logger, 'voicePreview', bookId);
    await deleteManyByBookId(prisma, 'voiceAssignment', bookId);
    // 8. voice_profile (scope = BOOK only) (+ reference/embedding objects)
    await purgeBookScopedVoiceProfiles(prisma, storage, logger, bookId);
    // 9. narrative_embedding, narrative_summary, narrative_* facts,
    //    character_relationship, scene_semantics, narrative_state,
    //    story_bible_version, story_bible
    await deleteManyByBookId(prisma, 'narrativeEmbedding', bookId);
    await deleteManyByBookId(prisma, 'narrativeSummary', bookId);
    await deleteManyByBookId(prisma, 'narrativeLocation', bookId);
    await deleteManyByBookId(prisma, 'narrativeTimelineEvent', bookId);
    await deleteManyByBookId(prisma, 'narrativeObject', bookId);
    await deleteManyByBookId(prisma, 'narrativeFaction', bookId);
    await deleteManyByBookId(prisma, 'narrativeThread', bookId);
    await deleteManyByBookId(prisma, 'characterRelationship', bookId);
    await deleteManyByBookId(prisma, 'sceneSemantics', bookId);
    await deleteManyByBookId(prisma, 'narrativeState', bookId);
    await deleteManyByBookId(prisma, 'storyBibleVersion', bookId);
    await prisma.storyBible.deleteMany({ where: { bookId } });
    // 10. pronunciation_entry
    await deleteManyByBookId(prisma, 'pronunciationEntry', bookId);
    // 11. character_alias, character_merge, character
    await deleteManyByBookId(prisma, 'characterAlias', bookId);
    await deleteManyByBookId(prisma, 'characterMerge', bookId);
    await deleteManyByBookId(prisma, 'character', bookId);
    // 12. paragraph, scene, section, chapter, parsed_page
    await deleteManyByBookId(prisma, 'paragraph', bookId);
    await deleteManyByBookId(prisma, 'scene', bookId);
    await deleteManyByBookId(prisma, 'section', bookId);
    await deleteManyByBookId(prisma, 'chapter', bookId);
    await deleteManyByBookId(prisma, 'parsedPage', bookId);
    // 13. book_version (+ parsed/canonical objects)
    await purgeBookVersions(prisma, storage, logger, bookId);
    // 14. book_file (+ source object, if no other row references it)
    await purgeBookFiles(prisma, storage, logger, bookId, job.tenantId);
    // 15. processing_attempt, job_dependency, processing_job
    await purgeJobsAndAttempts(prisma, bookId, processingJobId);
    // 16. book_counter, book
    await prisma.bookCounter.deleteMany({ where: { bookId } });
    const deletedBook = await prisma.book.deleteMany({ where: { id: bookId } });
    if (deletedBook.count === 0) {
      logger.info({ book_id: bookId }, 'purge_book: book row already gone (retry of a prior success)');
    }

    // 17. audit_log row: BOOK_PURGED — written, never deleted (§27.3). This
    // is the row `BookPurgeGuard` checks to turn every subsequent request
    // for this bookId into 410 RESOURCE_PURGED.
    await prisma.auditLog.create({
      data: {
        id: generateId(),
        occurredAt: new Date(),
        tenantId: job.tenantId,
        actorKind: 'WORKER',
        action: 'BOOK_PURGED',
        resourceType: 'book',
        resourceId: bookId,
        bookId,
        correlationId: job.correlationId,
        outcome: 'SUCCESS',
      },
    });

    await prisma.processingJob.update({
      where: { id: processingJobId },
      data: { status: 'SUCCEEDED', statusChangedAt: new Date(), completedAt: new Date(), progress: 1 },
    });
    logger.info({ job_id: processingJobId, book_id: bookId }, 'Book purge completed');
  } catch (err) {
    logError(logger, err, 'Book purge step failed — job left retryable');
    await prisma.processingJob.update({
      where: { id: processingJobId },
      data: {
        status: 'FAILED',
        statusChangedAt: new Date(),
        errorClass: err instanceof Error ? err.constructor.name : 'UnknownError',
        errorMessage: (err instanceof Error ? err.message : 'Unknown error').slice(0, 2000),
        errorRetryable: true,
        errorTerminal: false,
      },
    });
    throw err;
  }
}

interface PrismaModelDelegate {
  findMany(args: {
    where: { bookId: string };
    select: { id: true; storageKey: true };
  }): Promise<{ id: string; storageKey: string | null }[]>;
  deleteMany(args: { where: { bookId: string } }): Promise<{ count: number }>;
}

type ArtifactModel =
  | 'audiobookRendition'
  | 'audiobookCover'
  | 'audiobook'
  | 'chapterAudio'
  | 'audioChunk'
  | 'voicePreview';

/**
 * Deletes every object a table's `bookId`-scoped rows reference, then the
 * rows themselves. Object deletion runs first and is best-effort per key
 * (`storage.delete` is treated as idempotent/safe against an already-gone
 * object, matching every `StorageProvider` implementation in this repo) —
 * a single unreachable object must not abort the whole purge, since the
 * dominant failure mode here is "already deleted by a previous, partially
 * failed attempt," not "storage is down."
 */
async function purgeArtifactTable(
  prisma: PrismaClient,
  storage: StorageProvider,
  logger: Logger,
  model: ArtifactModel,
  bookId: string,
): Promise<void> {
  const delegate = prisma[model] as unknown as PrismaModelDelegate;
  const rows = await delegate.findMany({ where: { bookId }, select: { id: true, storageKey: true } });
  await deleteObjects(
    storage,
    logger,
    rows.map((r) => r.storageKey),
  );
  await delegate.deleteMany({ where: { bookId } });
}

async function deleteObjects(storage: StorageProvider, logger: Logger, keys: (string | null)[]): Promise<void> {
  await Promise.all(
    keys
      .filter((key): key is string => Boolean(key))
      .map(async (key) => {
        try {
          await storage.delete(key);
        } catch (err) {
          // Logged, not thrown: an orphaned object is recoverable later by a
          // reconciliation sweep; aborting the whole purge over one
          // unreachable key is a worse outcome for the user who asked for
          // this book gone.
          logError(logger, err, `Failed to delete storage object during purge: ${key}`);
        }
      }),
  );
}

type SimpleBookScopedModel =
  | 'audiobookChapter'
  | 'chapterAudioMember'
  | 'ttsJob'
  | 'audioScriptChunkSource'
  | 'audioScriptChunk'
  | 'audioScript'
  | 'voiceAssignment'
  | 'narrativeEmbedding'
  | 'narrativeSummary'
  | 'narrativeLocation'
  | 'narrativeTimelineEvent'
  | 'narrativeObject'
  | 'narrativeFaction'
  | 'narrativeThread'
  | 'characterRelationship'
  | 'sceneSemantics'
  | 'narrativeState'
  | 'storyBibleVersion'
  | 'pronunciationEntry'
  | 'characterAlias'
  | 'characterMerge'
  | 'character'
  | 'paragraph'
  | 'scene'
  | 'section'
  | 'chapter'
  | 'parsedPage';

async function deleteManyByBookId(prisma: PrismaClient, model: SimpleBookScopedModel, bookId: string): Promise<void> {
  const delegate = prisma[model] as unknown as {
    deleteMany(args: { where: { bookId: string } }): Promise<unknown>;
  };
  await delegate.deleteMany({ where: { bookId } });
}

/**
 * Step 8: only `scope: 'BOOK'` voice profiles belong to this book and are
 * purged with it — `SYSTEM`/`TENANT`-scoped profiles are library resources
 * that outlive any single book. Versions are deleted before their parent
 * profile: `voice_profile_version.voiceProfileId` is `onDelete: Restrict`,
 * and `voice_profile.activeVersionId` is `onDelete: SetNull`, so deleting
 * versions first is both required by the `RESTRICT` and safe for the
 * `SET NULL` back-reference.
 */
async function purgeBookScopedVoiceProfiles(
  prisma: PrismaClient,
  storage: StorageProvider,
  logger: Logger,
  bookId: string,
): Promise<void> {
  const profiles = await prisma.voiceProfile.findMany({ where: { bookId, scope: 'BOOK' }, select: { id: true } });
  for (const profile of profiles) {
    const versions = await prisma.voiceProfileVersion.findMany({
      where: { voiceProfileId: profile.id },
      select: { id: true, referenceAudioStorageKey: true, embeddingStorageKey: true },
    });
    await deleteObjects(
      storage,
      logger,
      versions.flatMap((v) => [v.referenceAudioStorageKey, v.embeddingStorageKey]),
    );
    await prisma.voiceProfileVersion.deleteMany({ where: { voiceProfileId: profile.id } });
  }
  await prisma.voiceProfile.deleteMany({ where: { bookId, scope: 'BOOK' } });
}

/** Step 13: `book_version` carries three optional artifact keys, not one. */
async function purgeBookVersions(
  prisma: PrismaClient,
  storage: StorageProvider,
  logger: Logger,
  bookId: string,
): Promise<void> {
  const versions = await prisma.bookVersion.findMany({
    where: { bookId },
    select: { id: true, parsedDocumentStorageKey: true, ocrReportStorageKey: true, canonicalTextManifestStorageKey: true },
  });
  await deleteObjects(
    storage,
    logger,
    versions.flatMap((v) => [v.parsedDocumentStorageKey, v.ocrReportStorageKey, v.canonicalTextManifestStorageKey]),
  );
  await prisma.bookVersion.deleteMany({ where: { bookId } });
}

/**
 * Step 14: "the source object, if no other row references it" — `book_file`
 * rows can be deduplicated (the same content hash reused across multiple
 * uploads for a tenant), and §27.3 forbids deleting a stored object another
 * row still points at. A plain book-scoped `deleteMany` cannot express that
 * check, so this deletes object-by-object, skipping any whose `storageKey`
 * is still referenced by a `BookFile` row outside this book (the only
 * realistic survivor, since every in-book reference is being deleted in the
 * same operation).
 */
async function purgeBookFiles(
  prisma: PrismaClient,
  storage: StorageProvider,
  logger: Logger,
  bookId: string,
  tenantId: string,
): Promise<void> {
  const files = await prisma.bookFile.findMany({
    where: { bookId },
    select: { id: true, storageKey: true, sizeBytes: true },
  });
  let freedBytes = 0n;
  for (const file of files) {
    const otherReference = await prisma.bookFile.findFirst({
      where: { storageKey: file.storageKey, bookId: { not: bookId } },
      select: { id: true },
    });
    if (!otherReference) {
      await deleteObjects(storage, logger, [file.storageKey]);
      freedBytes += file.sizeBytes ?? 0n;
    }
  }
  await prisma.bookFile.deleteMany({ where: { bookId } });

  // Phase 10 quota completion: STORAGE_BYTES, the decrement side of
  // `books.service.ts#completeUploadSession`'s increment. Best-effort, same
  // reasoning as `QuotaService.recordUsage` on the API side — a failure here
  // is a billing inaccuracy, never a reason to fail (or re-fail) the purge.
  if (freedBytes > 0n) {
    await recordStorageBytesDelta(prisma, logger, tenantId, -freedBytes);
  }
}

async function recordStorageBytesDelta(
  prisma: PrismaClient,
  logger: Logger,
  tenantId: string,
  deltaBytes: bigint,
): Promise<void> {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  try {
    await prisma.tenantUsageCounter.upsert({
      where: { tenantId_periodStart_metric: { tenantId, periodStart, metric: 'STORAGE_BYTES' } },
      create: {
        id: generateId(),
        tenantId,
        periodStart,
        periodEnd,
        metric: 'STORAGE_BYTES',
        usedValue: deltaBytes > 0n ? deltaBytes : 0n,
      },
      update: { usedValue: { increment: deltaBytes } },
    });
  } catch (err) {
    logError(logger, err, 'STORAGE_BYTES usage counter update failed — usage under-reported');
  }
}

/**
 * Step 15: `job_dependency` has no `bookId` of its own — it hangs off
 * `processing_job` ids. The purge's own `ProcessingJob` row is excluded: it
 * is what is running this function, and `runPurgeBook` updates it to
 * `SUCCEEDED` once every step (including this one) has completed —
 * deleting it here would make that final write fail.
 */
async function purgeJobsAndAttempts(prisma: PrismaClient, bookId: string, purgeJobId: string): Promise<void> {
  await prisma.processingAttempt.deleteMany({ where: { bookId } });
  const jobs = await prisma.processingJob.findMany({
    where: { bookId, id: { not: purgeJobId } },
    select: { id: true },
  });
  const jobIds = jobs.map((j) => j.id);
  if (jobIds.length > 0) {
    await prisma.jobDependency.deleteMany({
      where: { OR: [{ jobId: { in: jobIds } }, { dependsOnJobId: { in: jobIds } }] },
    });
    await prisma.processingJob.deleteMany({ where: { id: { in: jobIds } } });
  }
}

export interface RetentionSweepConfig {
  /** §27.5: "failed artifacts retained for diagnosis for a bounded window, then expired." */
  orphanArtifactTtlHours: number;
  /** Reused as the storage-class-transition window for superseded audio chunks — see runRetentionSweep's docstring. */
  softDeleteDays: number;
}

export interface RetentionSweepResult {
  orphanedBookFilesExpired: number;
  supersededAudioChunksExpired: number;
}

/**
 * The two `retention_sweep` sub-responsibilities from Phase 10's plan,
 * distinct from `runPurgeBook` in one crucial way: this **never deletes a
 * row**, only object bytes — `storageClass -> 'EXPIRED'` and the key cleared
 * lets the row outlive its bytes (§4.4), exactly what §27.1's "retention
 * cleanup" row describes, as opposed to purge's "hard delete / permanent."
 *
 * 1. **Orphaned uploads.** A `BookFile` that failed validation
 *    (`status: 'REJECTED'`) has no purpose once past the diagnosis window —
 *    nothing ever admits it, and its bytes are pure cost from that point on.
 * 2. **Superseded audio chunks.** An `AudioChunk` with `isCurrent: false`
 *    is, by construction, not referenced by anything live (a newer
 *    generation superseded it) — but this only transitions it once its book
 *    additionally has a `COMPLETED` status with a current audiobook, the
 *    conservative reading of §27.5's "never while the audiobook is
 *    regenerable-on-demand and the user retains edit rights": a book still
 *    mid-pipeline might yet need to fall back to an older chunk.
 */
export async function runRetentionSweep(
  prisma: PrismaClient,
  storage: StorageProvider,
  logger: Logger,
  config: RetentionSweepConfig,
): Promise<RetentionSweepResult> {
  const orphanCutoff = new Date(Date.now() - config.orphanArtifactTtlHours * 60 * 60 * 1000);
  const chunkCutoff = new Date(Date.now() - config.softDeleteDays * 24 * 60 * 60 * 1000);

  const orphanedFiles = await prisma.bookFile.findMany({
    where: { status: 'REJECTED', storageClass: { not: 'EXPIRED' }, createdAt: { lt: orphanCutoff } },
    select: { id: true, storageKey: true },
  });
  await deleteObjects(
    storage,
    logger,
    orphanedFiles.map((f) => f.storageKey),
  );
  if (orphanedFiles.length > 0) {
    await prisma.bookFile.updateMany({
      where: { id: { in: orphanedFiles.map((f) => f.id) } },
      data: { storageClass: 'EXPIRED' },
    });
  }

  const eligibleBooks = await prisma.book.findMany({
    where: { status: 'COMPLETED', currentAudiobookId: { not: null }, deletedAt: null },
    select: { id: true },
  });
  const supersededChunks = await prisma.audioChunk.findMany({
    where: {
      bookId: { in: eligibleBooks.map((b) => b.id) },
      isCurrent: false,
      storageClass: 'STANDARD',
      createdAt: { lt: chunkCutoff },
    },
    select: { id: true, storageKey: true },
  });
  await deleteObjects(
    storage,
    logger,
    supersededChunks.map((c) => c.storageKey),
  );
  if (supersededChunks.length > 0) {
    await prisma.audioChunk.updateMany({
      where: { id: { in: supersededChunks.map((c) => c.id) } },
      data: { storageClass: 'EXPIRED' },
    });
  }

  const result = {
    orphanedBookFilesExpired: orphanedFiles.length,
    supersededAudioChunksExpired: supersededChunks.length,
  };
  logger.info(result, 'Retention sweep completed');
  return result;
}
