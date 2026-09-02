import { createHash } from 'node:crypto';
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

const PRODUCTION_APPROVAL_STATES = ['APPROVED', 'LOCKED'] as const;

export interface CreateVoiceProfileBody {
  name: string;
  description?: string;
  scope: 'TENANT' | 'BOOK';
  book_id?: string;
  intended_character_ids?: string[];
}

export interface UpdateVoiceProfileBody {
  name?: string;
  description?: string;
  intended_character_ids?: string[];
}

export interface CreateVoiceProfileVersionBody {
  tts_provider_id: string;
  tts_model_id: string;
  tts_model_version_id: string;
  language: string;
  supported_languages?: string[];
  base_generation_params?: Record<string, unknown>;
  default_pitch?: number;
  default_volume?: number;
  default_pacing?: number;
  derive_from_version?: number;
  reference_audio_consent: {
    attested: boolean;
    subject: 'SYNTHETIC' | 'SELF' | 'THIRD_PARTY_CONSENTED';
    attestation_text?: string;
  };
}

export interface ApproveVoiceProfileVersionBody {
  approved: boolean;
  note?: string;
}

export interface LockVoiceProfileVersionBody {
  reason: 'USER_LOCKED';
}

export interface CreateVoicePreviewBody {
  book_id?: string;
  character_id?: string;
  priority?: 'INTERACTIVE' | 'NORMAL' | 'BULK';
  samples: { text_excerpt: string; emotion: string }[];
}

export interface AssignVoiceBody {
  voice_profile_id: string;
  voice_profile_version?: number;
  acknowledge_partial_revoice?: boolean;
}

export interface NarratorFallbackBody {
  accepted: boolean;
  applies_to?: 'MINOR_SPEAKERS_ONLY' | 'ALL_UNASSIGNED';
  max_line_count?: number;
}

/**
 * Voice Registry surface (`api-specification.md` §16.14): voice profile / version
 * lifecycle, previews, character voice assignment, and casting readiness.
 *
 * **Known scope limitation**: this implementation supports only `LIBRARY`-provenance
 * versions (a provider's predefined voice, no reference audio) — `reference_provenance`
 * is always `LIBRARY` here. Reference-audio upload (§16.14's upload-session/completion
 * pair, mirroring `BooksService`) and embedding extraction are not implemented; neither
 * of Phase 5's two wired providers (`mock`, `kokoro`) supports reference-audio or
 * embedding conditioning yet (`ProviderCapabilities.supports_reference_audio/
 * supports_embedding` are both `false`), so this does not block real usage. Voice
 * cloning is a documented follow-up, not a silent gap.
 *
 * **Known scope limitation**: binding a `SYSTEM`-scope voice profile does not perform
 * the tenant-snapshot-on-assignment mechanic §16.14 describes — this service only
 * supports assigning `TENANT`/`BOOK`-scope profiles directly. No `SYSTEM` profile is
 * created by this codebase yet (the seed script creates a `TENANT`-scope default), so
 * this gap has no current user-facing impact.
 */
@Injectable()
export class VoiceService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUE_MANAGER) private readonly queueManager: QueueManager,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  // ---------------------------------------------------------------- profiles ----

  async listVoiceProfiles(
    principal: AuthenticatedPrincipal,
    query: { scope?: string; book_id?: string; cursor?: string; limit?: string },
  ) {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const where: Prisma.VoiceProfileWhereInput = {
      deletedAt: null,
      OR: [{ tenantId: principal.tenantId }, { scope: 'SYSTEM' }],
    };
    if (query.scope) where.scope = query.scope as never;
    if (query.book_id) where.bookId = query.book_id;
    if (cursor) where.name = { gt: String(cursor.v) };

    const rows = await this.prisma.voiceProfile.findMany({
      where,
      orderBy: { name: 'asc' },
      take: limit + 1,
    });
    return paginate(
      rows,
      limit,
      (r) => r.name,
      (r) => r.id,
    ).data.map((r) => this.toVoiceProfileDto(r));
  }

  async createVoiceProfile(principal: AuthenticatedPrincipal, body: CreateVoiceProfileBody) {
    if (body.scope === 'BOOK' && !body.book_id) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'book_id is required when scope is "BOOK".',
        details: [{ field: 'book_id', issue: 'required' }],
      });
    }
    if (body.scope === 'TENANT' && body.book_id) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'book_id must not be set when scope is "TENANT".',
        details: [{ field: 'book_id', issue: 'inconsistent_with' }],
      });
    }
    if (body.book_id) {
      await this.requireOwnedBook(principal, body.book_id);
    }

    const id = generateId();
    const profile = await this.prisma.voiceProfile.create({
      data: {
        id,
        scope: body.scope,
        tenantId: principal.tenantId,
        bookId: body.book_id,
        name: body.name,
        description: body.description,
        intendedCharacterIds: body.intended_character_ids ?? [],
        createdByUserId: principal.sub,
      },
    });
    return this.toVoiceProfileDto(profile);
  }

  async getVoiceProfile(principal: AuthenticatedPrincipal, voiceProfileId: string) {
    const profile = await this.requireOwnedVoiceProfile(principal, voiceProfileId);
    return this.toVoiceProfileDto(profile);
  }

  async updateVoiceProfile(
    principal: AuthenticatedPrincipal,
    voiceProfileId: string,
    body: UpdateVoiceProfileBody,
  ) {
    await this.requireOwnedVoiceProfile(principal, voiceProfileId);
    const updated = await this.prisma.voiceProfile.update({
      where: { id: voiceProfileId },
      data: {
        name: body.name,
        description: body.description,
        intendedCharacterIds: body.intended_character_ids,
      },
    });
    return this.toVoiceProfileDto(updated);
  }

  async deleteVoiceProfile(
    principal: AuthenticatedPrincipal,
    voiceProfileId: string,
  ): Promise<void> {
    const profile = await this.requireOwnedVoiceProfile(principal, voiceProfileId);
    const lockedVersion = await this.prisma.voiceProfileVersion.findFirst({
      where: { voiceProfileId, lockState: 'LOCKED' },
    });
    if (lockedVersion) {
      throw new ConflictError({
        code: 'VOICE_PROFILE_IN_USE',
        message: 'This voice profile has a locked version and cannot be deleted.',
      });
    }
    await this.prisma.voiceProfile.update({
      where: { id: profile.id },
      data: { deletedAt: new Date() },
    });
  }

  // ---------------------------------------------------------------- versions ----

  async listVoiceProfileVersions(principal: AuthenticatedPrincipal, voiceProfileId: string) {
    await this.requireOwnedVoiceProfile(principal, voiceProfileId);
    const versions = await this.prisma.voiceProfileVersion.findMany({
      where: { voiceProfileId },
      orderBy: { version: 'desc' },
    });
    return versions.map((v) => this.toVoiceProfileVersionDto(v));
  }

  async createVoiceProfileVersion(
    principal: AuthenticatedPrincipal,
    voiceProfileId: string,
    body: CreateVoiceProfileVersionBody,
  ) {
    const profile = await this.requireOwnedVoiceProfile(principal, voiceProfileId);

    if (!body.reference_audio_consent.attested) {
      throw new ValidationError({
        code: 'CONSENT_ATTESTATION_REQUIRED',
        message: 'Reference audio / voice usage consent must be explicitly attested.',
      });
    }
    if (
      body.reference_audio_consent.subject === 'THIRD_PARTY_CONSENTED' &&
      !body.reference_audio_consent.attestation_text
    ) {
      throw new ValidationError({
        code: 'CONSENT_ATTESTATION_REQUIRED',
        message: 'attestation_text is required when subject is THIRD_PARTY_CONSENTED.',
      });
    }

    let baseGenerationParams = body.base_generation_params ?? {};
    let defaultPitch = body.default_pitch ?? null;
    let defaultVolume = body.default_volume ?? null;
    let defaultPacing = body.default_pacing ?? null;
    let supersedesVersionId: string | null = null;
    if (body.derive_from_version) {
      const source = await this.prisma.voiceProfileVersion.findFirst({
        where: { voiceProfileId, version: body.derive_from_version },
      });
      if (!source) {
        throw new ValidationError({
          code: 'VALIDATION_FAILED',
          message: `Version ${body.derive_from_version} does not exist for this profile.`,
          details: [{ field: 'derive_from_version', issue: 'not_found' }],
        });
      }
      baseGenerationParams =
        body.base_generation_params ?? (source.baseGenerationParams as Record<string, unknown>);
      defaultPitch = body.default_pitch ?? source.defaultPitch;
      defaultVolume = body.default_volume ?? source.defaultVolume;
      defaultPacing = body.default_pacing ?? source.defaultPacing;
      supersedesVersionId = source.id;
    }

    const baseGenerationParamsHash = stableHash(baseGenerationParams);
    const id = generateId();
    const now = new Date();
    const nextVersion = profile.versionCount + 1;
    const identityFingerprint = stableHash({
      tts_provider_id: body.tts_provider_id,
      tts_model_version_id: body.tts_model_version_id,
      language: body.language,
      base_generation_params_hash: baseGenerationParamsHash,
      reference_audio_content_hash: null,
      embedding_content_hash: null,
    });

    const version = await withTransaction(this.prisma, async (tx) => {
      const created = await tx.voiceProfileVersion.create({
        data: {
          id,
          tenantId: principal.tenantId,
          voiceProfileId,
          version: nextVersion,
          supersedesVersionId,
          ttsProviderId: body.tts_provider_id,
          ttsModelId: body.tts_model_id,
          ttsModelVersionId: body.tts_model_version_id,
          language: body.language,
          supportedLanguages: body.supported_languages ?? [body.language],
          baseGenerationParams: baseGenerationParams as Prisma.InputJsonValue,
          baseGenerationParamsHash,
          defaultPitch,
          defaultVolume,
          defaultPacing,
          approvalState: 'DRAFT',
          consentAttested: body.reference_audio_consent.attested,
          consentSubject: body.reference_audio_consent.subject,
          consentAttestationText: body.reference_audio_consent.attestation_text,
          consentAttestedByUserId: principal.sub,
          consentAttestedAt: now,
          referenceProvenance: 'LIBRARY',
          identityFingerprint,
          createdByUserId: principal.sub,
        },
      });
      await tx.voiceProfile.update({
        where: { id: voiceProfileId },
        data: { versionCount: nextVersion },
      });
      return created;
    });

    return this.toVoiceProfileVersionDto(version);
  }

  async getVoiceProfileVersion(
    principal: AuthenticatedPrincipal,
    voiceProfileId: string,
    version: number,
  ) {
    const row = await this.requireOwnedVersion(principal, voiceProfileId, version);
    return this.toVoiceProfileVersionDto(row);
  }

  async approveVoiceProfileVersion(
    principal: AuthenticatedPrincipal,
    voiceProfileId: string,
    version: number,
    body: ApproveVoiceProfileVersionBody,
  ) {
    const row = await this.requireOwnedVersion(principal, voiceProfileId, version);
    if (!body.approved) {
      if (row.approvalState !== 'PREVIEW_GENERATED') {
        throw new ConflictError({
          code: 'INVALID_STATE_TRANSITION',
          message: 'Only a PREVIEW_GENERATED version can be rejected back to DRAFT.',
        });
      }
      const updated = await this.prisma.voiceProfileVersion.update({
        where: { id: row.id },
        data: { approvalState: 'DRAFT' },
      });
      return this.toVoiceProfileVersionDto(updated);
    }
    if (row.approvalState === 'APPROVED' || row.approvalState === 'LOCKED') {
      return this.toVoiceProfileVersionDto(row); // naturally idempotent
    }
    if (row.approvalState !== 'PREVIEW_GENERATED') {
      const readyPreview = await this.prisma.voicePreview.findFirst({
        where: { voiceProfileVersionId: row.id, status: 'READY' },
      });
      if (!readyPreview) {
        throw new ConflictError({
          code: 'PREVIEW_REQUIRED_BEFORE_APPROVAL',
          message: 'At least one READY preview is required before approval.',
        });
      }
    }
    const updated = await withTransaction(this.prisma, async (tx) => {
      const row2 = await tx.voiceProfileVersion.update({
        where: { id: row.id },
        data: {
          approvalState: 'APPROVED',
          approvedByUserId: principal.sub,
          approvedAt: new Date(),
        },
      });
      const profile = await tx.voiceProfile.findUniqueOrThrow({ where: { id: voiceProfileId } });
      if (!profile.activeVersionNumber || profile.activeVersionNumber < version) {
        await tx.voiceProfile.update({
          where: { id: voiceProfileId },
          data: { activeVersionId: row.id, activeVersionNumber: version },
        });
      }
      return row2;
    });
    return this.toVoiceProfileVersionDto(updated);
  }

  async lockVoiceProfileVersion(
    principal: AuthenticatedPrincipal,
    voiceProfileId: string,
    version: number,
    body: LockVoiceProfileVersionBody,
  ) {
    const row = await this.requireOwnedVersion(principal, voiceProfileId, version);
    if (row.lockState === 'LOCKED') {
      return this.toVoiceProfileVersionDto(row);
    }
    if (!PRODUCTION_APPROVAL_STATES.includes(row.approvalState as never)) {
      throw new ConflictError({
        code: 'INVALID_STATE_TRANSITION',
        message: 'Only an APPROVED version can be locked.',
      });
    }
    const updated = await this.prisma.voiceProfileVersion.update({
      where: { id: row.id },
      data: { lockState: 'LOCKED', lockedAt: new Date(), lockedReason: body.reason },
    });
    return this.toVoiceProfileVersionDto(updated);
  }

  async retireVoiceProfileVersion(
    principal: AuthenticatedPrincipal,
    voiceProfileId: string,
    version: number,
  ) {
    const row = await this.requireOwnedVersion(principal, voiceProfileId, version);
    const activeAssignment = await this.prisma.voiceAssignment.findFirst({
      where: { voiceProfileVersionId: row.id, isActive: true },
    });
    if (activeAssignment) {
      throw new ConflictError({
        code: 'VOICE_PROFILE_IN_USE',
        message: 'This version has an active character assignment and cannot be retired.',
      });
    }
    const updated = await this.prisma.voiceProfileVersion.update({
      where: { id: row.id },
      data: { approvalState: 'RETIRED', retiredAt: new Date() },
    });
    return this.toVoiceProfileVersionDto(updated);
  }

  // ---------------------------------------------------------------- previews ----

  async createVoicePreviews(
    principal: AuthenticatedPrincipal,
    voiceProfileId: string,
    version: number,
    body: CreateVoicePreviewBody,
  ) {
    const row = await this.requireOwnedVersion(principal, voiceProfileId, version);
    // `book_id` is optional in the request schema, but every ProcessingJob
    // except `cleanup_artifacts` is book-scoped by a database CHECK
    // (`book_id IS NOT NULL OR type = 'cleanup_artifacts'`). Without it the
    // insert below fails deep in Prisma and escapes as a 500, telling the
    // caller nothing. Reject it here as the input error it is (§138/§139:
    // technical failures must surface as meaningful statuses). See F-17.
    if (!body.book_id) {
      throw new ValidationError({
        code: 'VALIDATION_FAILED',
        message: 'book_id is required to generate a voice preview.',
        details: [{ field: 'book_id', issue: 'required' }],
      });
    }
    await this.requireOwnedBook(principal, body.book_id);

    const previewIds: string[] = [];
    const jobs: {
      jobId: string;
      previewId: string;
      envelope: {
        job_id: string;
        entity_id: string;
        correlation_id: string;
        tenant_id: string;
        payload: { preview_id: string };
      };
    }[] = [];
    const priority = body.priority ?? 'INTERACTIVE';
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    await withTransaction(this.prisma, async (tx) => {
      for (const sample of body.samples) {
        const previewId = generateId();
        const jobId = generateId();
        // Built once: persisted on the row for sweeper recovery and reused by
        // the post-commit dispatch, so the two cannot drift (F-4).
        const envelope = {
          job_id: jobId,
          entity_id: previewId,
          correlation_id: jobId,
          tenant_id: principal.tenantId,
          payload: { preview_id: previewId },
        };
        await tx.voicePreview.create({
          data: {
            id: previewId,
            tenantId: principal.tenantId,
            voiceProfileId,
            voiceProfileVersionId: row.id,
            bookId: body.book_id,
            characterId: body.character_id,
            textExcerpt: sample.text_excerpt,
            emotion: sample.emotion as never,
            status: 'GENERATING',
            ttsModelVersionId: row.ttsModelVersionId,
            generationParamsHash: row.baseGenerationParamsHash,
            expiresAt,
          },
        });
        await tx.processingJob.create({
          data: {
            id: jobId,
            tenantId: principal.tenantId,
            bookId: body.book_id,
            type: 'generate_voice_preview',
            queue: 'gpu',
            priority,
            relatedResourceType: 'voice_profile_version',
            relatedResourceId: row.id,
            status: 'CREATED',
            statusChangedAt: now,
            maxAttempts: 3,
            idempotencyKey: `voice_preview:${previewId}`,
            idempotencyFingerprint: row.baseGenerationParamsHash,
            correlationId: jobId,
            createdByUserId: principal.sub,
            dispatchEnvelope: envelope,
          },
        });
        await tx.voicePreview.update({ where: { id: previewId }, data: { jobId } });
        previewIds.push(previewId);
        jobs.push({ jobId, previewId, envelope });
      }
    });

    await Promise.all(
      jobs.map(({ jobId, envelope }) =>
        enqueueProcessingJob(this.prisma, this.queueManager, {
          processingJobId: jobId,
          queue: 'gpu',
          envelope,
          jobName: 'generate_voice_preview',
          maxAttempts: 3,
        }),
      ),
    );

    this.logger.info(
      { voice_profile_version_id: row.id, preview_count: previewIds.length },
      'Enqueued generate_voice_preview commands',
    );

    return {
      scope: 'VOICE_PREVIEW',
      voice_profile_version: version,
      preview_ids: previewIds,
      planned_unit_count: previewIds.length,
    };
  }

  async listVoicePreviews(
    principal: AuthenticatedPrincipal,
    voiceProfileId: string,
    version: number,
  ) {
    const row = await this.requireOwnedVersion(principal, voiceProfileId, version);
    const previews = await this.prisma.voicePreview.findMany({
      where: { voiceProfileVersionId: row.id },
      orderBy: { createdAt: 'desc' },
    });
    return previews.map((p) => this.toVoicePreviewDto(p, version));
  }

  async getVoicePreview(
    principal: AuthenticatedPrincipal,
    voiceProfileId: string,
    version: number,
    previewId: string,
  ) {
    const row = await this.requireOwnedVersion(principal, voiceProfileId, version);
    const preview = await this.prisma.voicePreview.findFirst({
      where: { id: previewId, voiceProfileVersionId: row.id },
    });
    if (!preview) throw new NotFoundError({ message: 'Voice preview not found.' });
    return this.toVoicePreviewDto(preview, version);
  }

  // -------------------------------------------------------- character voice ----

  async getCharacterVoice(principal: AuthenticatedPrincipal, bookId: string, characterId: string) {
    await this.requireOwnedBook(principal, bookId);
    const assignment = await this.prisma.voiceAssignment.findFirst({
      where: { bookId, characterId, isActive: true },
      include: { voiceProfileVersion: true },
    });
    if (!assignment)
      throw new NotFoundError({ message: 'No active voice assignment for this character.' });
    return this.toVoiceAssignmentDto(assignment, null);
  }

  async assignCharacterVoice(
    principal: AuthenticatedPrincipal,
    bookId: string,
    characterId: string,
    body: AssignVoiceBody,
  ) {
    const book = await this.requireOwnedBook(principal, bookId);
    const character = await this.prisma.character.findFirst({ where: { id: characterId, bookId } });
    if (!character) throw new NotFoundError({ message: 'Character not found.' });
    if (character.isSentinel && character.sentinelKind !== 'NARRATOR') {
      throw new ConflictError({
        code: 'SENTINEL_CHARACTER_IMMUTABLE',
        message: 'This sentinel character cannot be assigned a voice.',
      });
    }

    const profile = await this.requireOwnedVoiceProfile(principal, body.voice_profile_id);
    const version = body.voice_profile_version
      ? await this.requireOwnedVersion(principal, profile.id, body.voice_profile_version)
      : profile.activeVersionId
        ? await this.prisma.voiceProfileVersion.findUniqueOrThrow({
            where: { id: profile.activeVersionId },
          })
        : null;
    if (!version) {
      throw new ConflictError({
        code: 'VOICE_PROFILE_NOT_APPROVED',
        message: 'This voice profile has no approved version.',
      });
    }
    if (!PRODUCTION_APPROVAL_STATES.includes(version.approvalState as never)) {
      throw new ConflictError({
        code: 'VOICE_PROFILE_NOT_APPROVED',
        message: 'The target version is not APPROVED or LOCKED.',
      });
    }
    if (
      !version.supportedLanguages.some(
        (l) => l === book.language || l.split('-')[0] === book.language.split('-')[0],
      )
    ) {
      throw new ConflictError({
        code: 'VOICE_LANGUAGE_MISMATCH',
        message: 'This voice version does not support the book language.',
      });
    }

    const role: 'NARRATOR' | 'CHARACTER' =
      character.sentinelKind === 'NARRATOR' ? 'NARRATOR' : 'CHARACTER';
    const previous = await this.prisma.voiceAssignment.findFirst({
      where: { bookId, characterId, role, isActive: true },
    });

    // Reassignment itself never mutates artifacts or enqueues work — it only reports
    // impact (api-specification.md §16.14); no regeneration is requested by this call.
    // Known scope limitation: `acknowledge_partial_revoice` is accepted by `POST
    // .../tts` (start-tts.schema.json) but this pass does not track a "pending
    // voice-change impact set" to enforce it against — the impact figure below is
    // informational only, not yet a gate on a later narrower-scope TTS request.
    const chunksBoundToPrevious = previous
      ? await this.prisma.audioScriptChunk.count({
          where: {
            bookId,
            characterId,
            isCurrent: true,
            voiceProfileVersionId: previous.voiceProfileVersionId,
          },
        })
      : 0;

    const now = new Date();
    const newId = generateId();
    await withTransaction(this.prisma, async (tx) => {
      if (previous) {
        await tx.voiceAssignment.update({
          where: { id: previous.id },
          data: { isActive: false, deactivatedAt: now, supersededByAssignmentId: newId },
        });
      }
      await tx.voiceAssignment.create({
        data: {
          id: newId,
          tenantId: principal.tenantId,
          bookId,
          characterId,
          voiceProfileId: profile.id,
          voiceProfileVersionId: version.id,
          role,
          isActive: true,
          assignedByUserId: principal.sub,
          assignedAt: now,
        },
      });
    });

    const created = await this.prisma.voiceAssignment.findUniqueOrThrow({
      where: { id: newId },
      include: { voiceProfileVersion: true },
    });
    return this.toVoiceAssignmentDto(created, {
      chunks_bound_to_previous_version: chunksBoundToPrevious,
      requires_regeneration: chunksBoundToPrevious > 0,
      estimated_regeneration_units: chunksBoundToPrevious,
    });
  }

  async clearCharacterVoice(
    principal: AuthenticatedPrincipal,
    bookId: string,
    characterId: string,
  ): Promise<void> {
    await this.requireOwnedBook(principal, bookId);
    const assignment = await this.prisma.voiceAssignment.findFirst({
      where: { bookId, characterId, isActive: true },
    });
    if (!assignment) return;
    const lockedChunks = await this.prisma.audioScriptChunk.count({
      where: {
        bookId,
        characterId,
        isCurrent: true,
        state: 'LOCKED',
        voiceProfileVersionId: assignment.voiceProfileVersionId,
      },
    });
    if (lockedChunks > 0) {
      throw new ConflictError({
        code: 'VOICE_ASSIGNMENT_IN_USE',
        message:
          'This assignment is bound to locked chunks; provide a replacement assignment instead of clearing.',
      });
    }
    await this.prisma.voiceAssignment.update({
      where: { id: assignment.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
  }

  // -------------------------------------------------------------- casting ----

  async getCastingState(principal: AuthenticatedPrincipal, bookId: string) {
    await this.requireOwnedBook(principal, bookId);
    const speakingCharacters = await this.prisma.character.findMany({
      where: { bookId, speaking: true, status: { not: 'MERGED_INTO' } },
    });
    const assignments = await this.prisma.voiceAssignment.findMany({
      where: { bookId, isActive: true, characterId: { in: speakingCharacters.map((c) => c.id) } },
      include: { voiceProfileVersion: true },
    });
    const assignmentByCharacter = new Map(assignments.map((a) => [a.characterId, a]));

    const blocking: Array<{
      character_id: string;
      display_name: string;
      line_count: number;
      reason: string;
    }> = [];
    let approvedCount = 0;
    for (const character of speakingCharacters) {
      const assignment = assignmentByCharacter.get(character.id);
      if (!assignment) {
        blocking.push({
          character_id: character.id,
          display_name: character.displayName,
          line_count: character.lineCount,
          reason: 'NO_ASSIGNMENT',
        });
        continue;
      }
      if (
        !PRODUCTION_APPROVAL_STATES.includes(assignment.voiceProfileVersion.approvalState as never)
      ) {
        blocking.push({
          character_id: character.id,
          display_name: character.displayName,
          line_count: character.lineCount,
          reason: 'ASSIGNMENT_NOT_APPROVED',
        });
        continue;
      }
      approvedCount += 1;
    }

    return {
      object: 'casting_state',
      book_id: bookId,
      ready_for_generation: blocking.length === 0,
      speaking_character_count: speakingCharacters.length,
      assigned_count: assignments.length,
      approved_count: approvedCount,
      blocking,
    };
  }

  async acceptNarratorFallback(
    principal: AuthenticatedPrincipal,
    bookId: string,
    body: NarratorFallbackBody,
  ) {
    await this.requireOwnedBook(principal, bookId);
    // Recorded as an explicit, audited user decision (api-specification.md §16.14).
    // Full audit_log integration is a follow-up; this endpoint's effect today is
    // limited to acknowledging the decision back to the caller.
    this.logger.info({ book_id: bookId, ...body }, 'Narrator fallback decision recorded');
    return this.getCastingState(principal, bookId);
  }

  // ---------------------------------------------------------------- helpers ----

  private async requireOwnedBook(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.prisma.book.findFirst({
      where: { id: bookId, tenantId: principal.tenantId },
    });
    assertTenantOwnership(book, principal, 'Book not found.');
    return book;
  }

  private async requireOwnedVoiceProfile(
    principal: AuthenticatedPrincipal,
    voiceProfileId: string,
  ) {
    const profile = await this.prisma.voiceProfile.findFirst({
      where: { id: voiceProfileId, deletedAt: null },
    });
    if (!profile || (profile.scope !== 'SYSTEM' && profile.tenantId !== principal.tenantId)) {
      throw new NotFoundError({ message: 'Voice profile not found.' });
    }
    return profile;
  }

  private async requireOwnedVersion(
    principal: AuthenticatedPrincipal,
    voiceProfileId: string,
    version: number,
  ) {
    await this.requireOwnedVoiceProfile(principal, voiceProfileId);
    const row = await this.prisma.voiceProfileVersion.findFirst({
      where: { voiceProfileId, version },
    });
    if (!row) throw new NotFoundError({ message: 'Voice profile version not found.' });
    return row;
  }

  private toVoiceProfileDto(profile: {
    id: string;
    scope: string;
    tenantId: string | null;
    bookId: string | null;
    name: string;
    description: string | null;
    activeVersionNumber: number | null;
    lockState: string;
    versionCount: number;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: profile.id,
      object: 'voice_profile' as const,
      tenant_id: profile.tenantId,
      scope: profile.scope,
      book_id: profile.bookId,
      name: profile.name,
      description: profile.description,
      active_version: profile.activeVersionNumber,
      lock_state: profile.lockState,
      version_count: profile.versionCount,
      created_at: profile.createdAt.toISOString(),
      updated_at: profile.updatedAt.toISOString(),
    };
  }

  private toVoiceProfileVersionDto(v: {
    id: string;
    voiceProfileId: string;
    version: number;
    supersedesVersionId: string | null;
    approvalState: string;
    lockState: string;
    lockedAt: Date | null;
    lockedReason: string | null;
    ttsProviderId: string;
    ttsModelVersionId: string;
    language: string;
    supportedLanguages: string[];
    baseGenerationParams: unknown;
    baseGenerationParamsHash: string;
    emotionCapabilityMap: unknown;
    consentAttested: boolean;
    consentSubject: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: v.id,
      object: 'voice_profile_version' as const,
      voice_profile_id: v.voiceProfileId,
      version: v.version,
      supersedes_version_id: v.supersedesVersionId,
      approval_state: v.approvalState,
      lock_state: v.lockState,
      locked_at: v.lockedAt?.toISOString() ?? null,
      locked_reason: v.lockedReason,
      tts_provider_id: v.ttsProviderId,
      tts_model_version_id: v.ttsModelVersionId,
      language: v.language,
      supported_languages: v.supportedLanguages,
      base_generation_params: v.baseGenerationParams,
      base_generation_params_hash: v.baseGenerationParamsHash,
      emotion_capability_map: v.emotionCapabilityMap,
      consent: { attested: v.consentAttested, subject: v.consentSubject },
      created_at: v.createdAt.toISOString(),
      updated_at: v.updatedAt.toISOString(),
    };
  }

  private toVoicePreviewDto(
    p: {
      id: string;
      voiceProfileId: string;
      bookId: string | null;
      characterId: string | null;
      textExcerpt: string;
      emotion: string;
      status: string;
      durationMs: number | null;
      sampleRate: number | null;
      capabilityGap: unknown;
      jobId: string | null;
      errorCode: string | null;
      createdAt: Date;
    },
    version: number,
  ) {
    return {
      id: p.id,
      object: 'voice_preview' as const,
      voice_profile_id: p.voiceProfileId,
      voice_profile_version: version,
      status: p.status,
      book_id: p.bookId,
      character_id: p.characterId,
      text_excerpt: p.textExcerpt,
      emotion: p.emotion,
      capability_gap: p.capabilityGap,
      duration_ms: p.durationMs,
      sample_rate: p.sampleRate,
      job_id: p.jobId,
      error: p.errorCode ? { code: p.errorCode } : null,
      created_at: p.createdAt.toISOString(),
    };
  }

  private toVoiceAssignmentDto(
    assignment: {
      bookId: string;
      characterId: string;
      voiceProfileId: string;
      voiceProfileVersion: { version: number; approvalState: string };
      assignedAt: Date;
    },
    impact: {
      chunks_bound_to_previous_version: number;
      requires_regeneration: boolean;
      estimated_regeneration_units: number;
    } | null,
  ) {
    return {
      object: 'voice_assignment' as const,
      book_id: assignment.bookId,
      character_id: assignment.characterId,
      voice_profile_id: assignment.voiceProfileId,
      voice_profile_version: assignment.voiceProfileVersion.version,
      approval_state: assignment.voiceProfileVersion.approvalState,
      assigned_at: assignment.assignedAt.toISOString(),
      ...(impact ? { impact } : {}),
    };
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
