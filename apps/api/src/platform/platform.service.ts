import { Inject, Injectable } from '@nestjs/common';
import type { ApiConfig } from '@audio-book/config';
import type { Prisma, PrismaClient } from '@audio-book/database';
import { NotFoundError, ValidationError } from '@audio-book/errors';
import { defaultIngestionConfig } from '@audio-book/ingestion';
import { API_CONFIG, PRISMA } from '../common/tokens.js';
import {
  decodeCursor,
  encodeCursor,
  parseLimit,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
} from '../common/pagination.js';

/**
 * Platform metadata (`api-specification.md` §16.21) — so a client discovers
 * limits and vocabularies instead of hard-coding them.
 *
 * **This is a projection, not a passthrough.** §16.21 is explicit about what
 * must never appear here: worker counts, hostnames, VRAM, queue depths, GPU
 * models, or weights locations. Everything below is derived from configuration
 * this process already holds, from closed vocabularies the database enums
 * define, or from the `model_registry`/`model_version` tables — never from a
 * worker or a queue.
 */

const MODEL_ROLES = ['PARSER', 'OCR', 'NORMALIZER', 'LLM', 'TTS', 'ASR', 'AUDIO_TOOL'] as const;

/**
 * The closed vocabularies §16.21 serves so a UI can render pickers.
 *
 * Duplicated from the Prisma enums rather than imported: `@prisma/client`
 * exports enum objects, but reading them at runtime couples this response to
 * a generated artifact whose shape changes with the client version. These are
 * closed vocabularies (§7.6 — "not extensible within v1"), so a literal list
 * is stable by contract, and `platform.service.test.ts` asserts it against the
 * generated enum so drift is a test failure rather than a silent divergence.
 */
export const EMOTION_VOCABULARY = [
  'NEUTRAL',
  'HAPPY',
  'SAD',
  'GRIEF',
  'ANGRY',
  'FEARFUL',
  'SURPRISED',
  'DISGUSTED',
  'EXCITED',
  'CALM',
  'TENSE',
  'ANXIOUS',
  'SOMBER',
  'CONFIDENT',
  'UNCERTAIN',
  'PLAYFUL',
  'SERIOUS',
] as const;

export const DELIVERY_MODE_VOCABULARY = [
  'NORMAL',
  'INTERNAL_THOUGHT',
  'WHISPER',
  'SHOUT',
  'LAUGHING',
  'CRYING',
  'SINGING',
  'READING_ALOUD',
] as const;

export const DELIVERY_FORMATS = ['M4B', 'M4A', 'MP3_PER_CHAPTER'] as const;

/** Mirrors `books.service.ts`'s upload admission — the two must agree or a client is told the wrong thing. */
export const ACCEPTED_UPLOAD_MIME_TYPES = ['application/pdf', 'application/epub+zip'] as const;

/** `api-specification.md` §16.20 — the ceiling on `expires_in_seconds`. */
export const SIGNED_URL_MAX_EXPIRY_SECONDS = 900;

@Injectable()
export class PlatformService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async getCapabilities() {
    const ingestion = defaultIngestionConfig();

    // TTS capability declarations live with the engine adapters
    // (`worker_gpu/tts/capability.py`) and reach the platform through worker
    // registration — a subsystem that is specified but unbuilt (QA finding
    // F-26: `worker` has no writer in either runtime). Rather than fabricate
    // an availability flag, this reports the registry's TTS models with
    // `available: null` and marks the whole response degraded, which is
    // exactly the mechanism §7.7 provides for "succeeded but incomplete".
    const [ttsModels, workerCount, directorModels] = await Promise.all([
      this.prisma.modelVersion.findMany({
        where: { modelRegistry: { role: 'TTS', status: 'ACTIVE' }, deprecatedAt: null },
        include: { modelRegistry: true },
        orderBy: { releasedAt: 'desc' },
        take: 50,
      }),
      this.prisma.worker.count({ where: { status: 'READY' } }),
      this.prisma.modelVersion.findMany({
        where: { modelRegistry: { role: 'LLM', status: 'ACTIVE' }, deprecatedAt: null },
        include: { modelRegistry: true },
        orderBy: { releasedAt: 'desc' },
        take: 20,
      }),
    ]);

    const availabilityKnown = workerCount > 0;

    return {
      object: 'capabilities' as const,
      api_version: 'v1',
      degraded: !availabilityKnown,
      degraded_reasons: availabilityKnown ? [] : ['WORKER_CAPABILITY_REGISTRY_UNAVAILABLE'],
      limits: {
        max_page_limit: MAX_PAGE_LIMIT,
        default_page_limit: DEFAULT_PAGE_LIMIT,
        max_request_body_bytes: this.config.http.bodySizeLimitBytes,
        max_upload_bytes: {
          PDF: ingestion.maxFileSizeBytes,
          EPUB: ingestion.maxFileSizeBytes,
        },
        signed_url_max_expiry_seconds: SIGNED_URL_MAX_EXPIRY_SECONDS,
        max_batch_ids: 500,
        max_pages_per_book: ingestion.maxPages,
      },
      upload: {
        accepted_mime_types: [...ACCEPTED_UPLOAD_MIME_TYPES],
        // No multipart upload path exists: `POST .../upload-sessions` mints a
        // single PUT target. Reporting a threshold would advertise a protocol
        // this API does not implement.
        multipart_threshold_bytes: null,
      },
      tts_providers: ttsModels.map((model) => ({
        tts_provider_id: model.modelRegistry.providerId,
        model_id: model.modelRegistry.modelId,
        model_version_id: model.id,
        version: model.version,
        // `config` is the model's own recorded declaration where one was
        // registered. It is forwarded verbatim rather than defaulted, so an
        // unregistered capability reads as absent instead of as false.
        capabilities: model.config ?? null,
        available: availabilityKnown ? true : null,
      })),
      director_versions: directorModels.map((model) => ({
        director_version: model.version,
        model_id: model.modelRegistry.modelId,
        current: false,
      })),
      delivery_formats: [...DELIVERY_FORMATS],
      vocabularies: {
        emotion: [...EMOTION_VOCABULARY],
        delivery_mode: [...DELIVERY_MODE_VOCABULARY],
      },
      links: { self: '/api/v1/capabilities', model_versions: '/api/v1/model-versions' },
    };
  }

  async listModelVersions(query: {
    role?: string;
    provider_id?: string;
    cursor?: string;
    limit?: string;
    include_deprecated?: string;
  }) {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    const where: Prisma.ModelVersionWhereInput = {};
    const registryFilter: Prisma.ModelRegistryWhereInput = {};
    if (query.role) {
      if (!(MODEL_ROLES as readonly string[]).includes(query.role)) {
        throw new ValidationError({
          message: `role must be one of ${MODEL_ROLES.join(', ')}.`,
          details: [{ field: 'role', issue: 'invalid_enum' }],
        });
      }
      registryFilter.role = query.role as never;
    }
    // Exact match, not `contains`: a substring search over `provider_id` is an
    // unindexed scan (§55/§56 — only indexed, safe fields are filterable).
    if (query.provider_id) registryFilter.providerId = query.provider_id;
    if (Object.keys(registryFilter).length > 0) where.modelRegistry = registryFilter;
    // The public listing hides deprecated entries; the full registry including
    // deprecated and quarantined rows is the administrative view (§16.22).
    if (query.include_deprecated !== 'true') where.deprecatedAt = null;

    if (cursor) {
      where.OR = [
        { releasedAt: { lt: new Date(String(cursor.v)) } },
        { AND: [{ releasedAt: new Date(String(cursor.v)) }, { id: { lt: cursor.id } }] },
      ];
    }

    const rows = await this.prisma.modelVersion.findMany({
      where,
      include: { modelRegistry: true },
      orderBy: [{ releasedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map(toModelVersionDto),
      page: {
        limit,
        has_more: hasMore,
        next_cursor: hasMore && last ? encodeCursor(last.releasedAt.toISOString(), last.id) : null,
        prev_cursor: null,
        total: null,
      },
    };
  }

  async getModelVersion(modelVersionId: string) {
    const row = await this.prisma.modelVersion.findUnique({
      where: { id: modelVersionId },
      include: { modelRegistry: true },
    });
    if (!row) {
      throw new NotFoundError({
        code: 'MODEL_VERSION_NOT_FOUND',
        message: 'Model version not found.',
      });
    }
    return toModelVersionDto(row);
  }
}

interface ModelVersionRow {
  id: string;
  version: string;
  paramsFingerprint: string;
  releasedAt: Date;
  deprecatedAt: Date | null;
  quarantinedAt: Date | null;
  createdAt: Date;
  modelRegistry: { role: string; providerId: string; modelId: string; displayName: string };
}

/**
 * §16.21's contractual field set. `weights_storage_key`, `weights_content_hash`
 * and `config` are omitted: the first two name an object-storage location
 * (§14.9, §3 rule 3) and the third can carry engine-internal parameters. The
 * `params_fingerprint` is the reproducibility handle a client legitimately
 * needs, and it discloses nothing about where the weights live.
 */
function toModelVersionDto(row: ModelVersionRow) {
  return {
    id: row.id,
    object: 'model_version' as const,
    role: row.modelRegistry.role,
    provider_id: row.modelRegistry.providerId,
    model_id: row.modelRegistry.modelId,
    display_name: row.modelRegistry.displayName,
    version: row.version,
    params_fingerprint: row.paramsFingerprint,
    released_at: row.releasedAt.toISOString(),
    deprecated_at: row.deprecatedAt?.toISOString() ?? null,
    quarantined: row.quarantinedAt !== null,
    created_at: row.createdAt.toISOString(),
    // ModelVersion is immutable (`context.md` §4.5) — §7.1's rule for
    // immutable resources.
    updated_at: row.createdAt.toISOString(),
    links: { self: `/api/v1/model-versions/${row.id}` },
  };
}

export { toModelVersionDto };
