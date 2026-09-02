import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import { ConflictError, NotFoundError, ValidationError } from '@audio-book/errors';
import { generateId, writeOutboxMessage } from '@audio-book/events';
import type { Logger } from '@audio-book/logging';
import { enqueueProcessingJob, QueueManager } from '@audio-book/queue';
import { LOGGER, PRISMA, QUEUE_MANAGER } from '../common/tokens.js';
import { assertTenantOwnership } from '../common/tenant.js';
import { decodeCursor, paginate, parseLimit } from '../common/pagination.js';
import type { AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';

const PRODUCER = 'api';
const PRODUCER_VERSION = '1.0.0';

/** JobStatus values that mean "this job is still in flight" (mirrors books.service.ts). */
const ACTIVE_JOB_STATUSES = ['CREATED', 'QUEUED', 'RUNNING', 'RETRYING', 'BLOCKED'] as const;
const ANALYSIS_JOB_TYPES = ['analyze_scene', 'build_story_bible_delta'] as const;
const INGESTION_COMPLETE_STATUSES = ['READY', 'PARTIAL_OCR'] as const;

export interface StartAnalysisBody {
  scope: 'BOOK' | 'CHAPTERS';
  chapter_ids?: string[];
  mode: 'INCREMENTAL' | 'REBUILD';
  force?: boolean;
  priority?: 'INTERACTIVE' | 'NORMAL' | 'BULK';
}

export interface UpdateCharacterBody {
  display_name?: string;
  status?: 'CONFIRMED' | 'RETIRED';
  importance_rank?: number;
  speaking?: boolean;
  pronoun_sets?: unknown;
  speech_traits?: unknown;
}

export interface CreateCharacterAliasBody {
  surface_form: string;
  alias_type:
    | 'GIVEN_NAME'
    | 'FULL_NAME'
    | 'SURNAME'
    | 'NICKNAME'
    | 'TITLE'
    | 'EPITHET'
    | 'DESCRIPTOR'
    | 'RELATIONAL';
  valid_from_spine?: number | null;
  valid_to_spine?: number | null;
  scope?: {
    kind: 'GLOBAL' | 'CHAPTER' | 'SPEAKER';
    chapter_id?: string | null;
    speaker_character_id?: string | null;
  };
}

export interface UpdateCharacterAliasBody {
  surface_form?: string;
  alias_type?: CreateCharacterAliasBody['alias_type'];
  valid_from_spine?: number | null;
  valid_to_spine?: number | null;
}

export interface CreateCharacterMergeBody {
  operation: 'MERGE' | 'SPLIT';
  losing_character_id: string;
  winning_character_id: string;
  voice_conflict_resolution?: unknown;
  rebind_scope?: 'AFFECTED_CHUNKS_ONLY';
}

export interface CreatePronunciationEntryBody {
  surface_form: string;
  ipa?: string;
  lexicon_key?: string;
  applies_to: 'GLOBAL' | 'CHARACTER' | 'CHAPTER';
  applies_to_character_id?: string | null;
  applies_to_chapter_id?: string | null;
  notes?: string | null;
}

export interface UpdatePronunciationEntryBody {
  ipa?: string;
  lexicon_key?: string;
  notes?: string | null;
}

@Injectable()
export class AnalysisService {
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

  private async requireCharacter(bookId: string, characterId: string) {
    const character = await this.prisma.character.findFirst({
      where: { id: characterId, bookId },
    });
    if (!character) throw new NotFoundError({ message: 'Character not found.' });
    return character;
  }

  // ---- Analysis lifecycle ----

  async startAnalysis(principal: AuthenticatedPrincipal, bookId: string, body: StartAnalysisBody) {
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
        message: 'Ingestion must complete before analysis can start.',
      });
    }

    const running = await this.prisma.processingJob.findFirst({
      where: {
        bookId,
        type: { in: [...ANALYSIS_JOB_TYPES] },
        status: { in: [...ACTIVE_JOB_STATUSES] },
      },
    });
    if (running) {
      throw new ConflictError({
        code: 'ANALYSIS_ALREADY_RUNNING',
        message: 'Analysis is already running for this book.',
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
    }
    if (chapters.length === 0) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'No chapters found to analyze for the requested scope.',
      });
    }

    const firstChapter = chapters[0]!;
    const jobId = generateId();
    const correlationId = generateId();
    const now = new Date();
    const priority = body.priority ?? 'NORMAL';
    // Built once: persisted on the ProcessingJob row inside the transaction so
    // ProcessingJobSweeper can re-dispatch it if this process dies before the
    // enqueue below, and reused verbatim by that enqueue (F-4).
    const envelope = {
      job_id: jobId,
      entity_id: jobId,
      correlation_id: correlationId,
      tenant_id: principal.tenantId,
      payload: {
        book_id: bookId,
        book_version_id: bookVersion.id,
        chapter_id: firstChapter.id,
        spine_start: firstChapter.spineStart,
        spine_end: firstChapter.spineEnd,
        story_bible_version_id: null,
        analysis_mode: body.mode,
        remaining_chapter_ids: chapters.slice(1).map((c) => c.id),
        root_job_id: jobId,
        chapters_total: chapters.length,
      },
    };

    await withTransaction(this.prisma, async (tx) => {
      await tx.processingJob.create({
        data: {
          id: jobId,
          tenantId: principal.tenantId,
          bookId,
          type: 'analyze_scene',
          queue: 'ai',
          priority,
          relatedResourceType: 'book_version',
          relatedResourceId: bookVersion.id,
          scope: {
            requested_chapter_ids: chapters.map((c) => c.id),
            mode: body.mode,
            force: Boolean(body.force),
          },
          status: 'CREATED',
          statusChangedAt: now,
          maxAttempts: 3,
          idempotencyKey: `analyze_scene:${bookVersion.id}:${firstChapter.id}:${body.mode}:${jobId}`,
          idempotencyFingerprint: bookVersion.contentHash,
          correlationId,
          forced: Boolean(body.force),
          createdByUserId: principal.sub,
          dispatchEnvelope: envelope,
        },
      });

      await tx.book.update({
        where: { id: bookId },
        data: { status: 'ANALYZING', statusChangedAt: now },
      });
    });

    await enqueueProcessingJob(this.prisma, this.queueManager, {
      processingJobId: jobId,
      queue: 'ai',
      envelope,
      jobName: 'analyze_scene',
      maxAttempts: 3,
    });

    this.logger.info(
      { job_id: jobId, book_id: bookId, chapter_count: chapters.length },
      'Enqueued analyze_scene command (analysis start)',
    );

    return {
      job: {
        id: jobId,
        object: 'job' as const,
        type: 'analyze_scene' as const,
        status: 'CREATED' as const,
        book_id: bookId,
      },
      accepted: {
        scope: body.scope,
        chapter_ids: chapters.map((c) => c.id),
        planned_unit_count: chapters.length,
        skipped_unit_count: 0,
      },
    };
  }

  async getAnalysisStatus(principal: AuthenticatedPrincipal, bookId: string) {
    await this.requireOwnedBook(principal, bookId);

    const rootJob = await this.prisma.processingJob.findFirst({
      where: { bookId, type: { in: [...ANALYSIS_JOB_TYPES] }, parentJobId: null },
      orderBy: { createdAt: 'desc' },
    });

    const storyBible = await this.prisma.storyBible.findUnique({ where: { bookId } });
    const [charactersProvisional, charactersConfirmed, sceneCount, snapshotCount] =
      await Promise.all([
        this.prisma.character.count({ where: { bookId, status: 'PROVISIONAL' } }),
        this.prisma.character.count({ where: { bookId, status: 'CONFIRMED' } }),
        this.prisma.scene.count({ where: { bookId } }),
        this.prisma.narrativeState.count({ where: { bookId } }),
      ]);

    let status: string = 'NOT_STARTED';
    if (rootJob) {
      const children = await this.prisma.processingJob.count({
        where: { parentJobId: rootJob.id },
      });
      if (rootJob.status === 'SUCCEEDED' && storyBible?.status === 'READY') status = 'COMPLETED';
      else if (rootJob.status === 'FAILED') status = 'FAILED';
      else if (rootJob.status === 'CANCELLED') status = 'CANCELLED';
      else if (rootJob.status === 'RUNNING' || (children > 0 && rootJob.status !== 'SUCCEEDED'))
        status = 'RUNNING';
      else status = 'QUEUED';
    }

    const scope =
      (rootJob?.scope as { requested_chapter_ids?: string[]; mode?: string } | null) ?? {};

    return {
      object: 'analysis_state' as const,
      book_id: bookId,
      status,
      mode: scope.mode ?? null,
      spine_position: storyBible?.spinePositionAnalyzed ?? null,
      counts: {
        scenes: sceneCount,
        characters_provisional: charactersProvisional,
        characters_confirmed: charactersConfirmed,
        snapshots: snapshotCount,
      },
      story_bible_snapshot_version: storyBible?.currentVersionNumber ?? null,
      degraded: storyBible?.degraded ?? false,
      current_job_id: rootJob?.id ?? null,
    };
  }

  // ---- Scenes (read-only) ----

  async listScenes(
    principal: AuthenticatedPrincipal,
    bookId: string,
    query: { chapter_id?: string; cursor?: string; limit?: string },
  ) {
    const book = await this.requireOwnedBook(principal, bookId);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    const where: Prisma.SceneWhereInput = { bookId };
    if (book.currentBookVersionId) where.bookVersionId = book.currentBookVersionId;
    if (query.chapter_id) where.chapterId = query.chapter_id;
    if (cursor) where.orderIndex = { gt: Number(cursor.v) };

    const scenes = await this.prisma.scene.findMany({
      where,
      orderBy: { orderIndex: 'asc' },
      take: limit + 1,
      include: { semantics: true },
    });

    const page = paginate(
      scenes,
      limit,
      (s) => s.orderIndex,
      (s) => s.id,
    );
    return { ...page, data: page.data.map(toSceneDto) };
  }

  async getScene(principal: AuthenticatedPrincipal, bookId: string, sceneId: string) {
    await this.requireOwnedBook(principal, bookId);
    const scene = await this.prisma.scene.findFirst({
      where: { id: sceneId, bookId },
      include: { semantics: true },
    });
    if (!scene) throw new NotFoundError({ message: 'Scene not found.' });
    return toSceneDto(scene);
  }

  // ---- Characters ----

  async listCharacters(
    principal: AuthenticatedPrincipal,
    bookId: string,
    query: {
      status?: string;
      speaking?: string;
      include_sentinels?: string;
      cursor?: string;
      limit?: string;
    },
  ) {
    await this.requireOwnedBook(principal, bookId);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const includeSentinels = query.include_sentinels !== 'false';

    const where: Prisma.CharacterWhereInput = { bookId };
    if (query.status) where.status = query.status as never;
    if (query.speaking !== undefined) where.speaking = query.speaking === 'true';
    if (!includeSentinels) where.isSentinel = false;
    if (cursor) {
      where.OR = [
        { importanceRank: { gt: Number(cursor.v) } },
        { importanceRank: Number(cursor.v), id: { gt: cursor.id } },
        { importanceRank: null, id: { gt: cursor.id } },
      ];
    }

    const characters = await this.prisma.character.findMany({
      where,
      orderBy: [{ importanceRank: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: limit + 1,
    });

    const page = paginate(
      characters,
      limit,
      (c) => c.importanceRank ?? Number.MAX_SAFE_INTEGER,
      (c) => c.id,
    );
    return { ...page, data: page.data.map(toCharacterDto) };
  }

  async getCharacter(principal: AuthenticatedPrincipal, bookId: string, characterId: string) {
    await this.requireOwnedBook(principal, bookId);
    const character = await this.requireCharacter(bookId, characterId);
    return toCharacterDto(character);
  }

  async updateCharacter(
    principal: AuthenticatedPrincipal,
    bookId: string,
    characterId: string,
    body: UpdateCharacterBody,
  ) {
    await this.requireOwnedBook(principal, bookId);
    const character = await this.requireCharacter(bookId, characterId);
    if (character.isSentinel) {
      throw new ConflictError({
        code: 'SENTINEL_CHARACTER_IMMUTABLE',
        message: 'Reserved sentinel characters cannot be modified.',
      });
    }
    if (body.status && character.status === 'MERGED_INTO') {
      throw new ConflictError({
        code: 'INVALID_STATE_TRANSITION',
        message: 'A merged character cannot change status directly.',
      });
    }

    const updated = await this.prisma.character.update({
      where: { id: characterId },
      data: {
        displayName: body.display_name,
        status: body.status,
        importanceRank: body.importance_rank,
        speaking: body.speaking,
        pronounSets: body.pronoun_sets as Prisma.InputJsonValue | undefined,
        speechTraits: body.speech_traits as Prisma.InputJsonValue | undefined,
        rowVersion: { increment: 1 },
      },
    });

    return {
      ...toCharacterDto(updated),
      impact: {
        audio_script_chunks_reopened: 0,
        audio_script_chunks_frozen_unchanged: 0,
        audio_chunks_unaffected: 0,
        requires_director_rerun: false,
      },
    };
  }

  // ---- Character aliases ----

  async listCharacterAliases(
    principal: AuthenticatedPrincipal,
    bookId: string,
    characterId: string,
  ) {
    await this.requireOwnedBook(principal, bookId);
    await this.requireCharacter(bookId, characterId);
    const aliases = await this.prisma.characterAlias.findMany({
      where: { characterId },
      orderBy: { createdAt: 'asc' },
    });
    return aliases.map(toAliasDto);
  }

  async createCharacterAlias(
    principal: AuthenticatedPrincipal,
    bookId: string,
    characterId: string,
    body: CreateCharacterAliasBody,
  ) {
    await this.requireOwnedBook(principal, bookId);
    await this.requireCharacter(bookId, characterId);

    const normalized = normalizeSurfaceForm(body.surface_form);
    const scopeKind = body.scope?.kind ?? 'GLOBAL';
    const scopeChapterId = scopeKind === 'CHAPTER' ? (body.scope?.chapter_id ?? null) : null;
    const scopeSpeakerCharacterId =
      scopeKind === 'SPEAKER' ? (body.scope?.speaker_character_id ?? null) : null;

    const conflict = await this.findAliasConflict({
      bookId,
      characterId,
      normalized,
      scopeKind,
      scopeChapterId,
      scopeSpeakerCharacterId,
      validFromSpine: body.valid_from_spine ?? null,
      validToSpine: body.valid_to_spine ?? null,
    });
    if (conflict) {
      throw new ConflictError({
        code: 'ALIAS_CONFLICT',
        message:
          'This surface form already resolves to a different character in an overlapping scope.',
        details: [{ field: 'surface_form', issue: 'conflict' }],
      });
    }

    const alias = await this.prisma.characterAlias.create({
      data: {
        id: generateId(),
        tenantId: principal.tenantId,
        bookId,
        characterId,
        surfaceForm: body.surface_form,
        surfaceFormNormalized: normalized,
        aliasType: body.alias_type,
        scopeKind,
        scopeChapterId,
        scopeSpeakerCharacterId,
        validFromSpine: body.valid_from_spine ?? null,
        validToSpine: body.valid_to_spine ?? null,
        source: 'USER',
      },
    });
    return toAliasDto(alias);
  }

  async updateCharacterAlias(
    principal: AuthenticatedPrincipal,
    bookId: string,
    characterId: string,
    aliasId: string,
    body: UpdateCharacterAliasBody,
  ) {
    await this.requireOwnedBook(principal, bookId);
    const alias = await this.prisma.characterAlias.findFirst({
      where: { id: aliasId, characterId, bookId },
    });
    if (!alias) throw new NotFoundError({ message: 'Alias not found.' });

    const updated = await this.prisma.characterAlias.update({
      where: { id: aliasId },
      data: {
        surfaceForm: body.surface_form,
        surfaceFormNormalized: body.surface_form
          ? normalizeSurfaceForm(body.surface_form)
          : undefined,
        aliasType: body.alias_type,
        validFromSpine: body.valid_from_spine,
        validToSpine: body.valid_to_spine,
      },
    });
    return toAliasDto(updated);
  }

  async deleteCharacterAlias(
    principal: AuthenticatedPrincipal,
    bookId: string,
    characterId: string,
    aliasId: string,
  ): Promise<void> {
    await this.requireOwnedBook(principal, bookId);
    const alias = await this.prisma.characterAlias.findFirst({
      where: { id: aliasId, characterId, bookId },
    });
    if (!alias) throw new NotFoundError({ message: 'Alias not found.' });
    await this.prisma.characterAlias.delete({ where: { id: aliasId } });
  }

  private async findAliasConflict(args: {
    bookId: string;
    characterId: string;
    normalized: string;
    scopeKind: string;
    scopeChapterId: string | null;
    scopeSpeakerCharacterId: string | null;
    validFromSpine: number | null;
    validToSpine: number | null;
  }) {
    const candidates = await this.prisma.characterAlias.findMany({
      where: {
        bookId: args.bookId,
        surfaceFormNormalized: args.normalized,
        scopeKind: args.scopeKind as never,
        scopeChapterId: args.scopeChapterId,
        scopeSpeakerCharacterId: args.scopeSpeakerCharacterId,
        characterId: { not: args.characterId },
      },
    });
    return candidates.find((c) =>
      rangesOverlap(args.validFromSpine, args.validToSpine, c.validFromSpine, c.validToSpine),
    );
  }

  // ---- Character merges ----

  async createCharacterMerge(
    principal: AuthenticatedPrincipal,
    bookId: string,
    body: CreateCharacterMergeBody,
  ) {
    await this.requireOwnedBook(principal, bookId);
    const [losing, winning] = await Promise.all([
      this.requireCharacter(bookId, body.losing_character_id),
      this.requireCharacter(bookId, body.winning_character_id),
    ]);
    if (losing.isSentinel || winning.isSentinel) {
      throw new ConflictError({
        code: 'SENTINEL_CHARACTER_IMMUTABLE',
        message: 'Sentinel characters cannot participate in a merge.',
      });
    }
    if (body.operation === 'MERGE' && losing.status === 'MERGED_INTO') {
      throw new ConflictError({
        code: 'INVALID_STATE_TRANSITION',
        message: 'The losing character has already been merged.',
      });
    }

    const mergeId = generateId();
    const now = new Date();

    const { aliasesMoved, merge } = await withTransaction(this.prisma, async (tx) => {
      let aliasesMovedCount = 0;
      if (body.operation === 'MERGE') {
        const moved = await tx.characterAlias.updateMany({
          where: { characterId: losing.id },
          data: { characterId: winning.id },
        });
        aliasesMovedCount = moved.count;
        await tx.character.update({
          where: { id: losing.id },
          data: { status: 'MERGED_INTO', mergedIntoCharacterId: winning.id },
        });
      } else {
        await tx.character.update({
          where: { id: losing.id },
          data: { status: 'PROVISIONAL', mergedIntoCharacterId: null },
        });
      }

      const created = await tx.characterMerge.create({
        data: {
          id: mergeId,
          tenantId: principal.tenantId,
          bookId,
          operation: body.operation,
          losingCharacterId: losing.id,
          winningCharacterId: winning.id,
          voiceConflictResolution: body.voice_conflict_resolution ?? undefined,
          rebindScope: body.rebind_scope ?? 'AFFECTED_CHUNKS_ONLY',
          aliasesMovedCount,
          performedByUserId: principal.sub,
        },
      });

      await writeOutboxMessage(tx, {
        eventType: 'character.merged',
        schemaVersion: '1.0',
        tenantId: principal.tenantId,
        bookId,
        correlationId: generateId(),
        causationId: generateId(),
        producer: PRODUCER,
        producerVersion: PRODUCER_VERSION,
        aggregateType: 'character',
        aggregateId: winning.id,
        payload: {
          character_merge_id: mergeId,
          losing_character_id: losing.id,
          winning_character_id: winning.id,
          operation: body.operation,
          draft_chunks_rebound: 0,
          generated_chunks_to_reversion: 0,
          chapters_affected: [],
        },
      });

      return { aliasesMoved: aliasesMovedCount, merge: created };
    });

    this.logger.info(
      { merge_id: mergeId, book_id: bookId, aliases_moved: aliasesMoved, at: now.toISOString() },
      'Character merge recorded',
    );

    return toMergeDto(merge);
  }

  async listCharacterMerges(
    principal: AuthenticatedPrincipal,
    bookId: string,
    query: { cursor?: string; limit?: string },
  ) {
    await this.requireOwnedBook(principal, bookId);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    const merges = await this.prisma.characterMerge.findMany({
      where: {
        bookId,
        ...(cursor ? { createdAt: { lt: new Date(cursor.v) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    const page = paginate(
      merges,
      limit,
      (m) => m.createdAt.toISOString(),
      (m) => m.id,
    );
    return { ...page, data: page.data.map(toMergeDto) };
  }

  // ---- Story Bible ----

  async getStoryBible(
    principal: AuthenticatedPrincipal,
    bookId: string,
    query: { sections?: string; snapshot_version?: string },
  ) {
    await this.requireOwnedBook(principal, bookId);
    const storyBible = await this.prisma.storyBible.findUnique({ where: { bookId } });
    if (!storyBible) {
      return {
        object: 'story_bible' as const,
        book_id: bookId,
        status: 'NOT_BUILT' as const,
        current_snapshot_version: null,
        coverage: { chapters_analyzed: 0, chapters_total: 0, spine_position: null },
        stale: false,
        stale_reasons: [],
        degraded: false,
        sections: {},
      };
    }

    const requestedSections = (query.sections ?? 'summary').split(',').map((s) => s.trim());
    const versionNumber = query.snapshot_version
      ? Number(query.snapshot_version)
      : storyBible.currentVersionNumber;
    const version = versionNumber
      ? await this.prisma.storyBibleVersion.findFirst({
          where: { bookId, version: versionNumber },
        })
      : null;

    const sections: Record<string, unknown> = {};
    if (version && requestedSections.includes('summary')) {
      const [characterCount, locationCount, timelineCount] = await Promise.all([
        this.prisma.character.count({ where: { bookId } }),
        this.prisma.narrativeLocation.count({ where: { storyBibleVersionId: version.id } }),
        this.prisma.narrativeTimelineEvent.count({ where: { storyBibleVersionId: version.id } }),
      ]);
      sections.summary = {
        pov_type: version.povType,
        character_count: characterCount,
        location_count: locationCount,
        timeline_event_count: timelineCount,
      };
    }
    if (version && requestedSections.includes('relationships')) {
      const relationships = await this.prisma.characterRelationship.findMany({
        where: { storyBibleVersionId: version.id },
        take: 200,
      });
      sections.relationships = relationships.map(toRelationshipDto);
    }
    if (version && requestedSections.includes('locations')) {
      const locations = await this.prisma.narrativeLocation.findMany({
        where: { storyBibleVersionId: version.id },
        take: 200,
      });
      sections.locations = locations.map((l) => ({
        id: l.id,
        name: l.name,
        location_kind: l.locationKind,
        confidence: l.confidence,
      }));
    }
    if (version && requestedSections.includes('timeline')) {
      const events = await this.prisma.narrativeTimelineEvent.findMany({
        where: { storyBibleVersionId: version.id },
        orderBy: { ordinal: 'asc' },
        take: 500,
      });
      sections.timeline = events.map((e) => ({
        id: e.id,
        title: e.title,
        ordinal: e.ordinal,
        span_kind: e.spanKind,
        in_story_time_marker: e.inStoryTimeMarker,
        confidence: e.confidence,
      }));
    }
    if (version && requestedSections.includes('unresolved')) {
      const threads = await this.prisma.narrativeThread.findMany({
        where: { storyBibleVersionId: version.id, status: 'OPEN' },
        take: 200,
      });
      sections.unresolved = threads.map((t) => ({
        id: t.id,
        kind: t.kind,
        summary: t.summary,
        opened_spine_position: t.openedSpinePosition,
        confidence: t.confidence,
      }));
    }

    return {
      object: 'story_bible' as const,
      book_id: bookId,
      status: storyBible.status,
      current_snapshot_version: storyBible.currentVersionNumber,
      generated_snapshot_version: version?.version ?? null,
      generated_by: version
        ? {
            model_version_id: version.builtByModelVersionId,
            source_content_hash: version.sourceContentHash,
          }
        : null,
      coverage: {
        chapters_analyzed: storyBible.chaptersAnalyzed,
        chapters_total: storyBible.chaptersTotal,
        spine_position: storyBible.spinePositionAnalyzed,
      },
      stale: storyBible.stale,
      stale_reasons: storyBible.staleReasons,
      degraded: storyBible.degraded,
      last_updated_at: storyBible.lastUpdatedAt,
      sections,
    };
  }

  async listStoryBibleSnapshots(
    principal: AuthenticatedPrincipal,
    bookId: string,
    query: { chapter_id?: string; scene_id?: string; cursor?: string; limit?: string },
  ) {
    await this.requireOwnedBook(principal, bookId);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    const where: Prisma.NarrativeStateWhereInput = { bookId };
    if (query.chapter_id) where.chapterId = query.chapter_id;
    if (query.scene_id) where.sceneId = query.scene_id;
    if (cursor) where.spinePosition = { gt: Number(cursor.v) };

    const snapshots = await this.prisma.narrativeState.findMany({
      where,
      orderBy: { spinePosition: 'asc' },
      take: limit + 1,
    });
    const page = paginate(
      snapshots,
      limit,
      (s) => s.spinePosition,
      (s) => s.id,
    );
    return { ...page, data: page.data.map(toNarrativeStateDto) };
  }

  async getStoryBibleSnapshot(
    principal: AuthenticatedPrincipal,
    bookId: string,
    snapshotId: string,
  ) {
    await this.requireOwnedBook(principal, bookId);
    const snapshot = await this.prisma.narrativeState.findFirst({
      where: { id: snapshotId, bookId },
    });
    if (!snapshot) throw new NotFoundError({ message: 'Narrative state snapshot not found.' });
    return toNarrativeStateDto(snapshot);
  }

  // ---- DirectorContext (task §185-187: the versioned hand-off to a future
  // Director — bounded L1-L6 context assembly from already-persisted data,
  // no LLM call, no speaker/emotion/pacing decision of any kind). Mirrors
  // context.md §5.4's six-layer bundle and api-specification.md §17.1's
  // internal context-bundle contract, exposed here under the same
  // tenant-scoped auth as everything else rather than a separate
  // service-to-service auth boundary — see the Phase 3 report's flagged
  // simplifications for why. ----

  async getDirectorContext(
    principal: AuthenticatedPrincipal,
    bookId: string,
    query: { paragraph_id: string; token_budget?: string },
  ) {
    const book = await this.requireOwnedBook(principal, bookId);
    const tokenBudget = query.token_budget ? Number(query.token_budget) : 4000;

    const paragraph = await this.prisma.paragraph.findFirst({
      where: { id: query.paragraph_id, bookId },
    });
    if (!paragraph) throw new NotFoundError({ message: 'Paragraph not found.' });

    const chunkTokenEstimate = Math.ceil(paragraph.text.length / 4);
    if (chunkTokenEstimate > tokenBudget) {
      throw new ConflictError({
        code: 'CHUNK_SPLIT_REQUIRED',
        message:
          'The requested paragraph does not fit the token budget and must be split upstream.',
      });
    }

    const degradedLayers: string[] = [];
    const storyBible = await this.prisma.storyBible.findUnique({ where: { bookId } });
    const storyBibleVersionId = storyBible?.currentVersionId ?? null;
    if (!storyBibleVersionId) degradedLayers.push('L2');

    const [chapter, adjacent, scene, characters] = await Promise.all([
      this.prisma.chapter.findUnique({ where: { id: paragraph.chapterId } }),
      this.prisma.paragraph.findMany({
        where: { chapterId: paragraph.chapterId, bookVersionId: paragraph.bookVersionId },
        orderBy: { orderIndex: 'asc' },
      }),
      paragraph.sceneId
        ? this.prisma.sceneSemantics.findFirst({
            where: {
              sceneId: paragraph.sceneId,
              ...(storyBibleVersionId ? { storyBibleVersionId } : {}),
            },
            include: { participants: true },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve(null),
      this.prisma.character.findMany({
        where: { bookId, status: { in: ['CONFIRMED', 'PROVISIONAL'] } },
        orderBy: [{ importanceRank: { sort: 'asc', nulls: 'last' } }, { lineCount: 'desc' }],
        take: 10,
        include: { aliases: true },
      }),
    ]);
    if (!scene && paragraph.sceneId) degradedLayers.push('L4');

    const paragraphIndex = adjacent.findIndex((p) => p.id === paragraph.id);
    const previous = paragraphIndex > 0 ? adjacent[paragraphIndex - 1] : undefined;
    const next =
      paragraphIndex >= 0 && paragraphIndex < adjacent.length - 1
        ? adjacent[paragraphIndex + 1]
        : undefined;

    return {
      object: 'director_context' as const,
      book_id: bookId,
      book_version_id: paragraph.bookVersionId,
      story_bible_version_id: storyBibleVersionId,
      story_bible_snapshot_version: storyBible?.currentVersionNumber ?? null,
      chapter_id: paragraph.chapterId,
      paragraph_id: paragraph.id,
      token_budget: tokenBudget,
      token_count_estimate: chunkTokenEstimate,
      degraded: degradedLayers.length > 0,
      degraded_layers: degradedLayers,
      layers: {
        l1_global: {
          title: book.title,
          author: book.author,
          language: book.language,
        },
        l2_characters: characters.map((c) => ({
          id: c.id,
          display_name: c.displayName,
          aliases: c.aliases.map((a) => a.surfaceForm),
          speaking: c.speaking,
        })),
        l3_chapter_summary: null,
        l4_scene: scene
          ? {
              id: scene.sceneId,
              summary: scene.summary,
              mood: scene.mood,
              tension: scene.tension,
              in_story_time: scene.inStoryTime,
              participant_character_ids: scene.participants.map((p) => p.characterId),
            }
          : null,
        l5_adjacent: {
          previous_paragraph_text: previous?.text ?? null,
          next_paragraph_text: next?.text ?? null,
        },
        l6_chunk: {
          paragraph_id: paragraph.id,
          text: paragraph.text,
          chapter_title: chapter?.title ?? null,
        },
      },
    };
  }

  // ---- Pronunciations ----

  async listPronunciations(
    principal: AuthenticatedPrincipal,
    bookId: string,
    query: { cursor?: string; limit?: string },
  ) {
    await this.requireOwnedBook(principal, bookId);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    const entries = await this.prisma.pronunciationEntry.findMany({
      where: { bookId, ...(cursor ? { id: { gt: cursor.id } } : {}) },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const page = paginate(
      entries,
      limit,
      (e) => e.id,
      (e) => e.id,
    );
    return { ...page, data: page.data.map(toPronunciationDto) };
  }

  async createPronunciation(
    principal: AuthenticatedPrincipal,
    bookId: string,
    body: CreatePronunciationEntryBody,
  ) {
    await this.requireOwnedBook(principal, bookId);
    if (!body.ipa && !body.lexicon_key) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'Exactly one of ipa or lexicon_key is required.',
        details: [{ field: 'ipa', issue: 'required_without_lexicon_key' }],
      });
    }

    const normalized = normalizeSurfaceForm(body.surface_form);
    const existing = await this.prisma.pronunciationEntry.findFirst({
      where: { bookId, surfaceFormNormalized: normalized, appliesTo: body.applies_to },
    });
    if (existing) {
      throw new ConflictError({
        code: 'PRONUNCIATION_ENTRY_CONFLICT',
        message: 'A pronunciation entry for this surface form and scope already exists.',
      });
    }

    const entry = await this.prisma.pronunciationEntry.create({
      data: {
        id: generateId(),
        tenantId: principal.tenantId,
        bookId,
        surfaceForm: body.surface_form,
        surfaceFormNormalized: normalized,
        lexiconKey: body.lexicon_key,
        ipa: body.ipa,
        appliesTo: body.applies_to,
        appliesToCharacterId: body.applies_to_character_id ?? null,
        appliesToChapterId: body.applies_to_chapter_id ?? null,
        notes: body.notes ?? null,
        source: 'USER',
        createdByUserId: principal.sub,
      },
    });
    return toPronunciationDto(entry);
  }

  async updatePronunciation(
    principal: AuthenticatedPrincipal,
    bookId: string,
    entryId: string,
    body: UpdatePronunciationEntryBody,
  ) {
    await this.requireOwnedBook(principal, bookId);
    const existing = await this.prisma.pronunciationEntry.findFirst({
      where: { id: entryId, bookId },
    });
    if (!existing) throw new NotFoundError({ message: 'Pronunciation entry not found.' });

    const updated = await this.prisma.pronunciationEntry.update({
      where: { id: entryId },
      data: {
        ipa: body.ipa,
        lexiconKey: body.lexicon_key,
        notes: body.notes,
        rowVersion: { increment: 1 },
      },
    });
    return toPronunciationDto(updated);
  }

  async deletePronunciation(
    principal: AuthenticatedPrincipal,
    bookId: string,
    entryId: string,
  ): Promise<void> {
    await this.requireOwnedBook(principal, bookId);
    const existing = await this.prisma.pronunciationEntry.findFirst({
      where: { id: entryId, bookId },
    });
    if (!existing) throw new NotFoundError({ message: 'Pronunciation entry not found.' });
    await this.prisma.pronunciationEntry.delete({ where: { id: entryId } });
  }
}

function normalizeSurfaceForm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function rangesOverlap(
  aFrom: number | null,
  aTo: number | null,
  bFrom: number | null,
  bTo: number | null,
): boolean {
  const aStart = aFrom ?? -Infinity;
  const aEnd = aTo ?? Infinity;
  const bStart = bFrom ?? -Infinity;
  const bEnd = bTo ?? Infinity;
  return aStart <= bEnd && bStart <= aEnd;
}

interface CharacterRow {
  id: string;
  bookId: string;
  displayName: string;
  status: string;
  isSentinel: boolean;
  sentinelKind: string | null;
  importanceRank: number | null;
  lineCount: number;
  speaking: boolean;
  pronounSets: unknown;
  speechTraits: unknown;
  firstAppearanceChapterId: string | null;
  firstAppearanceParagraphId: string | null;
  lastAppearanceChapterId: string | null;
  lastAppearanceParagraphId: string | null;
  detectionSource: string | null;
  detectedByModelVersionId: string | null;
  detectionConfidence: number | null;
  evidenceParagraphIds: string[];
  mergedIntoCharacterId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toCharacterDto(character: CharacterRow) {
  return {
    id: character.id,
    object: 'character' as const,
    book_id: character.bookId,
    display_name: character.displayName,
    status: character.status,
    is_sentinel: character.isSentinel,
    sentinel_kind: character.sentinelKind,
    importance_rank: character.importanceRank,
    line_count: character.lineCount,
    speaking: character.speaking,
    pronoun_sets: character.pronounSets,
    speech_traits: character.speechTraits,
    first_appearance: {
      chapter_id: character.firstAppearanceChapterId,
      paragraph_id: character.firstAppearanceParagraphId,
    },
    last_appearance: {
      chapter_id: character.lastAppearanceChapterId,
      paragraph_id: character.lastAppearanceParagraphId,
    },
    detection: {
      source: character.detectionSource,
      model_version_id: character.detectedByModelVersionId,
      confidence: character.detectionConfidence,
      evidence_paragraph_ids: character.evidenceParagraphIds,
    },
    merged_into_character_id: character.mergedIntoCharacterId,
    created_at: character.createdAt,
    updated_at: character.updatedAt,
  };
}

interface AliasRow {
  id: string;
  characterId: string;
  surfaceForm: string;
  aliasType: string;
  scopeKind: string;
  scopeChapterId: string | null;
  scopeSpeakerCharacterId: string | null;
  validFromSpine: number | null;
  validToSpine: number | null;
  source: string;
  confidence: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function toAliasDto(alias: AliasRow) {
  return {
    id: alias.id,
    object: 'character_alias' as const,
    character_id: alias.characterId,
    surface_form: alias.surfaceForm,
    alias_type: alias.aliasType,
    scope: {
      kind: alias.scopeKind,
      chapter_id: alias.scopeChapterId,
      speaker_character_id: alias.scopeSpeakerCharacterId,
    },
    valid_from_spine: alias.validFromSpine,
    valid_to_spine: alias.validToSpine,
    source: alias.source,
    confidence: alias.confidence,
    created_at: alias.createdAt,
    updated_at: alias.updatedAt,
  };
}

interface MergeRow {
  id: string;
  bookId: string;
  operation: string;
  losingCharacterId: string;
  winningCharacterId: string;
  aliasesMovedCount: number;
  rebindScope: string;
  chaptersAffected: string[];
  createdAt: Date;
}

function toMergeDto(merge: MergeRow) {
  return {
    id: merge.id,
    object: 'character_merge' as const,
    book_id: merge.bookId,
    operation: merge.operation,
    losing_character_id: merge.losingCharacterId,
    winning_character_id: merge.winningCharacterId,
    aliases_moved_count: merge.aliasesMovedCount,
    rebind_scope: merge.rebindScope,
    chapters_affected: merge.chaptersAffected,
    created_at: merge.createdAt,
  };
}

interface RelationshipRow {
  id: string;
  sourceCharacterId: string;
  targetCharacterId: string;
  relationshipType: string;
  label: string | null;
  directional: boolean;
  confidence: number;
  validFromSpine: number | null;
  validToSpine: number | null;
}

function toRelationshipDto(rel: RelationshipRow) {
  return {
    id: rel.id,
    source_character_id: rel.sourceCharacterId,
    target_character_id: rel.targetCharacterId,
    relationship_type: rel.relationshipType,
    label: rel.label,
    directional: rel.directional,
    confidence: rel.confidence,
    valid_from_spine: rel.validFromSpine,
    valid_to_spine: rel.validToSpine,
  };
}

interface SceneRow {
  id: string;
  bookId: string;
  chapterId: string;
  orderIndex: number;
  startParagraphId: string;
  endParagraphId: string;
  paragraphCount: number;
  semantics?: {
    summary: string | null;
    locationId: string | null;
    inStoryTime: string | null;
    mood: string | null;
    tension: number | null;
    povCharacterId: string | null;
    narrativeStateId: string | null;
    extractedByModelVersionId: string;
    confidence: number;
  }[];
}

function toSceneDto(scene: SceneRow) {
  const semantics = scene.semantics?.[0];
  return {
    id: scene.id,
    object: 'scene' as const,
    book_id: scene.bookId,
    chapter_id: scene.chapterId,
    order_index: scene.orderIndex,
    structure: {
      source: 'book_service' as const,
      start_paragraph_id: scene.startParagraphId,
      end_paragraph_id: scene.endParagraphId,
      paragraph_count: scene.paragraphCount,
    },
    semantics: semantics
      ? {
          source: 'story_bible' as const,
          summary: semantics.summary,
          location: semantics.locationId,
          in_story_time: semantics.inStoryTime,
          mood: semantics.mood,
          tension: semantics.tension,
          pov_character_id: semantics.povCharacterId,
          narrative_state_snapshot_id: semantics.narrativeStateId,
          extracted_by_model_version_id: semantics.extractedByModelVersionId,
          confidence: semantics.confidence,
        }
      : null,
  };
}

interface NarrativeStateRow {
  id: string;
  bookId: string;
  chapterId: string;
  sceneId: string | null;
  spinePosition: number;
  povCharacterId: string | null;
  povType: string | null;
  presentCharacterIds: string[];
  unresolvedThreadIds: string[];
  extractedByModelVersionId: string;
  createdAt: Date;
}

function toNarrativeStateDto(state: NarrativeStateRow) {
  return {
    id: state.id,
    object: 'narrative_state' as const,
    book_id: state.bookId,
    chapter_id: state.chapterId,
    scene_id: state.sceneId,
    spine_position: state.spinePosition,
    pov_character_id: state.povCharacterId,
    pov_type: state.povType,
    present_character_ids: state.presentCharacterIds,
    unresolved_threads: state.unresolvedThreadIds,
    model_version_id: state.extractedByModelVersionId,
    created_at: state.createdAt,
  };
}

interface PronunciationRow {
  id: string;
  bookId: string;
  surfaceForm: string;
  ipa: string | null;
  lexiconKey: string | null;
  appliesTo: string;
  appliesToCharacterId: string | null;
  appliesToChapterId: string | null;
  notes: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

function toPronunciationDto(entry: PronunciationRow) {
  return {
    id: entry.id,
    object: 'pronunciation_entry' as const,
    book_id: entry.bookId,
    surface_form: entry.surfaceForm,
    ipa: entry.ipa,
    lexicon_key: entry.lexiconKey,
    applies_to: entry.appliesTo,
    applies_to_character_id: entry.appliesToCharacterId,
    applies_to_chapter_id: entry.appliesToChapterId,
    notes: entry.notes,
    source: entry.source,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
}
