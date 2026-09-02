import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import { ConflictError, NotFoundError, ValidationError } from '@audio-book/errors';
import { generateId } from '@audio-book/events';
import type { Logger } from '@audio-book/logging';
import { enqueueProcessingJob, QueueManager } from '@audio-book/queue';
import type { StorageProvider } from '@audio-book/storage';
import { LOGGER, PRISMA, QUEUE_MANAGER, STORAGE_PROVIDER } from '../common/tokens.js';
import { assertTenantOwnership } from '../common/tenant.js';
import { decodeCursor, paginate, parseLimit } from '../common/pagination.js';
import type { AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';

const PRODUCTION_APPROVAL_STATES = ['APPROVED', 'LOCKED'] as const;
const IN_PROGRESS_AUDIO_CHUNK_STATUSES = ['GENERATED', 'VALIDATED', 'ASSEMBLED'] as const;

export interface StartTtsBody {
  scope: 'BOOK' | 'CHAPTERS' | 'CHUNKS' | 'FILTER';
  chapter_ids?: string[];
  chunk_ids?: string[];
  filter?: { audio_chunk_status?: string[]; chapter_ids?: string[] };
  force?: boolean;
  acknowledge_partial_revoice?: boolean;
  priority?: 'INTERACTIVE' | 'NORMAL' | 'BULK';
}

export interface CreateAccessUrlBody {
  disposition?: 'INLINE' | 'ATTACHMENT';
  format?: string;
  expires_in_seconds?: number;
}

/**
 * TTS generation orchestration (`api-specification.md` §16.15) and read access to the
 * `AudioChunk` artifacts it produces.
 *
 * **Known scope limitation**: no worker-registration/capability table is implemented
 * in this codebase yet (`worker.capabilities`, `api-specification.md` §16.15
 * precondition 5 — "every bound VoiceProfileVersion targets a provider/model some
 * worker advertises"), so this service does not pre-check model availability before
 * admission; an unavailable model surfaces as a worker-side `MODEL_NOT_FOUND` job
 * failure instead of a `202`-time `409`. This mirrors the gap already present in
 * `DirectorService.startDirector`, which resolves its model identity the same
 * worker-side way.
 */
@Injectable()
export class TtsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUE_MANAGER) private readonly queueManager: QueueManager,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async startTts(principal: AuthenticatedPrincipal, bookId: string, body: StartTtsBody) {
    const book = await this.requireOwnedBook(principal, bookId);
    if (!book.currentAudioScriptId) {
      throw new ConflictError({
        code: 'AUDIO_SCRIPT_NOT_VALIDATED',
        message: 'This book has no current Audio Script.',
      });
    }
    const script = await this.prisma.audioScript.findUniqueOrThrow({
      where: { id: book.currentAudioScriptId },
    });
    if (script.state !== 'VALIDATED') {
      throw new ConflictError({
        code: 'AUDIO_SCRIPT_NOT_VALIDATED',
        message: `Audio Script is ${script.state}, not VALIDATED.`,
      });
    }

    const where = this.resolveChunkWhere(script.id, bookId, body);
    const chunks = await this.prisma.audioScriptChunk.findMany({
      where,
      include: { voiceProfileVersion: true },
      orderBy: { sequenceIndex: 'asc' },
    });
    if (chunks.length === 0) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'No chunks matched the requested scope.',
      });
    }

    const missingVoice = chunks.filter((c) => !c.voiceProfileVersionId);
    if (missingVoice.length > 0) {
      throw new ConflictError({
        code: 'CASTING_INCOMPLETE',
        message: `${missingVoice.length} chunk(s) have no resolvable voice. Complete casting first.`,
        details: missingVoice
          .slice(0, 20)
          .map((c) => ({ field: 'chunk_ids', issue: `no_voice: ${c.id}` })),
      });
    }
    const unapproved = chunks.filter(
      (c) =>
        c.voiceProfileVersion &&
        !PRODUCTION_APPROVAL_STATES.includes(c.voiceProfileVersion.approvalState as never),
    );
    if (unapproved.length > 0) {
      throw new ConflictError({
        code: 'VOICE_PROFILE_NOT_APPROVED',
        message: `${unapproved.length} chunk(s) target a voice version that is not APPROVED or LOCKED.`,
      });
    }

    const targetable = body.force ? chunks : await this.filterAlreadyGenerated(chunks);
    if (targetable.length === 0) {
      return {
        job: null,
        accepted: {
          scope: body.scope,
          planned_unit_count: 0,
          skipped_unit_count: chunks.length,
          skip_reason: 'ALREADY_GENERATED',
        },
      };
    }

    const priority = body.priority ?? 'NORMAL';
    if (priority === 'INTERACTIVE' && targetable.length > 50) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'INTERACTIVE priority is only accepted for a bounded number of chunks.',
        details: [{ field: 'priority', issue: 'out_of_range' }],
      });
    }

    const coordinatorJobId = generateId();
    const now = new Date();
    const created: {
      jobId: string;
      ttsJobId: string;
      envelope: {
        job_id: string;
        entity_id: string;
        correlation_id: string;
        tenant_id: string;
        payload: { tts_job_id: string };
      };
    }[] = [];

    await withTransaction(this.prisma, async (tx) => {
      await tx.processingJob.create({
        data: {
          id: coordinatorJobId,
          tenantId: principal.tenantId,
          bookId,
          type: 'generate_tts_chunk',
          queue: 'gpu',
          priority,
          relatedResourceType: 'audio_script',
          relatedResourceId: script.id,
          status: 'SUCCEEDED',
          statusChangedAt: now,
          completedAt: now,
          progress: 1,
          maxAttempts: 1,
          idempotencyKey: `tts_coordinator:${script.id}:${coordinatorJobId}`,
          idempotencyFingerprint: script.sourceContentHash,
          correlationId: coordinatorJobId,
          forced: Boolean(body.force),
          createdByUserId: principal.sub,
        },
      });

      for (const chunk of targetable) {
        const voiceVersion = chunk.voiceProfileVersion!;
        const jobId = generateId();
        const ttsJobId = generateId();
        // Built once: persisted on the ProcessingJob row below so the sweeper
        // can recover this dispatch, and reused verbatim by the enqueue after
        // the commit so the two cannot drift (F-4).
        const envelope = {
          job_id: jobId,
          entity_id: ttsJobId,
          correlation_id: coordinatorJobId,
          tenant_id: principal.tenantId,
          payload: { tts_job_id: ttsJobId },
        };
        const dedupeKey = ttsDedupeKey({
          chunkId: chunk.id,
          chunkVersion: chunk.version,
          voiceProfileVersionId: voiceVersion.id,
          ttsModelVersionId: voiceVersion.ttsModelVersionId,
          generationParamsHash: voiceVersion.baseGenerationParamsHash,
          seed: chunk.seed,
          forceToken: body.force ? coordinatorJobId : null,
        });

        await tx.processingJob.create({
          data: {
            id: jobId,
            tenantId: principal.tenantId,
            bookId,
            type: 'generate_tts_chunk',
            queue: 'gpu',
            priority,
            relatedResourceType: 'audio_script_chunk',
            relatedResourceId: chunk.id,
            parentJobId: coordinatorJobId,
            status: 'CREATED',
            statusChangedAt: now,
            maxAttempts: 3,
            idempotencyKey: `tts:${chunk.id}:${voiceVersion.version}:${voiceVersion.ttsModelVersionId}:${voiceVersion.baseGenerationParamsHash}`,
            idempotencyFingerprint: dedupeKey,
            correlationId: coordinatorJobId,
            forced: Boolean(body.force),
            createdByUserId: principal.sub,
            dispatchEnvelope: envelope,
          },
        });

        await tx.ttsJob.create({
          data: {
            id: ttsJobId,
            tenantId: principal.tenantId,
            bookId,
            audioScriptChunkId: chunk.id,
            audioScriptChunkVersion: chunk.version,
            processingJobId: jobId,
            ttsProviderId: voiceVersion.ttsProviderId,
            ttsModelVersionId: voiceVersion.ttsModelVersionId,
            voiceProfileId: voiceVersion.voiceProfileId,
            voiceProfileVersionId: voiceVersion.id,
            generationParams: voiceVersion.baseGenerationParams as Prisma.InputJsonValue,
            generationParamsHash: voiceVersion.baseGenerationParamsHash,
            seed: chunk.seed,
            targetSampleRate: chunk.targetSampleRate ?? 24_000,
            targetChannels: chunk.targetChannels ?? 1,
            status: 'PENDING',
            dedupeKey,
            forced: Boolean(body.force),
            forceToken: body.force ? coordinatorJobId : null,
          },
        });

        created.push({ jobId, ttsJobId, envelope });
      }

      await tx.book.update({
        where: { id: bookId },
        data: { status: 'GENERATING', statusChangedAt: now },
      });
    });

    await Promise.all(
      created.map(({ jobId, envelope }) =>
        enqueueProcessingJob(this.prisma, this.queueManager, {
          processingJobId: jobId,
          queue: 'gpu',
          envelope,
          jobName: 'generate_tts_chunk',
          maxAttempts: 3,
        }),
      ),
    );

    this.logger.info(
      {
        book_id: bookId,
        planned_unit_count: created.length,
        skipped_unit_count: chunks.length - targetable.length,
      },
      'Enqueued generate_tts_chunk commands',
    );

    return {
      job: {
        id: coordinatorJobId,
        object: 'job' as const,
        type: 'generate_tts_chunk' as const,
        status: 'QUEUED' as const,
        book_id: bookId,
      },
      accepted: {
        scope: body.scope,
        planned_unit_count: created.length,
        skipped_unit_count: chunks.length - targetable.length,
        priority,
      },
    };
  }

  async getTtsState(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.requireOwnedBook(principal, bookId);
    const grouped = await this.prisma.audioChunk.groupBy({
      by: ['status'],
      where: { bookId, isCurrent: true },
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const row of grouped) counts[row.status] = row._count._all;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const done = (counts.VALIDATED ?? 0) + (counts.ASSEMBLED ?? 0) + (counts.GENERATED ?? 0);

    return {
      object: 'tts_state' as const,
      book_id: bookId,
      status: book.status,
      counts: {
        chunks_pending: counts.PENDING ?? 0,
        chunks_generating: counts.GENERATING ?? 0,
        chunks_generated: counts.GENERATED ?? 0,
        chunks_validated: counts.VALIDATED ?? 0,
        chunks_failed: counts.FAILED ?? 0,
        chunks_invalid: counts.INVALID ?? 0,
        chunks_superseded: counts.SUPERSEDED ?? 0,
      },
      progress: total > 0 ? done / total : 0,
    };
  }

  async listAudioChunks(
    principal: AuthenticatedPrincipal,
    bookId: string,
    query: {
      chapter_id?: string;
      status?: string;
      character_id?: string;
      cursor?: string;
      limit?: string;
    },
  ) {
    await this.requireOwnedBook(principal, bookId);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const where: Prisma.AudioChunkWhereInput = { bookId, isCurrent: true };
    if (query.chapter_id) where.chapterId = query.chapter_id;
    if (query.status) where.status = query.status as never;
    if (query.character_id) where.characterId = query.character_id;
    if (cursor) where.sequenceIndex = { gt: Number(cursor.v) };

    const rows = await this.prisma.audioChunk.findMany({
      where,
      orderBy: { sequenceIndex: 'asc' },
      take: limit + 1,
    });
    const page = paginate(
      rows,
      limit,
      (r) => r.sequenceIndex,
      (r) => r.id,
    );
    return { data: page.data.map((r) => this.toAudioChunkDto(r)), page: page.page };
  }

  async getAudioChunk(principal: AuthenticatedPrincipal, bookId: string, audioChunkId: string) {
    await this.requireOwnedBook(principal, bookId);
    const chunk = await this.prisma.audioChunk.findFirst({ where: { id: audioChunkId, bookId } });
    if (!chunk) throw new NotFoundError({ message: 'Audio chunk not found.' });
    return this.toAudioChunkDto(chunk);
  }

  async createAudioChunkAccessUrl(
    principal: AuthenticatedPrincipal,
    bookId: string,
    audioChunkId: string,
    body: CreateAccessUrlBody,
  ) {
    await this.requireOwnedBook(principal, bookId);
    const chunk = await this.prisma.audioChunk.findFirst({ where: { id: audioChunkId, bookId } });
    if (!chunk) throw new NotFoundError({ message: 'Audio chunk not found.' });
    if (!['GENERATED', 'VALIDATED', 'INVALID'].includes(chunk.status)) {
      throw new ConflictError({
        code: 'ARTIFACT_NOT_READY',
        message: `Audio chunk is ${chunk.status}; bytes are not available.`,
      });
    }
    const expiresIn = body.expires_in_seconds ?? 300;
    const url = await this.storage.getSignedUrl(chunk.storageKey, 'GET', expiresIn);
    return {
      object: 'access_url' as const,
      url,
      method: 'GET' as const,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      disposition: body.disposition ?? 'INLINE',
      content_type: 'audio/wav',
      size_bytes: chunk.sizeBytes ? Number(chunk.sizeBytes) : null,
      content_hash: { algorithm: 'sha256' as const, value: chunk.contentHash },
    };
  }

  // ---------------------------------------------------------------- helpers ----

  private async requireOwnedBook(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.prisma.book.findFirst({
      where: { id: bookId, tenantId: principal.tenantId },
    });
    assertTenantOwnership(book, principal, 'Book not found.');
    return book;
  }

  private resolveChunkWhere(
    audioScriptId: string,
    bookId: string,
    body: StartTtsBody,
  ): Prisma.AudioScriptChunkWhereInput {
    const base: Prisma.AudioScriptChunkWhereInput = { audioScriptId, bookId, isCurrent: true };
    if (body.scope === 'CHAPTERS') {
      if (!body.chapter_ids?.length) {
        throw new ValidationError({
          code: 'VALIDATION_FAILED',
          message: 'chapter_ids is required for scope CHAPTERS.',
        });
      }
      return { ...base, chapterId: { in: body.chapter_ids } };
    }
    if (body.scope === 'CHUNKS') {
      if (!body.chunk_ids?.length) {
        throw new ValidationError({
          code: 'VALIDATION_FAILED',
          message: 'chunk_ids is required for scope CHUNKS.',
        });
      }
      return { ...base, id: { in: body.chunk_ids } };
    }
    if (body.scope === 'FILTER') {
      const filter = body.filter;
      if (!filter?.audio_chunk_status?.length) {
        throw new ValidationError({
          code: 'VALIDATION_FAILED',
          message: 'filter.audio_chunk_status is required for scope FILTER.',
        });
      }
      return {
        ...base,
        ...(filter.chapter_ids?.length ? { chapterId: { in: filter.chapter_ids } } : {}),
        currentAudioChunk: { status: { in: filter.audio_chunk_status as never } },
      };
    }
    return base; // BOOK
  }

  private async filterAlreadyGenerated<
    T extends { id: string; voiceProfileVersionId: string | null; sourceContentHash: string },
  >(chunks: T[]): Promise<T[]> {
    const existing = await this.prisma.audioChunk.findMany({
      where: {
        audioScriptChunkId: { in: chunks.map((c) => c.id) },
        isCurrent: true,
        status: { in: [...IN_PROGRESS_AUDIO_CHUNK_STATUSES] },
      },
      select: { audioScriptChunkId: true, voiceProfileVersionId: true, sourceContentHash: true },
    });
    const doneByChunk = new Map(existing.map((e) => [e.audioScriptChunkId, e]));
    return chunks.filter((c) => {
      const done = doneByChunk.get(c.id);
      if (!done) return true;
      return !(
        done.voiceProfileVersionId === c.voiceProfileVersionId &&
        done.sourceContentHash === c.sourceContentHash
      );
    });
  }

  private toAudioChunkDto(chunk: {
    id: string;
    audioScriptChunkId: string;
    chapterId: string;
    sceneId: string | null;
    sequenceIndex: number;
    generationVersion: number;
    isCurrent: boolean;
    status: string;
    voiceProfileVersionId: string;
    ttsProviderId: string;
    ttsModelVersionId: string;
    durationMs: number;
    sampleRate: number;
    channels: number;
    format: string;
    validationStatus: string;
    validation: unknown;
    capabilityGaps: unknown;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: Date;
  }) {
    return {
      id: chunk.id,
      object: 'audio_chunk' as const,
      audio_script_chunk_id: chunk.audioScriptChunkId,
      chapter_id: chunk.chapterId,
      scene_id: chunk.sceneId,
      sequence_index: chunk.sequenceIndex,
      generation_version: chunk.generationVersion,
      is_current: chunk.isCurrent,
      status: chunk.status,
      lineage: {
        voice_profile_version_id: chunk.voiceProfileVersionId,
        tts_provider_id: chunk.ttsProviderId,
        tts_model_version_id: chunk.ttsModelVersionId,
      },
      technical: {
        duration_ms: chunk.durationMs,
        sample_rate: chunk.sampleRate,
        channels: chunk.channels,
        format: chunk.format,
      },
      validation: { status: chunk.validationStatus, detail: chunk.validation },
      capability_gaps: chunk.capabilityGaps,
      error: chunk.errorCode ? { code: chunk.errorCode, message: chunk.errorMessage } : null,
      created_at: chunk.createdAt.toISOString(),
    };
  }
}

function ttsDedupeKey(input: {
  chunkId: string;
  chunkVersion: number;
  voiceProfileVersionId: string;
  ttsModelVersionId: string;
  generationParamsHash: string;
  seed: bigint | null;
  forceToken: string | null;
}): string {
  return createHash('sha256')
    .update(
      [
        input.chunkId,
        String(input.chunkVersion),
        input.voiceProfileVersionId,
        input.ttsModelVersionId,
        input.generationParamsHash,
        input.seed?.toString() ?? '',
        input.forceToken ?? '',
      ].join(':'),
    )
    .digest('hex');
}
