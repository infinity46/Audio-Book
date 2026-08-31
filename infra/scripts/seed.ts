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
    version: 'normalize.v1',
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

interface ModelVersionSeed {
  role: 'PARSER' | 'NORMALIZER' | 'OCR' | 'LLM';
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

  console.log(`Seeded development tenant ${tenant.id} and user ${user.id} (${user.email})`);
  await disconnectPrisma(prisma);
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
