import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, disconnectPrisma, type PrismaClient } from '@audio-book/database';
import { generateId } from '@audio-book/events';
import { buildGoldenBookPdf } from '@audio-book/ingestion/test-fixtures';
import { GOLDEN_BOOK_EXPECTED } from '../../packages/ingestion/src/test-fixtures/golden-book.expected.js';
import { startHarness, type E2EHarness } from './harness.js';

/**
 * The first test that carries one real document across a process boundary:
 *
 *   HTTP upload session -> signed URL -> MinIO -> HTTP completion
 *     -> ProcessingJob + Redis enqueue (apps/api)
 *       -> worker-cpu dequeues and runs the REAL ingestion pipeline
 *         -> BookVersion + Chapters + Paragraphs in Postgres
 *           -> HTTP reads that show the parsed structure
 *
 * Nothing is mocked: real API process, real worker process, real object
 * storage, real queue, real parser. The only thing standing in for a
 * production input is the document itself, which is the golden fixture so
 * the assertions can be exact rather than "something came out".
 *
 * This is the E2E-MOCK environment from docs/qa/strategy.md §2 — "mock"
 * refers to inference (no LLM, no GPU), not to the orchestration, which is
 * entirely real.
 */
describe('Ingestion pipeline, end to end across processes', () => {
  let harness: E2EHarness;
  let prisma: PrismaClient;

  const tenantId = generateId();
  const userId = generateId();
  let token: string;
  let bookId: string;

  /** Ingestion refuses to persist without provenance, so the parser/normalizer identities must exist. */
  async function ensureModelVersion(entry: {
    role: 'PARSER' | 'NORMALIZER';
    providerId: string;
    modelId: string;
    version: string;
  }): Promise<void> {
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
    const existing = await prisma.modelVersion.findFirst({
      where: { modelRegistryId: registry.id, version: entry.version },
    });
    if (existing) return;
    await prisma.modelVersion.create({
      data: {
        id: generateId(),
        modelRegistryId: registry.id,
        version: entry.version,
        paramsFingerprint: createHash('sha256').update(JSON.stringify(entry)).digest('hex'),
        releasedAt: new Date(),
      },
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient({
      databaseUrl:
        process.env.DATABASE_URL ??
        'postgresql://audiobook:audiobook_dev_password@localhost:5432/audiobook',
    });

    await prisma.tenant.create({
      data: { id: tenantId, name: 'E2E Ingestion Tenant', status: 'ACTIVE', planCode: 'test' },
    });
    await prisma.user.create({
      data: {
        id: userId,
        tenantId,
        email: `e2e-ingest-${tenantId}@test.local`,
        displayName: 'E2E Ingestion User',
        status: 'ACTIVE',
        roles: ['TENANT_OWNER'],
        preferences: {},
      },
    });

    // Identities the real PdfParser and normalizer report.
    await ensureModelVersion({
      role: 'PARSER',
      providerId: 'pdfjs-dist',
      modelId: 'pdf-text-extractor',
      version: '4.9.155',
    });
    await ensureModelVersion({
      role: 'NORMALIZER',
      providerId: 'audio-book-normalizer',
      modelId: 'text-normalizer',
      version: 'normalize.v2',
    });

    harness = await startHarness({ withWorker: true });
    token = await harness.token({ sub: userId, tenantId, roles: ['TENANT_OWNER'] });
  });

  afterAll(async () => {
    await harness?.stop();
    try {
      await prisma.$executeRaw`DELETE FROM paragraph WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM section WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM chapter WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM parsed_page WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`UPDATE book SET current_book_version_id = NULL WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM book_version WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM outbox_message WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM processing_job WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM idempotency_key WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM book_file WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM book WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM "user" WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM tenant WHERE id = ${tenantId}::uuid`;
    } catch (err) {
      console.warn('ingestion-pipeline.e2e cleanup failed (non-fatal):', err);
    }
    await disconnectPrisma(prisma);
  });

  it('carries a real PDF from upload to queryable chapters', async () => {
    // ---- 1. Create the book.
    const created = await harness.request('POST', '/api/v1/books', {
      token,
      body: { title: 'The Golden Book', author: 'E2E Fixture', language: 'en' },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(created.status).toBe(201);
    bookId = (created.body as { data: { id: string } }).data.id;

    // ---- 2. Open an upload session for the real fixture bytes.
    const pdf = await buildGoldenBookPdf();
    const contentHash = createHash('sha256').update(pdf).digest('hex');

    const session = await harness.request('POST', `/api/v1/books/${bookId}/upload-sessions`, {
      token,
      body: {
        file_name: 'golden-book.pdf',
        declared_mime_type: 'application/pdf',
        declared_size_bytes: pdf.byteLength,
        declared_content_hash: { algorithm: 'SHA256', value: contentHash },
        source_kind: 'PDF',
      },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(session.status).toBe(201);
    const sessionBody = session.body as {
      data: { id: string; upload_targets: { url: string; method: string }[] };
    };
    const target = sessionBody.data.upload_targets[0]!;
    expect(target.method).toBe('PUT');
    // The API hands out a signed URL; bytes never traverse the API itself.
    expect(target.url).not.toContain('/api/v1/');

    // ---- 3. Upload the bytes straight to object storage, as a client would.
    const upload = await fetch(target.url, {
      method: 'PUT',
      body: pdf,
      headers: { 'content-type': 'application/pdf' },
    });
    expect(upload.ok, `signed PUT failed with ${upload.status}`).toBe(true);

    // ---- 4. Complete the session: admits the BookFile and enqueues parse_book.
    const completion = await harness.request(
      'POST',
      `/api/v1/books/${bookId}/upload-sessions/${sessionBody.data.id}/completion`,
      {
        token,
        body: { observed_size_bytes: pdf.byteLength },
        headers: { 'idempotency-key': randomUUID() },
      },
    );
    expect(completion.status).toBe(202);

    // ---- 5. worker-cpu picks the job off Redis and runs the real pipeline.
    const TERMINAL = ['COMPLETED', 'PARTIAL_OCR', 'NEEDS_REVIEW', 'FAILED', 'CANCELLED'];
    const state = await pollIngestion((s) => TERMINAL.includes(s.status));
    expect(
      state.status,
      `ingestion did not succeed; final state: ${JSON.stringify(state)}`,
    ).toBe('COMPLETED');

    // The fixture is two chapters of real prose.
    expect(state.counts.chapters).toBe(GOLDEN_BOOK_EXPECTED.chapterTitles.length);
    expect(state.counts.paragraphs).toBeGreaterThan(0);
    expect(state.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // ---- 6. The parsed structure is now readable over HTTP.
    const chapters = await harness.request('GET', `/api/v1/books/${bookId}/chapters`, { token });
    expect(chapters.status).toBe(200);
    const chapterRows = (chapters.body as { data: { id: string; title: string | null }[] }).data;
    expect(chapterRows.map((c) => c.title)).toEqual([...GOLDEN_BOOK_EXPECTED.chapterTitles]);

    // ---- 7. Text fidelity survived the whole crossing, not just the parser.
    const paragraphs = await harness.request(
      'GET',
      `/api/v1/books/${bookId}/paragraphs?chapter_id=${chapterRows[0]!.id}`,
      { token },
    );
    expect(paragraphs.status).toBe(200);
    const text = (paragraphs.body as { data: { text: string }[] }).data
      .map((p) => p.text)
      .join(' ');
    expect(text).toContain('47 ships');
    expect(text).toContain('extraordinary season'); // hyphenation rejoined
    expect(text).not.toContain('THE GREAT BOOK'); // page header stripped
  }, 120_000);

  it('records the job lineage the artifact can be traced back through', async () => {
    // §135/§136: a produced artifact must be traceable to the job, the file,
    // and the document that produced it.
    const job = await prisma.processingJob.findFirst({
      where: { bookId, type: 'parse_book' },
      orderBy: { createdAt: 'desc' },
    });
    expect(job).not.toBeNull();
    expect(job!.status).toBe('SUCCEEDED');
    expect(job!.tenantId).toBe(tenantId);
    // queuedAt is the marker the orphaned-job sweeper depends on (F-2): a
    // job that really went through Redis must carry it.
    expect(job!.queuedAt).not.toBeNull();

    const bookVersion = await prisma.bookVersion.findFirst({ where: { bookId, isCurrent: true } });
    expect(bookVersion).not.toBeNull();
    expect(bookVersion!.bookFileId).toBe(job!.relatedResourceId);
    expect(bookVersion!.status).toBe('READY');
    // Provenance is recorded, not assumed.
    expect(bookVersion!.parserModelVersionId).toBeTruthy();
    expect(bookVersion!.normalizerModelVersionId).toBeTruthy();
  });

  interface IngestionState {
    status: string;
    content_hash?: string;
    counts: { chapters: number; paragraphs: number };
  }

  async function pollIngestion(
    done: (state: IngestionState) => boolean,
    timeoutMs = 90_000,
  ): Promise<IngestionState> {
    const deadline = Date.now() + timeoutMs;
    let last: IngestionState = { status: 'UNKNOWN', counts: { chapters: 0, paragraphs: 0 } };
    while (Date.now() < deadline) {
      const response = await harness.request('GET', `/api/v1/books/${bookId}/ingestion`, { token });
      if (response.status === 200) {
        last = (response.body as { data: IngestionState }).data;
        if (done(last)) return last;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`ingestion did not settle in ${timeoutMs}ms; last state ${JSON.stringify(last)}`);
  }
});
