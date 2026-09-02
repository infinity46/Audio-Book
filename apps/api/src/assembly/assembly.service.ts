import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import { ConflictError, NotFoundError, ValidationError } from '@audio-book/errors';
import { generateId } from '@audio-book/events';
import { detectFormat } from '@audio-book/ingestion';
import type { Logger } from '@audio-book/logging';
import { enqueueProcessingJob, QueueManager } from '@audio-book/queue';
import { buildStorageKey, checksumBuffer, type StorageProvider } from '@audio-book/storage';
import type { StartAssembly, UpdateAudiobookMetadata } from '@audio-book/contracts';
import { LOGGER, PRISMA, QUEUE_MANAGER, STORAGE_PROVIDER } from '../common/tokens.js';
import { assertTenantOwnership } from '../common/tenant.js';
import { decodeCursor, paginate, parseLimit } from '../common/pagination.js';
import type { AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';
import { CoverUploadSessionStore, type CoverUploadSessionRecord } from './cover-upload-session.store.js';
import { readImageDimensions } from './image-dimensions.js';
import { stripExif } from './strip-exif.js';

const DEFAULT_DELIVERY_FORMATS: NonNullable<StartAssembly['delivery_formats']> = ['M4B'];
const COVER_UPLOAD_URL_TTL_SECONDS = 900;
const MAX_COVER_SIZE_BYTES = 10 * 1024 * 1024;
const COVER_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const MIN_COVER_DIMENSION_PX = 500;
const MAX_COVER_DIMENSION_PX = 6000;

export interface CreateAccessUrlBody {
  disposition?: 'INLINE' | 'ATTACHMENT';
  format?: string;
  expires_in_seconds?: number;
}

export interface InitiateCoverUploadBody {
  declared_mime_type: string;
  declared_size_bytes: number;
  declared_content_hash: { algorithm: 'SHA256'; value: string };
}

export interface ConfirmCoverUploadBody {
  upload_session_id: string;
  observed_size_bytes: number;
}

export type PutAudiobookCoverBody = InitiateCoverUploadBody | ConfirmCoverUploadBody;

function isConfirmCoverBody(body: PutAudiobookCoverBody): body is ConfirmCoverUploadBody {
  return typeof (body as ConfirmCoverUploadBody).upload_session_id === 'string';
}

/**
 * Audio assembly orchestration (`api-specification.md` §16.16/§16.17/§16.20)
 * and read access to the `ChapterAudio`/`Audiobook` artifacts the `worker-cpu`
 * `assemble_chapter`/`assemble_audiobook`/`encode_delivery_format` pipeline
 * produces. Mirrors `tts.service.ts`'s shape.
 *
 * **Known scope limitations** (see the accompanying implementation report for
 * the full rationale):
 * 1. Voice-consistency precondition (`api-specification.md` §16.16 check 2,
 *    `409 VOICE_CONSISTENCY_VIOLATION`) is NOT implemented — only checks 1, 3,
 *    and 4 (manifest completeness, Director version mixing, book metadata)
 *    are enforced here, per the approved plan's explicit precondition list.
 * 2. `PATCH .../audiobooks/:id` and `PUT .../audiobooks/:id/cover` both gate
 *    on `Audiobook.status === 'DRAFT_METADATA'`. Nothing in this pipeline
 *    (nor in `worker-cpu`'s `assemble_audiobook`, per `event-contracts.md`
 *    §11.15) ever creates an `Audiobook` row in that state — it goes straight
 *    to `ASSEMBLING`. Both endpoints are therefore reachable but will always
 *    respond `409 AUDIOBOOK_IMMUTABLE` against any audiobook this pipeline
 *    currently produces. The full mechanics are implemented and tested so
 *    they activate automatically if a future draft-metadata creation path is
 *    added.
 */
@Injectable()
export class AssemblyService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUE_MANAGER) private readonly queueManager: QueueManager,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly coverSessions: CoverUploadSessionStore,
  ) {}

  // ------------------------------------------------------------ assembly ----

  async startAssembly(principal: AuthenticatedPrincipal, bookId: string, body: StartAssembly) {
    const book = await this.requireOwnedBook(principal, bookId);
    const deliveryFormats = body.delivery_formats ?? DEFAULT_DELIVERY_FORMATS;
    const priority = body.priority ?? 'NORMAL';

    const targetChapters = await this.resolveTargetChapters(principal, bookId, book, body);
    if (targetChapters.length === 0) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'No chapters matched the requested scope.',
      });
    }

    const scriptChunks = await this.prisma.audioScriptChunk.findMany({
      where: { chapterId: { in: targetChapters.map((c) => c.id) }, isCurrent: true },
      include: { currentAudioChunk: true },
      orderBy: [{ chapterId: 'asc' }, { chapterSequenceIndex: 'asc' }],
    });

    const byChapter = new Map<string, typeof scriptChunks>();
    for (const chunk of scriptChunks) {
      const list = byChapter.get(chunk.chapterId) ?? [];
      list.push(chunk);
      byChapter.set(chunk.chapterId, list);
    }

    const completeChapterIds: string[] = [];
    const incompleteChapterIds: string[] = [];
    for (const chapter of targetChapters) {
      const chunks = byChapter.get(chapter.id) ?? [];
      const complete =
        chunks.length > 0 && chunks.every((c) => c.currentAudioChunk?.status === 'VALIDATED');
      if (complete) completeChapterIds.push(chapter.id);
      else incompleteChapterIds.push(chapter.id);
    }

    if (incompleteChapterIds.length > 0 && !body.allow_partial_preview) {
      throw new ConflictError({
        code: 'CHAPTER_MANIFEST_INCOMPLETE',
        message: `${incompleteChapterIds.length} chapter(s) have an incomplete or unvalidated chunk manifest.`,
        details: incompleteChapterIds
          .slice(0, 20)
          .map((id) => ({ field: 'chapter_ids', issue: `incomplete_manifest: ${id}` })),
      });
    }

    // With allow_partial_preview, incomplete chapters are dropped from the
    // assembled set and surfaced back as `blocking` instead of failing the
    // whole request.
    const candidateChapterIds = new Set(completeChapterIds);

    const candidateChunks = scriptChunks.filter((c) => candidateChapterIds.has(c.chapterId));
    const directorVersions = new Set(candidateChunks.map((c) => c.directorVersion));
    if (directorVersions.size > 1) {
      throw new ConflictError({
        code: 'DIRECTOR_VERSION_MIXING_FORBIDDEN',
        message: 'The requested scope mixes more than one Director version.',
        details: [...directorVersions].map((v) => ({ field: 'director_version', issue: v })),
      });
    }

    if (body.scope === 'AUDIOBOOK') {
      const missingMetadata: string[] = [];
      if (!book.title) missingMetadata.push('title');
      if (!book.author) missingMetadata.push('author');
      if (!book.language) missingMetadata.push('language');
      if (missingMetadata.length > 0) {
        throw new ValidationError({
          code: 'VALIDATION_FAILED',
          message: 'Book metadata is not sufficient to assemble an audiobook container.',
          details: missingMetadata.map((field) => ({ field, issue: 'required' })),
        });
      }
    }

    // Per-chapter manifest hash + skip-if-unchanged (unless force).
    const existingChapterAudios = await this.prisma.chapterAudio.findMany({
      where: { chapterId: { in: [...candidateChapterIds] }, isCurrent: true },
    });
    const existingByChapter = new Map(existingChapterAudios.map((ca) => [ca.chapterId, ca]));

    const toAssemble: { chapterId: string; manifestHash: string }[] = [];
    const skippedChapterIds: string[] = [];
    for (const chapterId of candidateChapterIds) {
      const chunks = (byChapter.get(chapterId) ?? []).slice().sort(
        (a, b) => a.chapterSequenceIndex - b.chapterSequenceIndex,
      );
      const manifestHash = chunkManifestHash(
        chunks.map((c) => ({
          id: c.currentAudioChunk!.id,
          contentHash: c.currentAudioChunk!.contentHash,
        })),
      );
      const existing = existingByChapter.get(chapterId);
      if (existing && existing.chunkManifestHash === manifestHash && !body.force) {
        skippedChapterIds.push(chapterId);
        continue;
      }
      toAssemble.push({ chapterId, manifestHash });
    }

    const now = new Date();
    const created: {
      jobId: string;
      chapterId: string;
      envelope: {
        job_id: string;
        entity_id: string;
        correlation_id: string;
        tenant_id: string;
        payload: { chapter_id: string };
      };
    }[] = [];

    if (toAssemble.length > 0) {
      await withTransaction(this.prisma, async (tx) => {
        for (const { chapterId, manifestHash } of toAssemble) {
          const jobId = generateId();
          const envelope = {
            job_id: jobId,
            entity_id: jobId,
            correlation_id: jobId,
            tenant_id: principal.tenantId,
            payload: { chapter_id: chapterId },
          };
          await tx.processingJob.create({
            data: {
              id: jobId,
              tenantId: principal.tenantId,
              bookId,
              type: 'assemble_chapter',
              queue: 'audio',
              priority,
              relatedResourceType: 'chapter',
              relatedResourceId: chapterId,
              status: 'CREATED',
              statusChangedAt: now,
              maxAttempts: 3,
              idempotencyKey: `assemble_chapter:${chapterId}:${manifestHash}`,
              idempotencyFingerprint: manifestHash,
              correlationId: jobId,
              forced: Boolean(body.force),
              createdByUserId: principal.sub,
              // worker-cpu's assembly-shared.ts `readJobScope` reads this column
              // to decide whether a chapter's completion should auto-trigger
              // `assemble_audiobook` fan-in — only ever compared against the
              // literal 'AUDIOBOOK' value, so `body.scope` (this schema's
              // 'CHAPTER'|'AUDIOBOOK' enum) is passed through as-is.
              scope: { scope: body.scope, delivery_formats: deliveryFormats } as Prisma.InputJsonValue,
              // One definition, two uses: persisted here so the sweeper can
              // recover this job, and handed to the dispatch below verbatim so
              // the two cannot drift (F-4).
              dispatchEnvelope: envelope,
            },
          });
          created.push({ jobId, chapterId, envelope });
        }

        await tx.book.update({
          where: { id: bookId },
          data: { status: 'ASSEMBLING', statusChangedAt: now },
        });
      });

      await Promise.all(
        created.map(({ jobId, envelope }) =>
          enqueueProcessingJob(this.prisma, this.queueManager, {
            processingJobId: jobId,
            queue: 'audio',
            envelope,
            jobName: 'assemble_chapter',
            maxAttempts: 3,
          }),
        ),
      );
    }

    let audiobookJobId: string | null = null;

    // If every target chapter is already up to date, the worker-side
    // "last chapter completed" fan-in trigger never fires, so for scope
    // AUDIOBOOK we enqueue assemble_audiobook ourselves in that case.
    if (body.scope === 'AUDIOBOOK' && toAssemble.length === 0 && incompleteChapterIds.length === 0) {
      audiobookJobId = await this.maybeEnqueueAssembleAudiobook({
        principal,
        book,
        chapterIds: [...candidateChapterIds],
        deliveryFormats,
        priority,
        force: Boolean(body.force),
      });
    }

    this.logger.info(
      {
        book_id: bookId,
        scope: body.scope,
        planned_unit_count: created.length + (audiobookJobId ? 1 : 0),
        skipped_chapter_count: skippedChapterIds.length,
        blocking_chapter_count: incompleteChapterIds.length,
      },
      'Enqueued assembly commands',
    );

    return {
      job: null,
      accepted: {
        scope: body.scope,
        chapter_ids: created.map((c) => c.chapterId),
        planned_unit_count: created.length + (audiobookJobId ? 1 : 0),
        delivery_formats: deliveryFormats,
        priority,
        skipped_chapter_ids: skippedChapterIds,
        blocking: incompleteChapterIds,
        audiobook_job_id: audiobookJobId,
      },
    };
  }

  /**
   * Computes the book-wide chapter manifest hash and, unless a matching
   * `READY` Audiobook with every requested format already exists (or
   * `force` is set), creates + enqueues the `assemble_audiobook` job.
   * Returns the created job id, or `null` if nothing needed to run.
   */
  private async maybeEnqueueAssembleAudiobook(args: {
    principal: AuthenticatedPrincipal;
    book: { id: string; currentBookVersionId: string | null };
    chapterIds: string[];
    deliveryFormats: NonNullable<StartAssembly['delivery_formats']>;
    priority: 'INTERACTIVE' | 'NORMAL' | 'BULK';
    force: boolean;
  }): Promise<string | null> {
    const { principal, book, chapterIds, deliveryFormats, priority, force } = args;
    if (!book.currentBookVersionId) return null;

    const chapters = await this.prisma.chapter.findMany({
      where: { id: { in: chapterIds } },
      orderBy: { orderIndex: 'asc' },
    });
    const chapterAudios = await this.prisma.chapterAudio.findMany({
      where: { chapterId: { in: chapterIds }, isCurrent: true },
    });
    const chapterAudioByChapter = new Map(chapterAudios.map((ca) => [ca.chapterId, ca]));
    const orderedChapterAudios = chapters.map((c) => chapterAudioByChapter.get(c.id));
    if (orderedChapterAudios.some((ca) => !ca)) return null; // not actually all assembled — defensive

    const manifestHash = chapterManifestHash(
      orderedChapterAudios.map((ca) => ({ id: ca!.id, contentHash: ca!.contentHash })),
    );
    const primaryFormat = deliveryFormats[0] ?? 'M4B';

    if (!force) {
      const existing = await this.prisma.audiobook.findFirst({
        where: { bookId: book.id, chapterManifestHash: manifestHash, status: 'READY' },
        include: { renditions: true },
      });
      if (existing) {
        const readyFormats = new Set<string>([
          existing.containerFormat,
          ...existing.renditions.filter((r) => r.status === 'READY').map((r) => r.format),
        ]);
        if (deliveryFormats.every((f: string) => readyFormats.has(f))) return null;
      }
    }

    const jobId = generateId();
    const now = new Date();
    const envelope = {
      job_id: jobId,
      entity_id: jobId,
      correlation_id: jobId,
      tenant_id: principal.tenantId,
      payload: { book_id: book.id, delivery_formats: deliveryFormats },
    };
    await this.prisma.processingJob.create({
      data: {
        id: jobId,
        tenantId: principal.tenantId,
        bookId: book.id,
        type: 'assemble_audiobook',
        queue: 'audio',
        priority,
        relatedResourceType: 'book_version',
        relatedResourceId: book.currentBookVersionId,
        status: 'CREATED',
        statusChangedAt: now,
        maxAttempts: 3,
        idempotencyKey: `assemble_audiobook:${book.currentBookVersionId}:${manifestHash}:${primaryFormat}`,
        idempotencyFingerprint: manifestHash,
        correlationId: jobId,
        forced: force,
        createdByUserId: principal.sub,
        dispatchEnvelope: envelope,
      },
    });

    await enqueueProcessingJob(this.prisma, this.queueManager, {
      processingJobId: jobId,
      queue: 'audio',
      envelope,
      jobName: 'assemble_audiobook',
      maxAttempts: 3,
    });

    return jobId;
  }

  private async resolveTargetChapters(
    principal: AuthenticatedPrincipal,
    bookId: string,
    book: { currentBookVersionId: string | null },
    body: StartAssembly,
  ) {
    if (body.scope === 'CHAPTER') {
      if (!body.chapter_ids?.length) {
        throw new ValidationError({
          code: 'VALIDATION_FAILED',
          message: 'chapter_ids is required for scope CHAPTER.',
        });
      }
      return this.prisma.chapter.findMany({
        where: { id: { in: body.chapter_ids }, bookId },
        orderBy: { orderIndex: 'asc' },
      });
    }
    // AUDIOBOOK — every current chapter of the book's current BookVersion.
    if (!book.currentBookVersionId) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'Book has no ingested version to assemble.',
      });
    }
    return this.prisma.chapter.findMany({
      where: { bookVersionId: book.currentBookVersionId },
      orderBy: { orderIndex: 'asc' },
    });
  }

  async getAssemblyState(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.requireOwnedBook(principal, bookId);
    const chapters = book.currentBookVersionId
      ? await this.prisma.chapter.findMany({
          where: { bookVersionId: book.currentBookVersionId },
          orderBy: { orderIndex: 'asc' },
        })
      : [];
    const chapterAudios = await this.prisma.chapterAudio.findMany({
      where: { chapterId: { in: chapters.map((c) => c.id) }, isCurrent: true },
    });
    const chapterAudioByChapter = new Map(chapterAudios.map((ca) => [ca.chapterId, ca]));

    const chaptersAssembled = chapters.filter(
      (c) => chapterAudioByChapter.get(c.id)?.status === 'ASSEMBLED',
    ).length;
    const blocking = chapters
      .filter((c) => chapterAudioByChapter.get(c.id)?.status !== 'ASSEMBLED')
      .map((c) => c.id);

    const audiobook = await this.currentOrLatestAudiobook(bookId);
    const renditions = audiobook
      ? await this.prisma.audiobookRendition.findMany({ where: { audiobookId: audiobook.id } })
      : [];
    const deliveryFormats = audiobook
      ? [...new Set([audiobook.containerFormat, ...renditions.map((r) => r.format)])]
      : [];

    const verifiedFlags = chapters
      .map((c) => chapterAudioByChapter.get(c.id))
      .filter((ca): ca is NonNullable<typeof ca> => ca?.status === 'ASSEMBLED')
      .map((ca) => ca.voiceConsistencyVerified);
    const voiceConsistencyVerified =
      verifiedFlags.length === 0 ? null : verifiedFlags.every(Boolean);

    const currentJob = await this.prisma.processingJob.findFirst({
      where: {
        bookId,
        type: { in: ['assemble_chapter', 'assemble_audiobook'] },
        status: { in: ['CREATED', 'QUEUED', 'RUNNING', 'RETRYING', 'BLOCKED'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      object: 'assembly_state' as const,
      book_id: bookId,
      status: deriveGenerationStatus(audiobook, chapters.length, chaptersAssembled),
      scope: audiobook ? ('AUDIOBOOK' as const) : ('CHAPTER' as const),
      chapters_assembled: chaptersAssembled,
      chapters_total: chapters.length,
      audiobook_id: audiobook?.id ?? null,
      delivery_formats: deliveryFormats,
      // `checked_characters` has no cheap source in this codebase (it would
      // require re-deriving the full voice-consistency check this service
      // does not implement — see the class-level doc comment) — reported as
      // `null` rather than fabricated. `verified` is a real read of
      // `ChapterAudio.voice_consistency_verified`, written by the worker.
      voice_consistency: { verified: voiceConsistencyVerified, checked_characters: null },
      blocking,
      current_job_id: currentJob?.id ?? null,
      history: [] as unknown[],
      links: {
        self: `/api/v1/books/${bookId}/assembly`,
        chapter_audio: `/api/v1/books/${bookId}/chapter-audio`,
        audiobooks: `/api/v1/books/${bookId}/audiobooks`,
      },
    };
  }

  private async currentOrLatestAudiobook(bookId: string) {
    return this.prisma.audiobook.findFirst({
      where: { bookId, isCurrent: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // -------------------------------------------------------- chapter audio ----

  async listChapterAudio(
    principal: AuthenticatedPrincipal,
    bookId: string,
    query: { chapter_id?: string; status?: string; cursor?: string; limit?: string },
  ) {
    await this.requireOwnedBook(principal, bookId);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const where: Prisma.ChapterAudioWhereInput = { bookId, isCurrent: true };
    if (query.chapter_id) where.chapterId = query.chapter_id;
    if (query.status) where.status = query.status as never;
    if (cursor) where.chapter = { orderIndex: { gt: Number(cursor.v) } };

    const rows = await this.prisma.chapterAudio.findMany({
      where,
      include: { chapter: { select: { orderIndex: true } } },
      orderBy: { chapter: { orderIndex: 'asc' } },
      take: limit + 1,
    });
    const page = paginate(
      rows,
      limit,
      (r) => r.chapter.orderIndex,
      (r) => r.id,
    );
    return { data: page.data.map((r) => this.toChapterAudioDto(r)), page: page.page };
  }

  async getChapterAudio(principal: AuthenticatedPrincipal, bookId: string, chapterAudioId: string) {
    await this.requireOwnedBook(principal, bookId);
    const row = await this.prisma.chapterAudio.findFirst({ where: { id: chapterAudioId, bookId } });
    if (!row) throw new NotFoundError({ message: 'Chapter audio not found.' });
    return this.toChapterAudioDto(row);
  }

  async createChapterAudioAccessUrl(
    principal: AuthenticatedPrincipal,
    bookId: string,
    chapterAudioId: string,
    body: CreateAccessUrlBody,
  ) {
    await this.requireOwnedBook(principal, bookId);
    const row = await this.prisma.chapterAudio.findFirst({ where: { id: chapterAudioId, bookId } });
    if (!row) throw new NotFoundError({ message: 'Chapter audio not found.' });
    if (row.status !== 'ASSEMBLED') {
      throw new ConflictError({
        code: 'ARTIFACT_NOT_READY',
        message: `Chapter audio is ${row.status}; bytes are not available.`,
      });
    }
    const expiresIn = body.expires_in_seconds ?? 300;
    const url = await this.storage.getSignedUrl(row.storageKey, 'GET', expiresIn);
    return {
      object: 'access_url' as const,
      url,
      method: 'GET' as const,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      disposition: body.disposition ?? 'INLINE',
      content_type: audioFormatContentType(row.format),
      duration_ms: row.durationMs,
      size_bytes: row.sizeBytes ? Number(row.sizeBytes) : null,
      content_hash: { algorithm: 'sha256' as const, value: row.contentHash },
    };
  }

  private toChapterAudioDto(row: {
    id: string;
    bookId: string;
    chapterId: string;
    version: number;
    supersedesChapterAudioId: string | null;
    isCurrent: boolean;
    isPreviewBuild: boolean;
    status: string;
    durationMs: number;
    chunkCount: number;
    chunkManifestHash: string;
    format: string;
    integratedLufs: number | null;
    truePeakDbtp: number | null;
    directorVersion: string;
    pipelineVersion: string;
    audioToolModelVersionId: string;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      object: 'chapter_audio' as const,
      book_id: row.bookId,
      chapter_id: row.chapterId,
      version: row.version,
      supersedes_chapter_audio_id: row.supersedesChapterAudioId,
      is_current: row.isCurrent,
      is_preview_build: row.isPreviewBuild,
      status: row.status,
      technical: {
        duration_ms: row.durationMs,
        chunk_count: row.chunkCount,
        format: row.format,
      },
      chunk_manifest_hash: row.chunkManifestHash,
      loudness: { integrated_lufs: row.integratedLufs, true_peak_dbtp: row.truePeakDbtp },
      lineage: {
        director_version: row.directorVersion,
        pipeline_version: row.pipelineVersion,
        audio_tool_model_version_id: row.audioToolModelVersionId,
      },
      created_at: row.createdAt.toISOString(),
      links: {
        self: `/api/v1/books/${row.bookId}/chapter-audio/${row.id}`,
        chapter: `/api/v1/books/${row.bookId}/chapters/${row.chapterId}`,
        access_urls: `/api/v1/books/${row.bookId}/chapter-audio/${row.id}/access-urls`,
      },
    };
  }

  // ---------------------------------------------------- audiobook project ----

  async getAudiobookProject(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.requireOwnedBook(principal, bookId);
    const chapters = book.currentBookVersionId
      ? await this.prisma.chapter.findMany({
          where: { bookVersionId: book.currentBookVersionId },
          orderBy: { orderIndex: 'asc' },
        })
      : [];
    const chapterAudios = await this.prisma.chapterAudio.findMany({
      where: { chapterId: { in: chapters.map((c) => c.id) }, isCurrent: true },
    });
    const chapterAudioByChapter = new Map(chapterAudios.map((ca) => [ca.chapterId, ca]));

    const audiobook = await this.currentOrLatestAudiobook(bookId);
    const versionCount = await this.prisma.audiobook.count({ where: { bookId } });

    const chaptersAssembled = chapters.filter(
      (c) => chapterAudioByChapter.get(c.id)?.status === 'ASSEMBLED',
    ).length;
    const totalDurationMs = chapters.reduce(
      (sum, c) => sum + (chapterAudioByChapter.get(c.id)?.durationMs ?? 0),
      0,
    );

    let stale = false;
    if (audiobook) {
      const [bookVersion, storyBible] = await Promise.all([
        book.currentBookVersionId
          ? this.prisma.bookVersion.findUnique({ where: { id: book.currentBookVersionId } })
          : null,
        this.prisma.storyBible.findUnique({ where: { bookId } }),
      ]);
      // Cheap staleness proxy (documented approximation — see class doc
      // comment / implementation report): compares the current Audiobook's
      // recorded content/story-bible lineage against the book's *current*
      // pointers, rather than recomputing a fresh chapter manifest hash on
      // every GET.
      stale =
        (bookVersion != null && audiobook.sourceContentHash !== bookVersion.contentHash) ||
        (storyBible?.currentVersionId != null &&
          audiobook.storyBibleVersionId !== storyBible.currentVersionId);
    }

    return {
      object: 'audiobook_project' as const,
      book_id: bookId,
      generation_status: stale
        ? ('STALE' as const)
        : deriveGenerationStatus(audiobook, chapters.length, chaptersAssembled),
      current_audiobook_id: audiobook?.id ?? null,
      current_version: audiobook?.version ?? null,
      version_count: versionCount,
      chapters: chapters.map((c) => {
        const ca = chapterAudioByChapter.get(c.id);
        return {
          chapter_id: c.id,
          order_index: c.orderIndex,
          title: c.title,
          chapter_audio_id: ca?.id ?? null,
          status: ca?.status ?? 'PENDING',
          duration_ms: ca?.durationMs ?? null,
        };
      }),
      totals: {
        chapters: chapters.length,
        chapters_assembled: chaptersAssembled,
        duration_ms: totalDurationMs,
      },
      blocking: chapters
        .filter((c) => chapterAudioByChapter.get(c.id)?.status !== 'ASSEMBLED')
        .map((c) => c.id),
      links: {
        self: `/api/v1/books/${bookId}/audiobook`,
        versions: `/api/v1/books/${bookId}/audiobooks`,
        current: audiobook ? `/api/v1/books/${bookId}/audiobooks/${audiobook.id}` : null,
      },
    };
  }

  // ------------------------------------------------------- audiobook CRUD ----

  async listAudiobooks(
    principal: AuthenticatedPrincipal,
    bookId: string,
    query: { include_superseded?: string; format?: string; cursor?: string; limit?: string },
  ) {
    await this.requireOwnedBook(principal, bookId);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const where: Prisma.AudiobookWhereInput = { bookId };
    if (query.include_superseded !== 'true') where.isCurrent = true;
    if (query.format) where.OR = [{ containerFormat: query.format }, { renditions: { some: { format: query.format as never } } }];
    if (cursor) where.version = { lt: Number(cursor.v) };

    const rows = await this.prisma.audiobook.findMany({
      where,
      include: { chapters: { orderBy: { orderIndex: 'asc' } }, renditions: true, cover: true },
      orderBy: { version: 'desc' },
      take: limit + 1,
    });
    const page = paginate(
      rows,
      limit,
      (r) => r.version,
      (r) => r.id,
    );
    return { data: page.data.map((r) => this.toAudiobookDto(r)), page: page.page };
  }

  async getAudiobook(principal: AuthenticatedPrincipal, bookId: string, audiobookId: string) {
    await this.requireOwnedBook(principal, bookId);
    const row = await this.prisma.audiobook.findFirst({
      where: { id: audiobookId, bookId },
      include: { chapters: { orderBy: { orderIndex: 'asc' } }, renditions: true, cover: true },
    });
    if (!row) throw new NotFoundError({ message: 'Audiobook not found.' });
    return this.toAudiobookDto(row);
  }

  async updateAudiobookMetadata(
    principal: AuthenticatedPrincipal,
    bookId: string,
    audiobookId: string,
    body: UpdateAudiobookMetadata,
  ) {
    await this.requireOwnedBook(principal, bookId);
    const audiobook = await this.requireOwnedAudiobook(bookId, audiobookId);
    if (audiobook.status !== 'DRAFT_METADATA') {
      throw new ConflictError({
        code: 'AUDIOBOOK_IMMUTABLE',
        message: `Audiobook is ${audiobook.status}; presentational metadata can no longer be patched. Assemble a new version instead.`,
      });
    }

    const data: Prisma.AudiobookUpdateInput = {};
    if (body.title !== undefined) data.metadataTitle = body.title;
    if (body.author !== undefined) data.metadataAuthor = body.author;
    if (body.narrator_credit !== undefined) data.metadataNarratorCredit = body.narrator_credit;
    if (body.series !== undefined) data.metadataSeries = body.series;
    if (body.series_index !== undefined) data.metadataSeriesIndex = body.series_index;
    if (body.publisher !== undefined) data.metadataPublisher = body.publisher;
    if (body.language !== undefined) data.metadataLanguage = body.language;
    if (body.publication_year !== undefined) data.metadataPublicationYear = body.publication_year;
    if (body.description !== undefined) data.metadataDescription = body.description;

    const updated = await this.prisma.audiobook.update({
      where: { id: audiobookId },
      data,
      include: { chapters: { orderBy: { orderIndex: 'asc' } }, renditions: true, cover: true },
    });
    return this.toAudiobookDto(updated);
  }

  async createAudiobookAccessUrl(
    principal: AuthenticatedPrincipal,
    bookId: string,
    audiobookId: string,
    body: CreateAccessUrlBody,
  ) {
    await this.requireOwnedBook(principal, bookId);
    const audiobook = await this.requireOwnedAudiobook(bookId, audiobookId);
    if (audiobook.status !== 'READY') {
      throw new ConflictError({
        code: 'ARTIFACT_NOT_READY',
        message: `Audiobook is ${audiobook.status}; bytes are not available.`,
      });
    }

    const expiresIn = body.expires_in_seconds ?? 300;
    if (!body.format || body.format === audiobook.containerFormat) {
      const url = await this.storage.getSignedUrl(audiobook.storageKey, 'GET', expiresIn);
      return {
        object: 'access_url' as const,
        url,
        method: 'GET' as const,
        expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
        disposition: body.disposition ?? 'INLINE',
        format: audiobook.containerFormat,
        content_type: containerFormatContentType(audiobook.containerFormat),
        duration_ms: audiobook.durationMs,
        size_bytes: audiobook.sizeBytes ? Number(audiobook.sizeBytes) : null,
        content_hash: { algorithm: 'sha256' as const, value: audiobook.contentHash },
      };
    }

    const rendition = await this.prisma.audiobookRendition.findFirst({
      where: { audiobookId, format: body.format as never, status: 'READY' },
    });
    if (!rendition) {
      throw new ConflictError({
        code: 'FORMAT_NOT_AVAILABLE',
        message: `Delivery format ${body.format} is not available for this audiobook.`,
      });
    }
    const url = await this.storage.getSignedUrl(rendition.storageKey, 'GET', expiresIn);
    return {
      object: 'access_url' as const,
      url,
      method: 'GET' as const,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      disposition: body.disposition ?? 'INLINE',
      format: rendition.format,
      content_type: containerFormatContentType(rendition.format),
      duration_ms: rendition.durationMs,
      size_bytes: rendition.sizeBytes ? Number(rendition.sizeBytes) : null,
      content_hash: { algorithm: 'sha256' as const, value: rendition.contentHash },
    };
  }

  private async requireOwnedAudiobook(bookId: string, audiobookId: string) {
    const audiobook = await this.prisma.audiobook.findFirst({ where: { id: audiobookId, bookId } });
    if (!audiobook) throw new NotFoundError({ message: 'Audiobook not found.' });
    return audiobook;
  }

  private toAudiobookDto(row: {
    id: string;
    bookId: string;
    version: number;
    supersedesAudiobookId: string | null;
    isCurrent: boolean;
    isPreviewBuild: boolean;
    status: string;
    containerFormat: string;
    durationMs: number;
    sizeBytes: bigint | null;
    metadataTitle: string;
    metadataAuthor: string | null;
    metadataNarratorCredit: string | null;
    aiNarrationDisclosed: boolean;
    metadataSeries: string | null;
    metadataSeriesIndex: number | null;
    metadataPublisher: string | null;
    metadataLanguage: string;
    metadataPublicationYear: number | null;
    metadataDescription: string | null;
    bookWer: number | null;
    chunksFlagged: number;
    asrCoverage: number | null;
    pipelineVersion: string;
    directorVersion: string;
    ttsModelVersionIds: string[];
    audioToolModelVersionId: string;
    sourceContentHash: string;
    createdAt: Date;
    chapters: {
      chapterId: string;
      chapterAudioId: string;
      orderIndex: number;
      title: string | null;
      startMs: number;
      durationMs: number;
    }[];
    renditions: { format: string; status: string }[];
    cover: {
      width: number;
      height: number;
      contentHash: string;
    } | null;
  }) {
    return {
      id: row.id,
      object: 'audiobook' as const,
      book_id: row.bookId,
      version: row.version,
      supersedes_audiobook_id: row.supersedesAudiobookId,
      is_current: row.isCurrent,
      is_preview_build: row.isPreviewBuild,
      status: row.status,
      container_format: row.containerFormat,
      available_formats: [...new Set([row.containerFormat, ...row.renditions.map((r) => r.format)])],
      duration_ms: row.durationMs,
      size_bytes: row.sizeBytes ? Number(row.sizeBytes) : null,
      chapter_manifest: row.chapters.map((c) => ({
        chapter_id: c.chapterId,
        chapter_audio_id: c.chapterAudioId,
        order_index: c.orderIndex,
        title: c.title,
        start_ms: c.startMs,
        duration_ms: c.durationMs,
      })),
      metadata: {
        title: row.metadataTitle,
        author: row.metadataAuthor,
        narrator_credit: row.metadataNarratorCredit,
        ai_narration_disclosed: row.aiNarrationDisclosed,
        series: row.metadataSeries,
        series_index: row.metadataSeriesIndex,
        publisher: row.metadataPublisher,
        language: row.metadataLanguage,
        publication_year: row.metadataPublicationYear,
        description: row.metadataDescription,
      },
      cover: row.cover
        ? { present: true, width: row.cover.width, height: row.cover.height, content_hash: row.cover.contentHash }
        : { present: false },
      quality: {
        book_wer: row.bookWer,
        chunks_flagged: row.chunksFlagged,
        asr_coverage: row.asrCoverage,
      },
      lineage: {
        pipeline_version: row.pipelineVersion,
        director_version: row.directorVersion,
        tts_model_version_ids: row.ttsModelVersionIds,
        audio_tool_model_version_id: row.audioToolModelVersionId,
        source_content_hash: row.sourceContentHash,
      },
      created_at: row.createdAt.toISOString(),
      links: {
        self: `/api/v1/books/${row.bookId}/audiobooks/${row.id}`,
        access_urls: `/api/v1/books/${row.bookId}/audiobooks/${row.id}/access-urls`,
        cover: `/api/v1/books/${row.bookId}/audiobooks/${row.id}/cover`,
      },
    };
  }

  // ------------------------------------------------------------- cover art ----

  async putAudiobookCover(
    principal: AuthenticatedPrincipal,
    bookId: string,
    audiobookId: string,
    body: PutAudiobookCoverBody,
  ) {
    const audiobook = await this.requireOwnedAudiobook(bookId, audiobookId);
    if (audiobook.status !== 'DRAFT_METADATA') {
      throw new ConflictError({
        code: 'AUDIOBOOK_IMMUTABLE',
        message: `Audiobook is ${audiobook.status}; cover art can no longer be changed. Assemble a new version instead.`,
      });
    }

    if (isConfirmCoverBody(body)) {
      return this.confirmCoverUpload(principal, bookId, audiobookId, body);
    }
    return this.initiateCoverUpload(principal, bookId, audiobookId, body);
  }

  private async initiateCoverUpload(
    principal: AuthenticatedPrincipal,
    bookId: string,
    audiobookId: string,
    body: InitiateCoverUploadBody,
  ) {
    if (!COVER_MIME_TYPES.has(body.declared_mime_type)) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'declared_mime_type must be image/jpeg or image/png.',
        details: [{ field: 'declared_mime_type', issue: 'invalid_enum' }],
      });
    }
    if (!body.declared_size_bytes || body.declared_size_bytes > MAX_COVER_SIZE_BYTES) {
      throw new ValidationError({
        code: 'FILE_TOO_LARGE',
        message: `Cover image must be between 1 and ${MAX_COVER_SIZE_BYTES} bytes.`,
      });
    }
    if (body.declared_content_hash?.algorithm !== 'SHA256' || !body.declared_content_hash.value) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'declared_content_hash must be a SHA256 hash.',
        details: [{ field: 'declared_content_hash', issue: 'required' }],
      });
    }

    const sessionId = generateId();
    const extension = body.declared_mime_type === 'image/png' ? 'png' : 'jpg';
    const storageKey = buildStorageKey({
      tenantId: principal.tenantId,
      segments: ['books', bookId, 'audiobooks', audiobookId, 'covers', `${sessionId}.${extension}`],
    });
    const now = new Date();
    const record: CoverUploadSessionRecord = {
      id: sessionId,
      tenantId: principal.tenantId,
      bookId,
      audiobookId,
      declaredMimeType: body.declared_mime_type,
      declaredSizeBytes: body.declared_size_bytes,
      declaredContentHash: body.declared_content_hash,
      storageKey,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + COVER_UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    };
    await this.coverSessions.create(record);

    const uploadUrl = await this.storage.getSignedUrl(
      storageKey,
      'PUT',
      COVER_UPLOAD_URL_TTL_SECONDS,
    );

    return {
      status: 201 as const,
      body: {
        object: 'audiobook_cover_upload_session' as const,
        id: sessionId,
        audiobook_id: audiobookId,
        status: 'AWAITING_UPLOAD' as const,
        upload_target: { method: 'PUT' as const, url: uploadUrl, expires_at: record.expiresAt },
        max_size_bytes: MAX_COVER_SIZE_BYTES,
        expires_at: record.expiresAt,
        created_at: record.createdAt,
      },
    };
  }

  private async confirmCoverUpload(
    principal: AuthenticatedPrincipal,
    bookId: string,
    audiobookId: string,
    body: ConfirmCoverUploadBody,
  ) {
    const session = await this.coverSessions.get(principal.tenantId, body.upload_session_id);
    if (!session || session.audiobookId !== audiobookId || session.bookId !== bookId) {
      throw new NotFoundError({ message: 'Cover upload session not found.' });
    }

    const { body: buffer } = await this.downloadObject(session.storageKey, MAX_COVER_SIZE_BYTES);
    if (buffer.byteLength !== body.observed_size_bytes) {
      throw new ConflictError({
        code: 'UPLOAD_INCOMPLETE',
        message: 'Uploaded object size does not match the observed size reported by the client.',
      });
    }

    const checksum = checksumBuffer(buffer);
    if (checksum.hash !== session.declaredContentHash.value) {
      throw new ConflictError({
        code: 'CHECKSUM_MISMATCH',
        message: 'Uploaded content hash does not match the declared hash.',
      });
    }

    const detected = await detectFormat(buffer, session.declaredMimeType).catch(() => null);
    if (!detected || detected.sourceKind !== 'IMAGE_SET' || !COVER_MIME_TYPES.has(detected.sniffedMimeType)) {
      throw new ValidationError({
        code: 'UNSUPPORTED_FILE_FORMAT',
        message: 'Uploaded file is not a supported image format (JPEG or PNG only).',
      });
    }
    if (!detected.declaredVsSniffedMatch) {
      throw new ValidationError({
        code: 'UNSUPPORTED_FILE_FORMAT',
        message: 'Uploaded file does not match the declared MIME type.',
      });
    }

    const dimensions = readImageDimensions(buffer, detected.sniffedMimeType);
    if (!dimensions) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'Could not determine image dimensions.',
      });
    }
    if (
      dimensions.width < MIN_COVER_DIMENSION_PX ||
      dimensions.height < MIN_COVER_DIMENSION_PX ||
      dimensions.width > MAX_COVER_DIMENSION_PX ||
      dimensions.height > MAX_COVER_DIMENSION_PX
    ) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: `Cover dimensions must be between ${MIN_COVER_DIMENSION_PX} and ${MAX_COVER_DIMENSION_PX} pixels per side.`,
        details: [{ field: 'dimensions', issue: 'out_of_range' }],
      });
    }

    // Real (not simulated) metadata stripping: for JPEG this removes APP1
    // (EXIF) marker segments from the container without re-encoding pixel
    // data; for PNG it drops the ancillary eXIf/tEXt/zTXt/iTXt/tIME chunks.
    // ICC color profiles and any other rendering-relevant chunks/segments
    // are left untouched. See strip-exif.ts for exactly what is and isn't
    // removed.
    const stripped = stripExif(buffer, detected.sniffedMimeType);
    const strippedChecksum = checksumBuffer(stripped);
    const putMeta = await this.storage.put({
      key: session.storageKey,
      body: stripped,
      contentType: detected.sniffedMimeType,
    });

    const coverId = generateId();
    const now = new Date();
    await withTransaction(this.prisma, async (tx) => {
      await tx.audiobookCover.create({
        data: {
          id: coverId,
          tenantId: principal.tenantId,
          bookId,
          audiobookId,
          width: dimensions.width,
          height: dimensions.height,
          mimeType: detected.sniffedMimeType,
          exifStrippedAt: now,
          uploadedByUserId: principal.sub,
          storageKey: session.storageKey,
          storageBucket: putMeta.bucket,
          contentHash: strippedChecksum.hash,
          contentHashAlgorithm: 'SHA256',
          sizeBytes: BigInt(stripped.byteLength),
        },
      });
      await tx.audiobook.update({
        where: { id: audiobookId },
        data: { audiobookCoverId: coverId },
      });
    });
    await this.coverSessions.delete(principal.tenantId, session.id);

    return {
      status: 200 as const,
      body: {
        object: 'audiobook_cover' as const,
        id: coverId,
        audiobook_id: audiobookId,
        width: dimensions.width,
        height: dimensions.height,
        mime_type: detected.sniffedMimeType,
        exif_stripped: true,
        content_hash: { algorithm: 'sha256' as const, value: strippedChecksum.hash },
        created_at: now.toISOString(),
      },
    };
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
        throw new ValidationError({ code: 'FILE_TOO_LARGE', message: 'Object exceeds the configured size limit.' });
      }
      chunks.push(buf);
    }
    return { body: Buffer.concat(chunks) };
  }

  // ---------------------------------------------------------------- helpers ----

  private async requireOwnedBook(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.prisma.book.findFirst({
      where: { id: bookId, tenantId: principal.tenantId },
    });
    assertTenantOwnership(book, principal, 'Book not found.');
    return book;
  }
}

function chunkManifestHash(chunks: { id: string; contentHash: string }[]): string {
  return createHash('sha256')
    .update(chunks.map((c) => `${c.id}:${c.contentHash}`).join('\n'))
    .digest('hex');
}

function chapterManifestHash(chapterAudios: { id: string; contentHash: string }[]): string {
  return createHash('sha256')
    .update(chapterAudios.map((c) => `${c.id}:${c.contentHash}`).join('\n'))
    .digest('hex');
}

function audioFormatContentType(format: string): string {
  switch (format) {
    case 'WAV':
      return 'audio/wav';
    case 'FLAC':
      return 'audio/flac';
    case 'AAC':
      return 'audio/aac';
    case 'MP3':
      return 'audio/mpeg';
    default:
      return 'application/octet-stream';
  }
}

function containerFormatContentType(format: string): string {
  switch (format) {
    case 'M4B':
    case 'M4A':
      return 'audio/mp4';
    case 'MP3_PER_CHAPTER':
      return 'audio/mpeg';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Shared by `getAssemblyState` and `getAudiobookProject` — both surfaces use
 * the same `NOT_STARTED | BLOCKED | ASSEMBLING | COMPLETED | FAILED`
 * vocabulary (`STALE` is computed separately by the caller, since it needs
 * book-lineage data this function doesn't have).
 */
function deriveGenerationStatus(
  audiobook: { status: string } | null,
  chaptersTotal: number,
  chaptersAssembled: number,
): 'NOT_STARTED' | 'BLOCKED' | 'ASSEMBLING' | 'COMPLETED' | 'FAILED' {
  if (audiobook) {
    if (audiobook.status === 'READY') return 'COMPLETED';
    if (audiobook.status === 'FAILED') return 'FAILED';
    if (audiobook.status === 'ASSEMBLING') return 'ASSEMBLING';
    if (audiobook.status === 'DRAFT_METADATA') return 'BLOCKED';
  }
  if (chaptersTotal === 0) return 'NOT_STARTED';
  if (chaptersAssembled === 0) return 'NOT_STARTED';
  if (chaptersAssembled < chaptersTotal) return 'ASSEMBLING';
  return 'ASSEMBLING'; // all chapters assembled but no Audiobook yet — book-level assembly still pending
}
