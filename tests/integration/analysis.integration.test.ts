import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, disconnectPrisma, type PrismaClient } from '@audio-book/database';
import { generateId } from '@audio-book/events';
import { QueueManager } from '@audio-book/queue';
import { AnalysisService } from '@audio-book/api/analysis/analysis.service';

/**
 * Exercises AnalysisService's core Phase 3 flows against the REAL Postgres +
 * Redis (see docker-compose.yml). Complements the mocked-Prisma unit test
 * (analysis.service.test.ts) by catching anything a fake Prisma double
 * cannot: real constraint enforcement, real cursor-pagination SQL, and a
 * real BullMQ enqueue onto the `ai` queue.
 */
describe('AnalysisService (real Postgres + Redis)', () => {
  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://audiobook:audiobook_dev_password@localhost:5432/audiobook';
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

  let prisma: PrismaClient;
  let queueManager: QueueManager;
  let service: AnalysisService;
  let tenantId: string;
  let userId: string;
  const principal = () => ({ sub: userId, tenantId, roles: [], scopes: [] }) as never;

  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl });
    queueManager = new QueueManager({ redisUrl, backoff: { baseMs: 10, ceilingMs: 100 } });
    service = new AnalysisService(prisma, queueManager, logger);

    tenantId = generateId();
    userId = generateId();
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Analysis Integration Test Tenant',
        status: 'ACTIVE',
        planCode: 'test',
      },
    });
    await prisma.user.create({
      data: {
        id: userId,
        tenantId,
        email: `analysis-test-${tenantId}@example.invalid`,
        displayName: 'Test User',
        status: 'ACTIVE',
        roles: ['TENANT_OWNER'],
        preferences: {},
      },
    });
  });

  afterAll(async () => {
    await queueManager?.close();
    try {
      await prisma.$executeRaw`DELETE FROM scene_participant WHERE character_id IN (SELECT id FROM character WHERE tenant_id = ${tenantId}::uuid)`;
      await prisma.$executeRaw`DELETE FROM narrative_state WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM narrative_location WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM narrative_object WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM narrative_faction WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM narrative_thread WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM narrative_timeline_event WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM narrative_summary WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM narrative_embedding WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM scene_semantics WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM character_relationship WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM character_merge WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM character_alias WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM character WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM story_bible_version WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM story_bible WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM pronunciation_entry WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM scene WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM outbox_message WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM processing_job WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM paragraph WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM section WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM chapter WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM parsed_page WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM book_version WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM book_file WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM book WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM idempotency_key WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM "user" WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM tenant WHERE id = ${tenantId}::uuid`;
    } catch (err) {
      console.warn('analysis.integration.test.ts cleanup failed (non-fatal):', err);
    }
    await disconnectPrisma(prisma);
  });

  async function createAnalyzableBook(): Promise<{
    bookId: string;
    bookVersionId: string;
    chapterIds: string[];
  }> {
    const bookId = generateId();
    const bookFileId = generateId();
    const bookVersionId = generateId();
    const now = new Date();

    await prisma.book.create({
      data: {
        id: bookId,
        tenantId,
        title: 'Integration Test Book',
        language: 'en',
        status: 'STRUCTURED',
        statusChangedAt: now,
        pipelineVersion: 'test-pipeline-v1',
        createdByUserId: userId,
      },
    });
    await prisma.bookFile.create({
      data: {
        id: bookFileId,
        tenantId,
        bookId,
        sourceKind: 'PDF',
        originalFileName: 'book.pdf',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(1024),
        contentHash: bookId.replace(/-/g, '').padEnd(64, '0'),
        contentHashAlgorithm: 'SHA256',
        status: 'ADMITTED',
        storageKey: `tenant/${tenantId}/book.pdf`,
        storageBucket: 'test-bucket',
      },
    });
    await prisma.bookVersion.create({
      data: {
        id: bookVersionId,
        tenantId,
        bookId,
        bookFileId,
        version: 1,
        structureVersionLabel: 'structure.v1',
        isCurrent: true,
        contentHash: 'b'.repeat(64),
        rawTextContentHash: 'c'.repeat(64),
        pipelineVersion: 'test-pipeline-v1',
        storageBucket: 'test-bucket',
        status: 'READY',
      },
    });

    const chapterIds = [generateId(), generateId()];
    await prisma.chapter.createMany({
      data: chapterIds.map((id, i) => ({
        id,
        tenantId,
        bookId,
        bookVersionId,
        orderIndex: i,
        spineStart: i * 10,
        spineEnd: i * 10 + 9,
        matterType: 'BODY' as const,
        charCount: 100,
      })),
    });

    await prisma.book.update({
      where: { id: bookId },
      data: { currentBookVersionId: bookVersionId },
    });

    return { bookId, bookVersionId, chapterIds };
  }

  it('rejects starting analysis before ingestion has completed', async () => {
    const bookId = generateId();
    await prisma.book.create({
      data: {
        id: bookId,
        tenantId,
        title: 'Unready Book',
        language: 'en',
        status: 'UPLOADED',
        statusChangedAt: new Date(),
        pipelineVersion: 'test-pipeline-v1',
        createdByUserId: userId,
      },
    });

    await expect(
      service.startAnalysis(principal(), bookId, { scope: 'BOOK', mode: 'INCREMENTAL' }),
    ).rejects.toMatchObject({ code: 'INGESTION_NOT_COMPLETE' });
  });

  it('starts analysis: creates the first analyze_scene ProcessingJob and enqueues it on the ai queue', async () => {
    const { bookId, bookVersionId, chapterIds } = await createAnalyzableBook();

    const result = await service.startAnalysis(principal(), bookId, {
      scope: 'BOOK',
      mode: 'INCREMENTAL',
    });

    expect(result.job.type).toBe('analyze_scene');
    expect(result.accepted.chapter_ids).toEqual(chapterIds);

    const job = await prisma.processingJob.findUnique({ where: { id: result.job.id } });
    expect(job).toMatchObject({
      type: 'analyze_scene',
      queue: 'ai',
      status: 'CREATED',
      relatedResourceType: 'book_version',
      relatedResourceId: bookVersionId,
    });

    const bookAfter = await prisma.book.findUnique({ where: { id: bookId } });
    expect(bookAfter?.status).toBe('ANALYZING');

    // Confirm it actually landed on the real `ai` BullMQ queue.
    const bullJob = await queueManager.queue('ai').getJob(result.job.id);
    expect(bullJob).not.toBeNull();
    const enqueuedPayload = bullJob?.data as { payload?: { chapter_id?: string } } | undefined;
    expect(enqueuedPayload?.payload?.chapter_id).toBe(chapterIds[0]);
  });

  it('rejects a second analysis start while one is already running for the book', async () => {
    const { bookId } = await createAnalyzableBook();
    await service.startAnalysis(principal(), bookId, { scope: 'BOOK', mode: 'INCREMENTAL' });

    await expect(
      service.startAnalysis(principal(), bookId, { scope: 'BOOK', mode: 'INCREMENTAL' }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_ALREADY_RUNNING' });
  });

  it('character lifecycle: create, list, update, alias conflict, and merge', async () => {
    const { bookId } = await createAnalyzableBook();

    const alice = await prisma.character.create({
      data: {
        id: generateId(),
        tenantId,
        bookId,
        displayName: 'Alice Carter',
        status: 'PROVISIONAL',
      },
    });
    const bob = await prisma.character.create({
      data: {
        id: generateId(),
        tenantId,
        bookId,
        displayName: 'Bob Harrison',
        status: 'PROVISIONAL',
      },
    });

    const listed = await service.listCharacters(principal(), bookId, {});
    expect(listed.data.map((c) => c.id).sort()).toEqual([alice.id, bob.id].sort());

    const updated = await service.updateCharacter(principal(), bookId, alice.id, {
      status: 'CONFIRMED',
      display_name: 'Alice M. Carter',
    });
    expect(updated.status).toBe('CONFIRMED');
    expect(updated.display_name).toBe('Alice M. Carter');

    const alias = await service.createCharacterAlias(principal(), bookId, alice.id, {
      surface_form: 'Al',
      alias_type: 'NICKNAME',
    });
    expect(alias.surface_form).toBe('Al');

    await expect(
      service.createCharacterAlias(principal(), bookId, bob.id, {
        surface_form: 'Al',
        alias_type: 'NICKNAME',
      }),
    ).rejects.toMatchObject({ code: 'ALIAS_CONFLICT' });

    const merge = await service.createCharacterMerge(principal(), bookId, {
      operation: 'MERGE',
      losing_character_id: bob.id,
      winning_character_id: alice.id,
    });
    expect(merge.operation).toBe('MERGE');

    const bobAfter = await prisma.character.findUnique({ where: { id: bob.id } });
    expect(bobAfter?.status).toBe('MERGED_INTO');
    expect(bobAfter?.mergedIntoCharacterId).toBe(alice.id);
  });

  it('story bible retrieval reflects NOT_BUILT before any analysis has run', async () => {
    const { bookId } = await createAnalyzableBook();
    const bible = await service.getStoryBible(principal(), bookId, {});
    expect(bible.status).toBe('NOT_BUILT');
  });

  it('pronunciation entries: create, conflict, update, delete', async () => {
    const { bookId } = await createAnalyzableBook();

    const entry = await service.createPronunciation(principal(), bookId, {
      surface_form: 'Aurelio',
      ipa: 'aʊˈɾeljo',
      applies_to: 'GLOBAL',
    });
    expect(entry.surface_form).toBe('Aurelio');

    await expect(
      service.createPronunciation(principal(), bookId, {
        surface_form: 'Aurelio',
        ipa: 'different',
        applies_to: 'GLOBAL',
      }),
    ).rejects.toMatchObject({ code: 'PRONUNCIATION_ENTRY_CONFLICT' });

    const updated = await service.updatePronunciation(principal(), bookId, entry.id, {
      notes: 'confirmed by author',
    });
    expect(updated.notes).toBe('confirmed by author');

    await service.deletePronunciation(principal(), bookId, entry.id);
    const afterDelete = await service.listPronunciations(principal(), bookId, {});
    expect(afterDelete.data).toHaveLength(0);
  });

  it('director context: assembles a bounded L1-L6 bundle for a paragraph', async () => {
    const { bookId, bookVersionId, chapterIds } = await createAnalyzableBook();
    const paragraphId = generateId();
    await prisma.paragraph.create({
      data: {
        id: paragraphId,
        tenantId,
        bookId,
        bookVersionId,
        chapterId: chapterIds[0]!,
        orderIndex: 0,
        spinePosition: 0,
        text: 'Alice walked into the room.',
        contentHash: 'e'.repeat(64),
        charCount: 28,
        rawTextContentHash: 'e'.repeat(64),
        extractionMethod: 'DIGITAL_TEXT',
      },
    });

    const context = await service.getDirectorContext(principal(), bookId, {
      paragraph_id: paragraphId,
    });

    expect(context.object).toBe('director_context');
    expect(context.layers.l6_chunk.text).toBe('Alice walked into the room.');
    expect(context.layers.l1_global.language).toBe('en');
    expect(context.degraded_layers).toContain('L2'); // no Story Bible built yet

    await expect(
      service.getDirectorContext(principal(), bookId, {
        paragraph_id: paragraphId,
        token_budget: '1',
      }),
    ).rejects.toMatchObject({ code: 'CHUNK_SPLIT_REQUIRED' });
  });

  it('tenant isolation: a book from another tenant is 404, not visible', async () => {
    const otherTenantId = generateId();
    await prisma.tenant.create({
      data: { id: otherTenantId, name: 'Other Tenant', status: 'ACTIVE', planCode: 'test' },
    });
    const { bookId } = await createAnalyzableBook();
    const otherPrincipal = { sub: userId, tenantId: otherTenantId, roles: [], scopes: [] } as never;

    await expect(service.getStoryBible(otherPrincipal, bookId, {})).rejects.toMatchObject({
      httpStatus: 404,
    });

    await prisma.tenant.delete({ where: { id: otherTenantId } }).catch(() => undefined);
  });
});
