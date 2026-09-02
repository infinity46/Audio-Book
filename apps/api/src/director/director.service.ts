import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import { ConflictError, NotFoundError, ValidationError } from '@audio-book/errors';
import { generateId } from '@audio-book/events';
import type { Logger } from '@audio-book/logging';
import { enqueueProcessingJob, QueueManager } from '@audio-book/queue';
import { LOGGER, PRISMA, QUEUE_MANAGER } from '../common/tokens.js';
import { assertTenantOwnership } from '../common/tenant.js';
import { decodeCursor, paginate, parseLimit } from '../common/pagination.js';
import type { AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';

const ACTIVE_JOB_STATUSES = ['CREATED', 'QUEUED', 'RUNNING', 'RETRYING', 'BLOCKED'] as const;
const DIRECTOR_JOB_TYPES = ['generate_director_ir', 'revise_director_ir'] as const;
const INGESTION_COMPLETE_STATUSES = ['READY', 'PARTIAL_OCR'] as const;

/**
 * `director_version`'s default -- must match
 * `python/worker-ai/src/worker_ai/director/config.py`'s `DirectorConfig.director_version`
 * default exactly, since the worker (not this service) is the one that
 * actually resolves `director_model_version_id` against whichever provider
 * that label names (see `startDirector`'s doc comment for why the API never
 * resolves that id itself).
 */
const DEFAULT_DIRECTOR_VERSION = 'director.v1';

export interface StartDirectorBody {
  scope: 'BOOK' | 'CHAPTERS';
  chapter_ids?: string[];
  director_version?: string;
  force?: boolean;
  priority?: 'INTERACTIVE' | 'NORMAL' | 'BULK';
  acknowledge_version_mixing?: boolean;
}

export interface ReviseDirectorBody {
  chunk_ids: string[];
  revision_reason: 'CHARACTER_MERGED' | 'VOICE_REASSIGNED' | 'LEXICON_CHANGED' | 'USER_EDIT';
  director_version?: string;
}

export interface UpdateAudioScriptChunkBody {
  performance?: {
    speaker_type?: 'NARRATOR' | 'CHARACTER' | 'UNKNOWN' | 'SYSTEM';
    character_id?: string | null;
    is_dialogue?: boolean;
    delivery_mode?: string;
    emotion?: string;
    emotion_intensity?: number;
    pacing?: number;
    pitch?: number;
    volume?: number;
    pauses?: unknown[];
    emphasis?: unknown[];
    non_verbal?: unknown[];
  };
  voice_binding?: {
    voice_profile_id?: string;
    voice_profile_version_id?: string;
  };
  generation_control?: {
    tts_provider_id?: string;
    seed?: number | null;
    target_sample_rate?: number | null;
    target_channels?: number | null;
  };
  quality?: {
    review_flags?: string[];
  };
  reason?: string;
}

@Injectable()
export class DirectorService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUE_MANAGER) private readonly queueManager: QueueManager,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private async requireOwnedBook(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.prisma.book.findFirst({
      where: { id: bookId, tenantId: principal.tenantId },
    });
    assertTenantOwnership(book, principal, 'Book not found.');
    return book;
  }

  private async requireAudioScriptChunk(bookId: string, chunkId: string) {
    const chunk = await this.prisma.audioScriptChunk.findFirst({
      where: { id: chunkId, bookId, isCurrent: true },
    });
    if (!chunk) throw new NotFoundError({ message: 'Audio Script chunk not found.' });
    return chunk;
  }

  // ---- Director lifecycle ----

  /**
   * Starts a `generate_director_ir` run. Mirrors `AnalysisService.startAnalysis`
   * exactly (same precondition-gate / transaction / enqueue shape).
   *
   * Deliberately does NOT resolve or stamp `director_model_version_id` here
   * -- that identity is owned by whichever `DirectorModelProvider` the
   * worker is configured with (`python/worker-ai/src/worker_ai/director/config.py`),
   * and the `AudioScript` row itself is created lazily by the FIRST chapter
   * the worker processes (mirroring how `analyze_scene` creates
   * `story_bible_version_id` on its own first chapter) -- not by this API,
   * which would otherwise have to duplicate provider-identity knowledge
   * that belongs entirely to the worker.
   */
  async startDirector(principal: AuthenticatedPrincipal, bookId: string, body: StartDirectorBody) {
    const book = await this.requireOwnedBook(principal, bookId);
    if (!book.currentBookVersionId) {
      throw new ConflictError({
        code: 'INGESTION_NOT_COMPLETE',
        message: 'This book has no ingested version yet.',
      });
    }
    const bookVersion = await this.prisma.bookVersion.findUnique({
      where: { id: book.currentBookVersionId },
    });
    if (!bookVersion || !INGESTION_COMPLETE_STATUSES.includes(bookVersion.status as never)) {
      throw new ConflictError({
        code: 'INGESTION_NOT_COMPLETE',
        message: 'Ingestion must complete before Director processing can start.',
      });
    }

    const storyBible = await this.prisma.storyBible.findUnique({ where: { bookId } });
    if (!storyBible || storyBible.status !== 'READY' || !storyBible.currentVersionId) {
      throw new ConflictError({
        code: 'ANALYSIS_NOT_COMPLETE',
        message: 'Analysis (Story Bible) must complete before Director processing can start.',
      });
    }

    const running = await this.prisma.processingJob.findFirst({
      where: {
        bookId,
        type: { in: [...DIRECTOR_JOB_TYPES] },
        status: { in: [...ACTIVE_JOB_STATUSES] },
      },
    });
    if (running) {
      throw new ConflictError({
        code: 'DIRECTOR_ALREADY_RUNNING',
        message: 'Director processing is already running for this book.',
      });
    }

    const chapterWhere: Prisma.ChapterWhereInput =
      body.scope === 'CHAPTERS'
        ? { bookVersionId: bookVersion.id, id: { in: body.chapter_ids ?? [] } }
        : { bookVersionId: bookVersion.id, matterType: 'BODY' };
    const chapters = await this.prisma.chapter.findMany({
      where: chapterWhere,
      orderBy: { orderIndex: 'asc' },
    });

    if (body.scope === 'CHAPTERS') {
      const found = new Set(chapters.map((c) => c.id));
      const missing = (body.chapter_ids ?? []).filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new ValidationError({
          code: 'VALIDATION_FAILED',
          message: 'One or more chapter_ids do not belong to this book.',
          details: missing.map((id) => ({ field: 'chapter_ids', issue: `unknown: ${id}` })),
        });
      }
      // `audio_script.scope_chapter_id` (database-schema.md §13.1) is a single
      // chapter reference -- `AudioScriptScope` has exactly two members
      // (`BOOK`, `CHAPTER`), not an arbitrary chapter subset. A multi-chapter
      // `CHAPTERS` request would have no valid `AudioScript.scope` to record.
      if (chapters.length !== 1) {
        throw new ValidationError({
          code: 'VALIDATION_FAILED',
          message:
            'scope "CHAPTERS" requires exactly one chapter_id (AudioScript scope is BOOK or a single CHAPTER).',
          details: [{ field: 'chapter_ids', issue: 'must_have_exactly_one_entry' }],
        });
      }
    }
    if (chapters.length === 0) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'No chapters found to direct for the requested scope.',
      });
    }

    const directorVersion = body.director_version ?? DEFAULT_DIRECTOR_VERSION;
    const currentAudioScript = await this.prisma.audioScript.findFirst({
      where: { bookId, isCurrent: true },
    });
    if (
      currentAudioScript &&
      currentAudioScript.directorVersion !== directorVersion &&
      !body.acknowledge_version_mixing
    ) {
      throw new ConflictError({
        code: 'DIRECTOR_VERSION_MIXING_FORBIDDEN',
        message:
          `This book already has Audio Script content generated with ` +
          `director_version "${currentAudioScript.directorVersion}". Pass ` +
          `acknowledge_version_mixing: true to proceed with "${directorVersion}" anyway.`,
      });
    }

    const firstChapter = chapters[0]!;
    const jobId = generateId();
    const correlationId = generateId();
    const now = new Date();
    const priority = body.priority ?? 'NORMAL';
    // Built once: persisted on the row inside the transaction for sweeper
    // recovery, reused verbatim by the post-commit dispatch (F-4).
    const envelope = {
      job_id: jobId,
      entity_id: jobId,
      correlation_id: correlationId,
      tenant_id: principal.tenantId,
      payload: {
        book_id: bookId,
        book_version_id: bookVersion.id,
        story_bible_version_id: storyBible.currentVersionId,
        audio_script_id: null,
        scope: body.scope === 'CHAPTERS' ? 'CHAPTER' : 'BOOK',
        scope_chapter_id: body.scope === 'CHAPTERS' ? firstChapter.id : null,
        structure_version_label: bookVersion.structureVersionLabel ?? 'structure.v1',
        director_version: directorVersion,
        chapter_id: firstChapter.id,
        remaining_chapter_ids: chapters.slice(1).map((c) => c.id),
        all_chapter_ids: chapters.map((c) => c.id),
        root_job_id: jobId,
        sequence_index_start: 0,
      },
    };

    await withTransaction(this.prisma, async (tx) => {
      await tx.processingJob.create({
        data: {
          id: jobId,
          tenantId: principal.tenantId,
          bookId,
          type: 'generate_director_ir',
          queue: 'ai',
          priority,
          relatedResourceType: 'book_version',
          relatedResourceId: bookVersion.id,
          scope: {
            requested_chapter_ids: chapters.map((c) => c.id),
            director_scope: body.scope,
            force: Boolean(body.force),
          },
          status: 'CREATED',
          statusChangedAt: now,
          maxAttempts: 3,
          idempotencyKey: `director:${bookVersion.id}:${firstChapter.id}:${directorVersion}:${jobId}`,
          idempotencyFingerprint: bookVersion.contentHash,
          correlationId,
          forced: Boolean(body.force),
          createdByUserId: principal.sub,
          dispatchEnvelope: envelope,
        },
      });

      await tx.book.update({
        where: { id: bookId },
        data: { status: 'SCRIPTING', statusChangedAt: now },
      });
    });

    await enqueueProcessingJob(this.prisma, this.queueManager, {
      processingJobId: jobId,
      queue: 'ai',
      envelope,
      jobName: 'generate_director_ir',
      maxAttempts: 3,
    });

    this.logger.info(
      {
        job_id: jobId,
        book_id: bookId,
        chapter_count: chapters.length,
        director_version: directorVersion,
      },
      'Enqueued generate_director_ir command (Director start)',
    );

    return {
      job: {
        id: jobId,
        object: 'job' as const,
        type: 'generate_director_ir' as const,
        status: 'CREATED' as const,
        book_id: bookId,
      },
      accepted: {
        scope: body.scope,
        chapter_ids: chapters.map((c) => c.id),
        director_version: directorVersion,
        input_story_bible_snapshot_version: storyBible.currentVersionNumber,
        input_content_hash: bookVersion.contentHash,
        planned_unit_count: chapters.length,
        skipped_unit_count: 0,
      },
    };
  }

  async reviseDirector(
    principal: AuthenticatedPrincipal,
    bookId: string,
    body: ReviseDirectorBody,
  ) {
    await this.requireOwnedBook(principal, bookId);

    const chunks = await this.prisma.audioScriptChunk.findMany({
      where: { id: { in: body.chunk_ids }, bookId, isCurrent: true },
    });
    if (chunks.length === 0) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'None of the requested chunk_ids belong to this book.',
      });
    }
    const audioScriptId = chunks[0]!.audioScriptId;
    const directorVersion = body.director_version ?? chunks[0]!.directorVersion;

    const jobId = generateId();
    const correlationId = generateId();
    const now = new Date();
    const chunkIdSetHash = [...body.chunk_ids].sort().join(',');
    // Built once: persisted on the row for sweeper recovery, reused verbatim by
    // the post-commit dispatch (F-4).
    const envelope = {
      job_id: jobId,
      entity_id: jobId,
      correlation_id: correlationId,
      tenant_id: principal.tenantId,
      payload: {
        book_id: bookId,
        chunk_ids: body.chunk_ids,
        revision_reason: body.revision_reason,
        director_version: directorVersion,
      },
    };

    await withTransaction(this.prisma, async (tx) => {
      await tx.processingJob.create({
        data: {
          id: jobId,
          tenantId: principal.tenantId,
          bookId,
          type: 'revise_director_ir',
          queue: 'ai',
          priority: 'INTERACTIVE',
          relatedResourceType: 'audio_script',
          relatedResourceId: audioScriptId,
          scope: { chunk_ids: body.chunk_ids, revision_reason: body.revision_reason },
          status: 'CREATED',
          statusChangedAt: now,
          maxAttempts: 3,
          idempotencyKey: `revise_director:${audioScriptId}:${body.revision_reason}:${chunkIdSetHash}:${directorVersion}`,
          idempotencyFingerprint: chunkIdSetHash,
          correlationId,
          createdByUserId: principal.sub,
          dispatchEnvelope: envelope,
        },
      });
    });

    await enqueueProcessingJob(this.prisma, this.queueManager, {
      processingJobId: jobId,
      queue: 'ai',
      envelope,
      jobName: 'revise_director_ir',
      maxAttempts: 3,
    });

    return {
      job: {
        id: jobId,
        object: 'job' as const,
        type: 'revise_director_ir' as const,
        status: 'CREATED' as const,
        book_id: bookId,
      },
      accepted: {
        chunk_ids: body.chunk_ids,
        revision_reason: body.revision_reason,
        director_version: directorVersion,
      },
    };
  }

  async getDirectorState(principal: AuthenticatedPrincipal, bookId: string) {
    await this.requireOwnedBook(principal, bookId);

    const rootJob = await this.prisma.processingJob.findFirst({
      where: { bookId, type: { in: [...DIRECTOR_JOB_TYPES] }, parentJobId: null },
      orderBy: { createdAt: 'desc' },
    });
    const audioScript = await this.prisma.audioScript.findFirst({
      where: { bookId, isCurrent: true },
    });

    let status: string = 'NOT_STARTED';
    if (rootJob) {
      if (rootJob.status === 'FAILED') status = 'FAILED';
      else if (rootJob.status === 'CANCELLED') status = 'CANCELLED';
      else if (rootJob.status === 'SUCCEEDED') {
        if (!audioScript || audioScript.state !== 'VALIDATED') status = 'VALIDATING';
        else {
          // `has_review_flags` is a raw generated Postgres column, not part
          // of the Prisma Client schema (see AudioScriptChunk's model
          // comment) -- `reviewFlags: { isEmpty: false }` is the equivalent
          // array-non-empty filter through Prisma's own generated types.
          const flagged = await this.prisma.audioScriptChunk.count({
            where: {
              audioScriptId: audioScript.id,
              isCurrent: true,
              reviewFlags: { isEmpty: false },
            },
          });
          status = flagged > 0 ? 'NEEDS_REVIEW' : 'COMPLETED';
        }
      } else if (rootJob.status === 'RUNNING' || rootJob.status === 'RETRYING') status = 'RUNNING';
      else status = 'QUEUED';
    }

    return {
      object: 'director_state' as const,
      book_id: bookId,
      status,
      director_version: audioScript?.directorVersion ?? null,
      director_model_version_id: audioScript?.directorModelVersionId ?? null,
      output: audioScript
        ? {
            audio_script_id: audioScript.id,
            audio_script_version: audioScript.version,
            schema_version: audioScript.schemaVersion,
            chunk_count: audioScript.chunkCount,
            coverage_verified: audioScript.coverageVerified,
          }
        : null,
      validation: audioScript
        ? {
            status: audioScript.state,
            unknown_speaker_rate: audioScript.unknownSpeakerRate,
            fallback_applied_count: audioScript.fallbackAppliedCount,
            low_confidence_chunk_count: audioScript.lowConfidenceChunkCount,
            coverage_gaps: audioScript.coverageGapCount,
            coverage_overlaps: audioScript.coverageOverlapCount,
          }
        : null,
      degraded: audioScript?.degraded ?? false,
      current_job_id:
        rootJob && ACTIVE_JOB_STATUSES.includes(rootJob.status as never) ? rootJob.id : null,
    };
  }

  // ---- Audio Script (read-only, immutable) ----

  async getCurrentAudioScript(principal: AuthenticatedPrincipal, bookId: string) {
    await this.requireOwnedBook(principal, bookId);
    const audioScript = await this.prisma.audioScript.findFirst({
      where: { bookId, isCurrent: true },
    });
    if (!audioScript)
      throw new NotFoundError({ message: 'No Audio Script exists for this book yet.' });
    return toAudioScriptDto(audioScript);
  }

  async listAudioScripts(
    principal: AuthenticatedPrincipal,
    bookId: string,
    query: { include_superseded?: string; cursor?: string; limit?: string },
  ) {
    await this.requireOwnedBook(principal, bookId);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const includeSuperseded = query.include_superseded === 'true';

    const where: Prisma.AudioScriptWhereInput = { bookId };
    if (!includeSuperseded) where.state = { not: 'SUPERSEDED' };
    if (cursor) where.version = { lt: Number(cursor.v) };

    const scripts = await this.prisma.audioScript.findMany({
      where,
      orderBy: { version: 'desc' },
      take: limit + 1,
    });
    const page = paginate(
      scripts,
      limit,
      (s) => s.version,
      (s) => s.id,
    );
    return { ...page, data: page.data.map(toAudioScriptDto) };
  }

  async getAudioScript(principal: AuthenticatedPrincipal, bookId: string, audioScriptId: string) {
    await this.requireOwnedBook(principal, bookId);
    const audioScript = await this.prisma.audioScript.findFirst({
      where: { id: audioScriptId, bookId },
    });
    if (!audioScript) throw new NotFoundError({ message: 'Audio Script not found.' });
    return toAudioScriptDto(audioScript);
  }

  // ---- Audio Script chunks ----

  async listAudioScriptChunks(
    principal: AuthenticatedPrincipal,
    bookId: string,
    query: {
      audio_script_id?: string;
      chapter_id?: string;
      scene_id?: string;
      character_id?: string;
      speaker_type?: string;
      state?: string;
      has_review_flags?: string;
      fallback_applied?: string;
      min_confidence?: string;
      max_confidence?: string;
      cursor?: string;
      limit?: string;
    },
  ) {
    await this.requireOwnedBook(principal, bookId);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    let audioScriptId = query.audio_script_id;
    if (!audioScriptId) {
      const current = await this.prisma.audioScript.findFirst({
        where: { bookId, isCurrent: true },
      });
      if (!current) return { data: [], page: { limit, has_more: false, next_cursor: null } };
      audioScriptId = current.id;
    }

    const where: Prisma.AudioScriptChunkWhereInput = { bookId, audioScriptId, isCurrent: true };
    if (query.chapter_id) where.chapterId = query.chapter_id;
    if (query.scene_id) where.sceneId = query.scene_id;
    if (query.character_id) where.characterId = query.character_id;
    if (query.speaker_type) where.speakerType = query.speaker_type as never;
    if (query.state) where.state = query.state as never;
    if (query.has_review_flags !== undefined) {
      where.reviewFlags = { isEmpty: query.has_review_flags !== 'true' };
    }
    if (query.fallback_applied !== undefined)
      where.fallbackApplied = query.fallback_applied === 'true';
    if (query.min_confidence || query.max_confidence) {
      where.confidence = {
        ...(query.min_confidence ? { gte: Number(query.min_confidence) } : {}),
        ...(query.max_confidence ? { lte: Number(query.max_confidence) } : {}),
      };
    }
    if (cursor) where.sequenceIndex = { gt: Number(cursor.v) };

    const chunks = await this.prisma.audioScriptChunk.findMany({
      where,
      orderBy: { sequenceIndex: 'asc' },
      take: limit + 1,
    });
    const page = paginate(
      chunks,
      limit,
      (c) => c.sequenceIndex,
      (c) => c.id,
    );
    return { ...page, data: page.data.map(toAudioScriptChunkDto) };
  }

  async getAudioScriptChunk(principal: AuthenticatedPrincipal, bookId: string, chunkId: string) {
    await this.requireOwnedBook(principal, bookId);
    const chunk = await this.requireAudioScriptChunk(bookId, chunkId);
    return toAudioScriptChunkDto(chunk);
  }

  async updateAudioScriptChunk(
    principal: AuthenticatedPrincipal,
    bookId: string,
    chunkId: string,
    body: UpdateAudioScriptChunkBody,
  ) {
    await this.requireOwnedBook(principal, bookId);
    const chunk = await this.requireAudioScriptChunk(bookId, chunkId);

    if (chunk.state === 'LOCKED') {
      throw new ConflictError({
        code: 'AUDIO_SCRIPT_CHUNK_FROZEN',
        message:
          'This chunk is LOCKED (already used for generation) and cannot be edited in place. ' +
          'Request a new chunk version via revise-director instead.',
      });
    }
    if (body.voice_binding?.voice_profile_version_id) {
      const voiceVersion = await this.prisma.voiceProfileVersion.findUnique({
        where: { id: body.voice_binding.voice_profile_version_id },
      });
      if (!voiceVersion || !['APPROVED', 'LOCKED'].includes(voiceVersion.approvalState)) {
        throw new ConflictError({
          code: 'VOICE_PROFILE_NOT_APPROVED',
          message: 'The requested voice_profile_version_id is not an APPROVED or LOCKED voice.',
        });
      }
    }

    // Write-once `director_original`: only the FIRST edit to a given field
    // records the Director's original value (task §123/§38.4's "first
    // original wins" -- a second edit must not overwrite it).
    const existingOriginal = (chunk.directorOriginal as Record<string, unknown> | null) ?? {};
    const changedOriginal: Record<string, unknown> = { ...existingOriginal };
    const performanceFieldMap: Record<string, unknown> = {
      speakerType: chunk.speakerType,
      characterId: chunk.characterId,
      isDialogue: chunk.isDialogue,
      deliveryMode: chunk.deliveryMode,
      emotion: chunk.emotion,
      emotionIntensity: chunk.emotionIntensity,
      pacing: chunk.pacing,
      pitch: chunk.pitch,
      volume: chunk.volume,
    };
    const requestedPerformanceKeys = Object.keys(body.performance ?? {}).filter(
      (k) => !['pauses', 'emphasis', 'non_verbal'].includes(k),
    );
    for (const snakeKey of requestedPerformanceKeys) {
      const camelKey = snakeKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      if (!(camelKey in changedOriginal) && camelKey in performanceFieldMap) {
        changedOriginal[camelKey] = performanceFieldMap[camelKey];
      }
    }
    if (body.voice_binding && !('voiceProfileVersionId' in changedOriginal)) {
      changedOriginal.voiceProfileVersionId = chunk.voiceProfileVersionId;
    }

    const data: Prisma.AudioScriptChunkUpdateInput = {
      rowVersion: { increment: 1 },
      origin: 'HUMAN_MODIFIED',
      directorOriginal: changedOriginal as Prisma.InputJsonValue,
      override: {
        modified_by_user_id: principal.sub,
        modified_at: new Date().toISOString(),
        reason: body.reason ?? null,
      },
      state: 'DRAFT',
    };
    if (body.performance) {
      const p = body.performance;
      if (p.speaker_type !== undefined) data.speakerType = p.speaker_type;
      if (p.character_id !== undefined)
        data.character = p.character_id
          ? { connect: { id: p.character_id } }
          : { disconnect: true };
      if (p.is_dialogue !== undefined) data.isDialogue = p.is_dialogue;
      if (p.delivery_mode !== undefined) data.deliveryMode = p.delivery_mode as never;
      if (p.emotion !== undefined) data.emotion = p.emotion as never;
      if (p.emotion_intensity !== undefined) data.emotionIntensity = p.emotion_intensity;
      if (p.pacing !== undefined) data.pacing = p.pacing;
      if (p.pitch !== undefined) data.pitch = p.pitch;
      if (p.volume !== undefined) data.volume = p.volume;
      if (p.pauses !== undefined) data.pauses = p.pauses as Prisma.InputJsonValue;
      if (p.emphasis !== undefined) data.emphasis = p.emphasis as Prisma.InputJsonValue;
      if (p.non_verbal !== undefined) data.nonVerbal = p.non_verbal as Prisma.InputJsonValue;
    }
    if (body.voice_binding) {
      if (body.voice_binding.voice_profile_id) {
        data.voiceProfile = { connect: { id: body.voice_binding.voice_profile_id } };
      }
      if (body.voice_binding.voice_profile_version_id) {
        data.voiceProfileVersion = { connect: { id: body.voice_binding.voice_profile_version_id } };
      }
    }
    if (body.generation_control) {
      const g = body.generation_control;
      if (g.tts_provider_id !== undefined) data.ttsProviderId = g.tts_provider_id;
      if (g.seed !== undefined) data.seed = g.seed === null ? null : BigInt(g.seed);
      if (g.target_sample_rate !== undefined) data.targetSampleRate = g.target_sample_rate;
      if (g.target_channels !== undefined) data.targetChannels = g.target_channels;
    }
    if (body.quality?.review_flags !== undefined) {
      data.reviewFlags = { set: body.quality.review_flags as never[] };
    }

    const updated = await this.prisma.audioScriptChunk.update({ where: { id: chunkId }, data });
    return toAudioScriptChunkDto(updated);
  }
}

function toAudioScriptDto(script: {
  id: string;
  bookId: string;
  scope: string;
  version: number;
  supersedesAudioScriptId: string | null;
  schemaVersion: string;
  directorVersion: string;
  directorModelVersionId: string;
  storyBibleVersionId: string;
  sourceContentHash: string;
  chunkCount: number;
  totalCharacters: number;
  estimatedAudioMs: bigint;
  state: string;
  coverageVerified: boolean;
  coverageGapCount: number;
  coverageOverlapCount: number;
  unknownSpeakerRate: number | null;
  fallbackAppliedCount: number;
  lowConfidenceChunkCount: number;
  degraded: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: script.id,
    object: 'audio_script' as const,
    book_id: script.bookId,
    scope: script.scope,
    version: script.version,
    supersedes_audio_script_id: script.supersedesAudioScriptId,
    schema_version: script.schemaVersion,
    director_version: script.directorVersion,
    director_model_version_id: script.directorModelVersionId,
    story_bible_version_id: script.storyBibleVersionId,
    source_content_hash: script.sourceContentHash,
    chunk_count: script.chunkCount,
    totals: {
      characters: script.totalCharacters,
      estimated_audio_ms: Number(script.estimatedAudioMs),
    },
    state: script.state,
    coverage_verified: script.coverageVerified,
    coverage_gap_count: script.coverageGapCount,
    coverage_overlap_count: script.coverageOverlapCount,
    unknown_speaker_rate: script.unknownSpeakerRate,
    fallback_applied_count: script.fallbackAppliedCount,
    low_confidence_chunk_count: script.lowConfidenceChunkCount,
    degraded: script.degraded,
    created_at: script.createdAt.toISOString(),
    updated_at: script.updatedAt.toISOString(),
  };
}

function toAudioScriptChunkDto(chunk: {
  id: string;
  audioScriptId: string;
  bookId: string;
  chapterId: string;
  sectionId: string | null;
  sceneId: string | null;
  sequenceIndex: number;
  chapterSequenceIndex: number;
  state: string;
  supersedesChunkId: string | null;
  sourceContentHash: string;
  schemaVersion: string;
  directorVersion: string;
  directorModelVersionId: string;
  contextBundleHash: string;
  text: string;
  spokenText: string | null;
  language: string;
  script: string | null;
  speakerType: string;
  characterId: string | null;
  isDialogue: boolean;
  deliveryMode: string;
  emotion: string;
  emotionIntensity: number;
  pacing: number;
  pitch: number;
  volume: number;
  pauses: unknown;
  emphasis: unknown;
  pronunciationHints: unknown;
  nonVerbal: unknown;
  voiceProfileId: string | null;
  voiceProfileVersionId: string | null;
  ttsProviderId: string | null;
  generationParamsHash: string | null;
  seed: bigint | null;
  targetSampleRate: number | null;
  targetChannels: number | null;
  confidence: number;
  decisionConfidence: unknown;
  reviewFlags: string[];
  fallbackApplied: boolean;
  fallbackReason: string | null;
  capabilityGaps: unknown;
  continuity: unknown;
  origin: string;
  directorOriginal: unknown;
  override: unknown;
  currentAudioChunkId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: chunk.id,
    object: 'audio_script_chunk' as const,
    audio_script_id: chunk.audioScriptId,
    book_id: chunk.bookId,
    chapter_id: chunk.chapterId,
    section_id: chunk.sectionId,
    scene_id: chunk.sceneId,
    sequence_index: chunk.sequenceIndex,
    chapter_sequence_index: chunk.chapterSequenceIndex,
    state: chunk.state,
    supersedes_chunk_id: chunk.supersedesChunkId,
    source_content_hash: chunk.sourceContentHash,
    schema_version: chunk.schemaVersion,
    director_version: chunk.directorVersion,
    director_model_version_id: chunk.directorModelVersionId,
    context_bundle_hash: chunk.contextBundleHash,
    content: {
      text: chunk.text,
      spoken_text: chunk.spokenText,
      language: chunk.language,
      script: chunk.script,
    },
    performance: {
      speaker_type: chunk.speakerType,
      character_id: chunk.characterId,
      is_dialogue: chunk.isDialogue,
      delivery_mode: chunk.deliveryMode,
      emotion: chunk.emotion,
      emotion_intensity: chunk.emotionIntensity,
      pacing: chunk.pacing,
      pitch: chunk.pitch,
      volume: chunk.volume,
      pauses: chunk.pauses,
      emphasis: chunk.emphasis,
      pronunciation_hints: chunk.pronunciationHints,
      non_verbal: chunk.nonVerbal,
    },
    voice_binding: {
      voice_profile_id: chunk.voiceProfileId,
      voice_profile_version_id: chunk.voiceProfileVersionId,
    },
    generation_control: {
      tts_provider_id: chunk.ttsProviderId,
      generation_params_hash: chunk.generationParamsHash,
      seed: chunk.seed !== null ? Number(chunk.seed) : null,
      target_sample_rate: chunk.targetSampleRate,
      target_channels: chunk.targetChannels,
    },
    quality: {
      confidence: chunk.confidence,
      decision_confidence: chunk.decisionConfidence,
      review_flags: chunk.reviewFlags,
      fallback_applied: chunk.fallbackApplied,
      fallback_reason: chunk.fallbackReason,
      capability_gaps: chunk.capabilityGaps,
      continuity: chunk.continuity,
    },
    provenance: {
      origin: chunk.origin,
      director_original: chunk.directorOriginal,
      override: chunk.override,
    },
    audio: {
      current_audio_chunk_id: chunk.currentAudioChunkId,
    },
    created_at: chunk.createdAt.toISOString(),
    updated_at: chunk.updatedAt.toISOString(),
  };
}
