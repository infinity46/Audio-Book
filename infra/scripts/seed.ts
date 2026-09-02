#!/usr/bin/env tsx
/**
 * Minimal development seed: one tenant, one user. No audiobook content —
 * per task instructions, seed data should not fabricate books/audio, and
 * must never contain production secrets. Safe to run repeatedly (upsert).
 */
import { createHash } from 'node:crypto';
import { createPrismaClient, disconnectPrisma, type PrismaClient } from '@audio-book/database';
import { generateId } from '@audio-book/events';

const DEV_TENANT_ID = '018f4e1a-dead-7000-8000-000000000001';
const DEV_USER_EMAIL = 'dev@audiobook.local';

/**
 * Phase 2's ingestion worker resolves ModelVersion rows by exact
 * (role, providerId, modelId, version) before it will persist a
 * BookVersion (apps/worker-cpu/src/processors/ingestion.ts's
 * `resolveModelVersionId` — deliberately throws rather than silently
 * ingesting with no provenance, task §128 "no silent fallback"). These
 * identities are the ones the PDF parser, EPUB parser, normalizer, and
 * (when OCR_LANGUAGE=eng, the default — see packages/config's
 * ocrEnvSchema) Tesseract OCR provider report; they must exist before any
 * book can be ingested. Deploying with a different OCR_LANGUAGE requires
 * adding a matching entry here (modelId is `tesseract-{language}`) —
 * deliberately not auto-created, so a misconfigured language fails fast
 * with a clear error rather than silently skipping provenance.
 */
const INGESTION_MODEL_VERSIONS = [
  {
    role: 'PARSER' as const,
    providerId: 'pdfjs-dist',
    modelId: 'pdf-text-extractor',
    version: '4.9.155',
  },
  {
    role: 'PARSER' as const,
    providerId: 'audio-book-epub-reader',
    modelId: 'epub-spine-reader',
    version: '1.0.0',
  },
  {
    role: 'NORMALIZER' as const,
    providerId: 'audio-book-normalizer',
    modelId: 'text-normalizer',
    version: 'normalize.v2',
  },
  {
    role: 'OCR' as const,
    providerId: 'tesseract.js',
    modelId: 'tesseract-eng',
    version: '5.1.1',
  },
];

/**
 * Phase 3's `analyze_scene`/`build_story_bible_delta` handlers (worker-ai,
 * python/worker-ai/src/worker_ai/repo/model_registry.py) resolve their
 * `ModelVersion` by the same (role, providerId, modelId, version) lookup
 * ingestion uses — and refuse to persist any semantic row without one, for
 * the same "no silent fallback / no provenance-less write" reason. This is
 * the default deterministic (non-LLM, heuristic) analyzer's identity; a
 * deployment configured with SEMANTIC_ANALYZER_PROVIDER=openai_compatible
 * must add its own ModelRegistry/ModelVersion row for the real model it
 * points at — deliberately not auto-created, so an unregistered model
 * fails fast rather than silently writing unattributed facts.
 */
const SEMANTIC_ANALYSIS_MODEL_VERSIONS = [
  {
    role: 'LLM' as const,
    providerId: 'audio-book-nlp',
    modelId: 'deterministic-heuristic-analyzer',
    version: '1.0.0',
  },
];

/**
 * Phase 4's `generate_director_ir`/`revise_director_ir` handlers
 * (python/worker-ai/src/worker_ai/repo/model_registry.py) resolve their
 * `ModelVersion` the same way -- this is the default deterministic
 * (non-LLM, heuristic) `DirectorModelProvider`'s identity. A deployment
 * configured with DIRECTOR_MODEL_PROVIDER=openai_compatible must add its
 * own ModelRegistry/ModelVersion row for the real model it points at, for
 * the same "no silent fallback / no provenance-less write" reason.
 */
const DIRECTOR_MODEL_VERSIONS = [
  {
    role: 'LLM' as const,
    providerId: 'audio-book-director',
    modelId: 'deterministic-heuristic-director',
    version: '1.0.0',
  },
];

/**
 * Phase 5's `generate_tts_chunk`/`generate_voice_preview` handlers
 * (python/worker-gpu/src/worker_gpu/repo/model_registry.py) resolve their
 * `ModelVersion` the same way, keyed by the identity `MockTTSProvider`
 * reports (`worker_gpu.tts.providers.mock.MockTTSProvider.model_identity`) —
 * this is `TTS_PROVIDER=mock`'s (the default) registered identity. A
 * deployment configured with TTS_PROVIDER=kokoro must add its own
 * ModelRegistry/ModelVersion row for the real model it points at, for the
 * same "no silent fallback / no provenance-less write" reason.
 */
const TTS_MODEL_VERSIONS = [
  {
    role: 'TTS' as const,
    providerId: 'mock-tts',
    modelId: 'mock-tone',
    version: 'v1',
  },
];

/**
 * Phase 6's `assemble_chapter`/`assemble_audiobook`/`encode_delivery_format`
 * handlers (apps/worker-cpu/src/processors/assembly.ts) resolve their
 * `audioToolModelVersionId` the same (role, providerId, modelId, version)
 * way, keyed by whatever `ffmpeg -version` the worker actually discovers at
 * startup from `infra/docker/worker-cpu.Dockerfile`'s runtime image (never
 * assumed). `6.1.1` is this codebase's best-effort record of what
 * `node:20.18.1-alpine3.20`'s `apk add ffmpeg` resolves to at the time this
 * was written — confirm with `docker compose run worker-cpu ffmpeg
 * -version` and correct this entry if Alpine's repo has moved on, for the
 * same "no silent fallback / no provenance-less write" reason every other
 * ModelVersion lookup in this file enforces (a mismatch fails every
 * assembly job loudly with `DependencyFailureError` rather than silently
 * mis-attributing provenance).
 */
const AUDIO_TOOL_MODEL_VERSIONS = [
  {
    role: 'AUDIO_TOOL' as const,
    providerId: 'ffmpeg',
    modelId: 'ffmpeg',
    version: '6.1.1',
  },
];

interface ModelVersionSeed {
  role: 'PARSER' | 'NORMALIZER' | 'OCR' | 'LLM' | 'TTS' | 'AUDIO_TOOL';
  providerId: string;
  modelId: string;
  version: string;
}

async function seedModelVersions(prisma: PrismaClient, entries: ModelVersionSeed[]): Promise<void> {
  for (const entry of entries) {
    const registry = await prisma.modelRegistry.upsert({
      where: {
        role_providerId_modelId: {
          role: entry.role,
          providerId: entry.providerId,
          modelId: entry.modelId,
        },
      },
      update: {},
      create: {
        id: generateId(),
        role: entry.role,
        providerId: entry.providerId,
        modelId: entry.modelId,
        displayName: `${entry.providerId}/${entry.modelId}`,
        status: 'ACTIVE',
      },
    });

    const existingVersion = await prisma.modelVersion.findFirst({
      where: { modelRegistryId: registry.id, version: entry.version },
    });
    if (!existingVersion) {
      await prisma.modelVersion.create({
        data: {
          id: generateId(),
          modelRegistryId: registry.id,
          version: entry.version,
          paramsFingerprint: createHash('sha256')
            .update(`${entry.providerId}:${entry.modelId}:${entry.version}`)
            .digest('hex'),
          releasedAt: new Date(),
        },
      });
    }
  }
}

async function resolveModelVersionId(
  prisma: PrismaClient,
  entry: ModelVersionSeed,
): Promise<string> {
  const registry = await prisma.modelRegistry.findUniqueOrThrow({
    where: {
      role_providerId_modelId: {
        role: entry.role,
        providerId: entry.providerId,
        modelId: entry.modelId,
      },
    },
  });
  const version = await prisma.modelVersion.findFirstOrThrow({
    where: { modelRegistryId: registry.id, version: entry.version },
  });
  return version.id;
}

const DEV_VOICE_PROFILE_ID = '018f4e1a-dead-7000-8000-000000000af1';
const DEV_VOICE_PROFILE_VERSION_ID = '018f4e1a-dead-7000-8000-000000000af2';

/**
 * A single TENANT-scoped, already-`APPROVED` voice profile bound to
 * `MockTTSProvider` — so a book in the dev tenant can be cast and rendered
 * end-to-end (`PUT .../characters/{id}/voice` -> `POST .../tts`) without
 * first walking the full preview/approval workflow. TENANT scope (not
 * SYSTEM) is deliberate: it is directly assignable to any book in this
 * tenant, and it sidesteps the SYSTEM-profile "tenant snapshot on binding"
 * mechanic (`api-specification.md` §16.14) that this codebase does not yet
 * implement (see `voice.service.ts`'s docstring for that scope note).
 */
async function seedDefaultVoiceProfile(
  prisma: PrismaClient,
  tenantId: string,
  userId: string,
): Promise<void> {
  const ttsModelVersionId = await resolveModelVersionId(prisma, TTS_MODEL_VERSIONS[0]!);
  const baseGenerationParams = {};
  const baseGenerationParamsHash = createHash('sha256')
    .update(JSON.stringify(baseGenerationParams))
    .digest('hex');
  const identityFingerprint = createHash('sha256')
    .update(['mock-tts', ttsModelVersionId, 'en-US', baseGenerationParamsHash, '', ''].join(':'))
    .digest('hex');
  const now = new Date();

  // Created without `activeVersionId` first: `VoiceProfileVersion` does not exist yet,
  // and the column has a real FK to it (`voice_profile_active_version_id_fkey`) — it is
  // set in a follow-up update once the version row below actually exists.
  await prisma.voiceProfile.upsert({
    where: { id: DEV_VOICE_PROFILE_ID },
    update: {},
    create: {
      id: DEV_VOICE_PROFILE_ID,
      scope: 'TENANT',
      tenantId,
      name: 'Default Narrator (Mock)',
      description: 'Seeded MockTTSProvider narrator voice for local development.',
      versionCount: 1,
      lockState: 'UNLOCKED',
      intendedCharacterIds: [],
      createdByUserId: userId,
    },
  });

  await prisma.voiceProfileVersion.upsert({
    where: { id: DEV_VOICE_PROFILE_VERSION_ID },
    update: {},
    create: {
      id: DEV_VOICE_PROFILE_VERSION_ID,
      tenantId,
      voiceProfileId: DEV_VOICE_PROFILE_ID,
      version: 1,
      ttsProviderId: 'mock-tts',
      ttsModelId: 'mock-tone',
      ttsModelVersionId,
      language: 'en-US',
      supportedLanguages: ['en-US'],
      baseGenerationParams,
      baseGenerationParamsHash,
      approvalState: 'APPROVED',
      approvedByUserId: userId,
      approvedAt: now,
      lockState: 'UNLOCKED',
      consentAttested: true,
      consentSubject: 'SYNTHETIC',
      consentAttestedByUserId: userId,
      consentAttestedAt: now,
      referenceProvenance: 'LIBRARY',
      identityFingerprint,
      createdByUserId: userId,
    },
  });

  await prisma.voiceProfile.update({
    where: { id: DEV_VOICE_PROFILE_ID },
    data: { activeVersionId: DEV_VOICE_PROFILE_VERSION_ID, activeVersionNumber: 1 },
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run the seed script.');
  }

  const prisma = createPrismaClient({ databaseUrl });

  const tenant = await prisma.tenant.upsert({
    where: { id: DEV_TENANT_ID },
    update: {},
    create: {
      id: DEV_TENANT_ID,
      name: 'Development Tenant',
      status: 'ACTIVE',
      planCode: 'dev',
    },
  });

  const existingUser = await prisma.user.findUnique({ where: { email: DEV_USER_EMAIL } });
  const user =
    existingUser ??
    (await prisma.user.create({
      data: {
        id: generateId(),
        tenantId: tenant.id,
        email: DEV_USER_EMAIL,
        displayName: 'Dev User',
        status: 'ACTIVE',
        roles: ['TENANT_OWNER'],
        preferences: {},
      },
    }));

  await prisma.tenantQuota.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: {
      tenantId: tenant.id,
      concurrentBooksLimit: 5,
      gpuMinutesMonthlyLimit: 600,
      storageBytesLimit: BigInt(50) * BigInt(1024 * 1024 * 1024),
      booksTotalLimit: 100,
    },
  });

  await seedModelVersions(prisma, INGESTION_MODEL_VERSIONS);
  await seedModelVersions(prisma, SEMANTIC_ANALYSIS_MODEL_VERSIONS);
  await seedModelVersions(prisma, DIRECTOR_MODEL_VERSIONS);
  await seedModelVersions(prisma, TTS_MODEL_VERSIONS);
  await seedModelVersions(prisma, AUDIO_TOOL_MODEL_VERSIONS);
  await seedDefaultVoiceProfile(prisma, tenant.id, user.id);

  console.log(`Seeded development tenant ${tenant.id} and user ${user.id} (${user.email})`);
  await disconnectPrisma(prisma);
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
