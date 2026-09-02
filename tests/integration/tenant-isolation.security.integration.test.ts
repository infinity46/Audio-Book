import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, disconnectPrisma, type PrismaClient } from '@audio-book/database';
import { NotFoundError } from '@audio-book/errors';
import { generateId } from '@audio-book/events';
import { QueueManager } from '@audio-book/queue';
import { InMemoryStorageProvider } from '@audio-book/storage';
import { AnalysisService } from '@audio-book/api/analysis/analysis.service';
import { AssemblyService } from '@audio-book/api/assembly/assembly.service';
import { BooksService } from '@audio-book/api/books/books.service';
import { DirectorService } from '@audio-book/api/director/director.service';
import { TtsService } from '@audio-book/api/tts/tts.service';
import { VoiceService } from '@audio-book/api/voice/voice.service';

/**
 * Phase 7 security gate (§68-§70): tenant isolation and IDOR.
 *
 * Two real tenants are seeded in real Postgres, then every ownership-gated
 * service entry point is called with tenant B's principal against tenant A's
 * resource ids. Every one must raise NotFoundError — never a different error
 * class, and never a successful read. 404-not-403 is the codebase's own
 * documented contract (apps/api/src/common/tenant.ts): a 403 would confirm
 * the resource exists, leaking its existence across a tenant boundary.
 *
 * Exercised at the service layer, where `assertTenantOwnership` and the real
 * Prisma `where` clauses actually live — the existing `*.controller.test.ts`
 * files mock the service entirely and therefore cannot catch a real IDOR.
 * This mirrors analysis.integration.test.ts's convention: real Postgres,
 * services constructed directly, synthetic principals (the repo has no
 * JWT-minting test helper, and JwtAuthGuard only builds the principal these
 * tests pass in directly).
 *
 * Two attack shapes are covered:
 *   1. Foreign book id — tenant B passes tenant A's bookId.
 *   2. ID substitution — tenant B passes its OWN bookId paired with tenant
 *      A's sub-resource id. This is the one the ownership check alone does
 *      not catch, because services resolve sub-resources with
 *      `findFirst({ where: { id, bookId } })`, trusting bookId was already
 *      ownership-checked upstream.
 *
 * NOT covered here (deliberate, recorded as a gap in docs/qa/scorecard.md
 * rather than silently claimed): ID-substitution for AudioScript /
 * AudioScriptChunk / AudioChunk / ChapterAudio / Audiobook, whose fixtures
 * require the full StoryBible + ModelVersion + TTS lineage chain. Their
 * book-level ownership gate IS covered below.
 */
describe('Tenant isolation / IDOR: cross-tenant access must always 404', () => {
  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://audiobook:audiobook_dev_password@localhost:5432/audiobook';
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

  let prisma: PrismaClient;
  let queueManager: QueueManager;

  let books: BooksService;
  let analysis: AnalysisService;
  let director: DirectorService;
  let tts: TtsService;
  let voice: VoiceService;
  let assembly: AssemblyService;

  // Tenant A owns the resources under attack; tenant B is the attacker.
  const a = { tenantId: '', userId: '', bookId: '', chapterId: '', characterId: '', voiceProfileId: '' };
  const b = { tenantId: '', userId: '', bookId: '' };

  const principalA = () => ({ sub: a.userId, tenantId: a.tenantId, roles: [], scopes: [] });
  const principalB = () => ({ sub: b.userId, tenantId: b.tenantId, roles: [], scopes: [] });

  async function seedTenant(label: string): Promise<{ tenantId: string; userId: string; bookId: string }> {
    const tenantId = generateId();
    const userId = generateId();
    const bookId = generateId();
    const bookFileId = generateId();
    const bookVersionId = generateId();
    const now = new Date();

    await prisma.tenant.create({
      data: { id: tenantId, name: `Isolation Test Tenant ${label}`, status: 'ACTIVE', planCode: 'test' },
    });
    await prisma.user.create({
      data: {
        id: userId,
        tenantId,
        email: `isolation-${label}-${tenantId}@test.local`,
        displayName: `Isolation Test User ${label}`,
        status: 'ACTIVE',
        roles: ['TENANT_OWNER'],
        preferences: {},
      },
    });
    await prisma.book.create({
      data: {
        id: bookId,
        tenantId,
        title: `Isolation Test Book ${label}`,
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
    await prisma.book.update({
      where: { id: bookId },
      data: { currentBookVersionId: bookVersionId },
    });

    return { tenantId, userId, bookId };
  }

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl });
    queueManager = new QueueManager({ redisUrl, backoff: { baseMs: 10, ceilingMs: 100 } });
    const storage = new InMemoryStorageProvider();
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;
    const sessionStore = {
      create: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      update: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    } as never;

    books = new BooksService(prisma, storage, queueManager, logger, sessionStore);
    analysis = new AnalysisService(prisma, queueManager, logger);
    director = new DirectorService(prisma, queueManager, logger);
    tts = new TtsService(prisma, queueManager, storage, logger);
    voice = new VoiceService(prisma, queueManager, logger);
    assembly = new AssemblyService(prisma, queueManager, storage, logger, sessionStore);

    const seededA = await seedTenant('A');
    Object.assign(a, seededA);
    const seededB = await seedTenant('B');
    Object.assign(b, seededB);

    // Tenant A's sub-resources — the ID-substitution targets.
    a.chapterId = generateId();
    const bookVersionA = await prisma.bookVersion.findFirstOrThrow({ where: { bookId: a.bookId } });
    await prisma.chapter.create({
      data: {
        id: a.chapterId,
        tenantId: a.tenantId,
        bookId: a.bookId,
        bookVersionId: bookVersionA.id,
        orderIndex: 0,
        spineStart: 0,
        spineEnd: 9,
        matterType: 'BODY',
        charCount: 100,
      },
    });

    a.characterId = generateId();
    await prisma.character.create({
      data: {
        id: a.characterId,
        tenantId: a.tenantId,
        bookId: a.bookId,
        displayName: 'Tenant A Secret Character',
        status: 'CONFIRMED',
      },
    });

    a.voiceProfileId = generateId();
    await prisma.voiceProfile.create({
      data: {
        id: a.voiceProfileId,
        scope: 'TENANT',
        tenantId: a.tenantId,
        name: 'Tenant A Private Voice',
        createdByUserId: a.userId,
      },
    });
  });

  afterAll(async () => {
    await queueManager?.close();
    // Some local Postgres setups fail arbitrary queries with a pgvector
    // extension load error unrelated to these tables — non-fatal for cleanup
    // (same convention as analysis.integration.test.ts).
    try {
      for (const tenantId of [a.tenantId, b.tenantId].filter(Boolean)) {
        await prisma.voiceProfile.deleteMany({ where: { tenantId } });
        await prisma.character.deleteMany({ where: { tenantId } });
        await prisma.chapter.deleteMany({ where: { tenantId } });
        await prisma.book.updateMany({ where: { tenantId }, data: { currentBookVersionId: null } });
        await prisma.bookVersion.deleteMany({ where: { tenantId } });
        await prisma.bookFile.deleteMany({ where: { tenantId } });
        await prisma.book.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      }
    } catch (err) {
      console.warn('tenant-isolation.security.integration.test.ts cleanup failed (non-fatal):', err);
    }
    await disconnectPrisma(prisma);
  });

  /** Every case must fail closed with NotFoundError — never another error class, never a value. */
  async function expectDenied(label: string, call: () => Promise<unknown>): Promise<void> {
    await expect(call(), `${label} must be denied with NotFoundError`).rejects.toBeInstanceOf(
      NotFoundError,
    );
  }

  describe('sanity: tenant A can read its own resources', () => {
    it('reads its own book, chapter, character, and voice profile', async () => {
      await expect(books.getBook(principalA(), a.bookId)).resolves.toBeTruthy();
      await expect(books.getChapter(principalA(), a.bookId, a.chapterId)).resolves.toBeTruthy();
      await expect(analysis.getCharacter(principalA(), a.bookId, a.characterId)).resolves.toBeTruthy();
      await expect(voice.getVoiceProfile(principalA(), a.voiceProfileId)).resolves.toBeTruthy();
    });
  });

  describe('attack 1: tenant B passes tenant A\'s bookId', () => {
    it('BooksService denies every book-scoped read', async () => {
      await expectDenied('getBook', () => books.getBook(principalB(), a.bookId));
      await expectDenied('getIngestionStatus', () => books.getIngestionStatus(principalB(), a.bookId));
      await expectDenied('listChapters', () => books.listChapters(principalB(), a.bookId));
      await expectDenied('getChapter', () => books.getChapter(principalB(), a.bookId, a.chapterId));
      await expectDenied('listSections', () => books.listSections(principalB(), a.bookId));
      await expectDenied('listParagraphs', () =>
        books.listParagraphs(principalB(), a.bookId, a.chapterId),
      );
      await expectDenied('createTextAccessUrl', () => books.createTextAccessUrl(principalB(), a.bookId));
    });

    it('AnalysisService denies every book-scoped read', async () => {
      await expectDenied('getAnalysisStatus', () => analysis.getAnalysisStatus(principalB(), a.bookId));
      await expectDenied('listCharacters', () => analysis.listCharacters(principalB(), a.bookId, {}));
      await expectDenied('getCharacter', () =>
        analysis.getCharacter(principalB(), a.bookId, a.characterId),
      );
      await expectDenied('getStoryBible', () => analysis.getStoryBible(principalB(), a.bookId));
      await expectDenied('listScenes', () => analysis.listScenes(principalB(), a.bookId, {}));
      await expectDenied('getDirectorContext', () =>
        analysis.getDirectorContext(principalB(), a.bookId, {}),
      );
    });

    it('DirectorService denies every book-scoped read', async () => {
      await expectDenied('getDirectorState', () => director.getDirectorState(principalB(), a.bookId));
      await expectDenied('getCurrentAudioScript', () =>
        director.getCurrentAudioScript(principalB(), a.bookId),
      );
      await expectDenied('listAudioScripts', () => director.listAudioScripts(principalB(), a.bookId, {}));
      await expectDenied('listAudioScriptChunks', () =>
        director.listAudioScriptChunks(principalB(), a.bookId, {}),
      );
    });

    it('TtsService denies every book-scoped read', async () => {
      await expectDenied('getTtsState', () => tts.getTtsState(principalB(), a.bookId));
      await expectDenied('listAudioChunks', () => tts.listAudioChunks(principalB(), a.bookId, {}));
    });

    it('VoiceService denies every book-scoped read', async () => {
      await expectDenied('getCastingState', () => voice.getCastingState(principalB(), a.bookId));
      await expectDenied('getCharacterVoice', () =>
        voice.getCharacterVoice(principalB(), a.bookId, a.characterId),
      );
    });

    it('AssemblyService denies every book-scoped read', async () => {
      await expectDenied('getAssemblyState', () => assembly.getAssemblyState(principalB(), a.bookId));
      await expectDenied('listChapterAudio', () => assembly.listChapterAudio(principalB(), a.bookId, {}));
      await expectDenied('getAudiobookProject', () =>
        assembly.getAudiobookProject(principalB(), a.bookId),
      );
      await expectDenied('listAudiobooks', () => assembly.listAudiobooks(principalB(), a.bookId, {}));
    });

    it('VoiceService denies reading a tenant-scoped voice profile it does not own', async () => {
      await expectDenied('getVoiceProfile', () => voice.getVoiceProfile(principalB(), a.voiceProfileId));
      await expectDenied('listVoiceProfileVersions', () =>
        voice.listVoiceProfileVersions(principalB(), a.voiceProfileId),
      );
    });
  });

  describe("attack 2: ID substitution — tenant B's own bookId + tenant A's sub-resource id", () => {
    it('does not return tenant A\'s chapter under tenant B\'s book', async () => {
      await expectDenied('getChapter', () => books.getChapter(principalB(), b.bookId, a.chapterId));
      await expectDenied('listParagraphs', () =>
        books.listParagraphs(principalB(), b.bookId, a.chapterId),
      );
    });

    it('does not return tenant A\'s character under tenant B\'s book', async () => {
      await expectDenied('getCharacter', () =>
        analysis.getCharacter(principalB(), b.bookId, a.characterId),
      );
      await expectDenied('getCharacterVoice', () =>
        voice.getCharacterVoice(principalB(), b.bookId, a.characterId),
      );
      await expectDenied('listCharacterAliases', () =>
        analysis.listCharacterAliases(principalB(), b.bookId, a.characterId),
      );
    });
  });
});
