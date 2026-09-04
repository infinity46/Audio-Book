import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '@audio-book/errors';
import { ProgressService, type StageProgress } from './progress.service.js';

/**
 * The progress read model's three honesty properties (`api-specification.md`
 * §16.19, Phase 8 brief §10-§13):
 *
 *   1. numbers come from counted rows, never from the existence of a job;
 *   2. an unknown denominator reports `null`, not `0`;
 *   3. the ETA says `NONE` unless there is a measured rate behind it.
 *
 * Each of these is easy to violate in a way no type checker catches and no user
 * can distinguish from a working progress bar until it lies to them.
 */

const principal = { sub: 'user-1', tenantId: 'tenant-1', roles: ['TENANT_MEMBER'], scopes: [] };

interface Fixture {
  bookStatus?: string;
  jobs?: { type: string; status: string; count: number }[];
  bookVersion?: { status: string; pagesTotal: number | null } | null;
  pages?: { status: string; count: number }[];
  sceneCount?: number;
  semanticsCount?: number;
  audioScript?: { state: string } | null;
  chunkCount?: number;
  flaggedChunkCount?: number;
  audioChunks?: { status: string; count: number }[];
  chapterCount?: number;
  chapterAudio?: { status: string; count: number }[];
  activeJobs?: { id: string }[];
  firstStartedAt?: Date | null;
}

function makeService(fixture: Fixture = {}) {
  const grouped = (rows: { status: string; count: number }[] = []) =>
    rows.map((r) => ({ status: r.status, _count: { _all: r.count } }));

  const prisma = {
    book: {
      findFirst: vi.fn(({ where }: { where: { id: string; tenantId: string } }) =>
        Promise.resolve(
          where.tenantId === 'tenant-1'
            ? {
                id: where.id,
                status: fixture.bookStatus ?? 'GENERATING',
                needsReview: false,
                updatedAt: new Date(),
              }
            : null,
        ),
      ),
    },
    processingJob: {
      groupBy: vi.fn(() =>
        Promise.resolve(
          (fixture.jobs ?? []).map((j) => ({
            type: j.type,
            status: j.status,
            _count: { _all: j.count },
          })),
        ),
      ),
      findMany: vi.fn(() => Promise.resolve(fixture.activeJobs ?? [])),
      count: vi.fn(() => Promise.resolve((fixture.activeJobs ?? []).length)),
      findFirst: vi.fn(() =>
        Promise.resolve(
          fixture.firstStartedAt === undefined ? null : { startedAt: fixture.firstStartedAt },
        ),
      ),
    },
    bookVersion: { findFirst: vi.fn(() => Promise.resolve(fixture.bookVersion ?? null)) },
    parsedPage: { groupBy: vi.fn(() => Promise.resolve(grouped(fixture.pages))) },
    scene: { count: vi.fn(() => Promise.resolve(fixture.sceneCount ?? 0)) },
    sceneSemantics: { count: vi.fn(() => Promise.resolve(fixture.semanticsCount ?? 0)) },
    audioScript: { findFirst: vi.fn(() => Promise.resolve(fixture.audioScript ?? null)) },
    audioScriptChunk: {
      count: vi
        .fn()
        .mockResolvedValueOnce(fixture.chunkCount ?? 0)
        .mockResolvedValueOnce(fixture.flaggedChunkCount ?? 0),
    },
    audioChunk: { groupBy: vi.fn(() => Promise.resolve(grouped(fixture.audioChunks))) },
    chapter: { count: vi.fn(() => Promise.resolve(fixture.chapterCount ?? 0)) },
    chapterAudio: { groupBy: vi.fn(() => Promise.resolve(grouped(fixture.chapterAudio))) },
  };

  const logger = { info: vi.fn(), warn: vi.fn() };
  return {
    service: new ProgressService(prisma as never, logger as never),
    prisma,
  };
}

function stage(result: { stages: StageProgress[] }, name: string): StageProgress {
  return result.stages.find((s) => s.stage === name)!;
}

describe('ProgressService — unknown is reported as unknown', () => {
  it('reports a brand-new book as null progress everywhere, never 0%', async () => {
    const { service } = makeService();
    const result = await service.getBookProgress(principal, 'book-1');

    // §13: "If total work cannot yet be calculated, return UNKNOWN rather
    // than 0%." A zero here renders as a progress bar that has not moved,
    // which is a claim about work; null renders as "not known yet".
    expect(result.overall_progress).toBeNull();
    for (const s of result.stages) {
      expect(s.total_units).toBeNull();
      expect(s.progress).toBeNull();
      expect(s.status).toBe('NOT_STARTED');
    }
  });

  it('reports TTS as unknown until a script exists to count chunks against', async () => {
    const { service } = makeService({
      jobs: [{ type: 'generate_tts_chunk', status: 'RUNNING', count: 1 }],
      audioChunks: [{ status: 'GENERATED', count: 3 }],
      chunkCount: 0,
    });
    const result = await service.getBookProgress(principal, 'book-1');

    // Three chunks exist but nobody knows out of how many — dividing by the
    // audio-chunk count instead would report 100%.
    expect(stage(result, 'tts').total_units).toBeNull();
    expect(stage(result, 'tts').progress).toBeNull();
    expect(stage(result, 'tts').completed_units).toBe(3);
  });
});

describe('ProgressService — numbers come from rows, not from jobs', () => {
  it('does not report progress just because a job succeeded', async () => {
    const { service } = makeService({
      jobs: [{ type: 'generate_tts_chunk', status: 'SUCCEEDED', count: 40 }],
      chunkCount: 100,
      audioChunks: [],
    });
    const result = await service.getBookProgress(principal, 'book-1');

    // 40 succeeded jobs, zero audio chunks: the honest answer is 0 of 100.
    expect(stage(result, 'tts').completed_units).toBe(0);
    expect(stage(result, 'tts').progress).toBe(0);
  });

  it('measures TTS against the script chunk count so progress cannot decrease', async () => {
    const partial = makeService({
      chunkCount: 100,
      audioChunks: [{ status: 'VALIDATED', count: 25 }],
      jobs: [{ type: 'generate_tts_chunk', status: 'RUNNING', count: 1 }],
    });
    const later = makeService({
      chunkCount: 100,
      audioChunks: [{ status: 'VALIDATED', count: 60 }],
      jobs: [{ type: 'generate_tts_chunk', status: 'RUNNING', count: 1 }],
    });

    const first = await partial.service.getBookProgress(principal, 'book-1');
    const second = await later.service.getBookProgress(principal, 'book-1');

    // §12: progress must never decrease unexpectedly. A denominator that grew
    // as chunks were enqueued would make 25/25 (100%) become 60/100 (60%).
    expect(stage(first, 'tts').progress).toBe(0.25);
    expect(stage(second, 'tts').progress).toBe(0.6);
    expect(stage(second, 'tts').progress!).toBeGreaterThan(stage(first, 'tts').progress!);
  });

  it('counts NEEDS_REVIEW pages as done but also as flagged', async () => {
    const { service } = makeService({
      bookVersion: { status: 'READY', pagesTotal: 10 },
      pages: [
        { status: 'OK', count: 7 },
        { status: 'NEEDS_REVIEW', count: 2 },
        { status: 'FAILED', count: 1 },
      ],
    });
    const result = await service.getBookProgress(principal, 'book-1');
    const ingestion = stage(result, 'ingestion');

    // A page needing review has been parsed — it is done work with a caveat,
    // not unparsed work. Failed pages are neither.
    expect(ingestion.completed_units).toBe(9);
    expect(ingestion.flagged_units).toBe(2);
    expect(ingestion.failed_units).toBe(1);
    expect(ingestion.progress).toBe(0.9);
  });
});

describe('ProgressService — the ETA is allowed to say it does not know', () => {
  it('returns NONE with a null remaining_ms when nothing has completed', async () => {
    const { service } = makeService({
      chunkCount: 100,
      audioChunks: [],
      jobs: [{ type: 'generate_tts_chunk', status: 'RUNNING', count: 1 }],
      firstStartedAt: new Date(Date.now() - 60_000),
    });
    const result = await service.getBookProgress(principal, 'book-1');

    // §16.19: "a fabricated ETA is a contract violation."
    expect(result.estimate.confidence).toBe('NONE');
    expect(result.estimate.remaining_ms).toBeNull();
    expect(result.estimate.basis).toBeNull();
  });

  it('extrapolates only from a measured completion rate, and calls its confidence LOW', async () => {
    const { service } = makeService({
      chunkCount: 100,
      audioChunks: [{ status: 'VALIDATED', count: 25 }],
      jobs: [{ type: 'generate_tts_chunk', status: 'RUNNING', count: 1 }],
      firstStartedAt: new Date(Date.now() - 100_000),
    });
    const result = await service.getBookProgress(principal, 'book-1');

    // 25 units in 100s -> 4s/unit -> ~300s for the remaining 75.
    expect(result.estimate.basis).toBe('COMPLETED_UNIT_RATE');
    expect(result.estimate.confidence).toBe('LOW');
    expect(result.estimate.remaining_ms).toBeGreaterThan(250_000);
    expect(result.estimate.remaining_ms).toBeLessThan(350_000);
  });
});

describe('ProgressService — §20.5 stage state projection', () => {
  it('reports a DRAFT script whose job succeeded as VALIDATING, not COMPLETED', async () => {
    const { service } = makeService({
      audioScript: { state: 'DRAFT' },
      chunkCount: 10,
      jobs: [{ type: 'generate_director_ir', status: 'SUCCEEDED', count: 1 }],
    });
    const result = await service.getBookProgress(principal, 'book-1');

    // Reporting COMPLETED would tell a client the Audio Script is usable when
    // POST /tts will refuse it with AUDIO_SCRIPT_NOT_VALIDATED.
    expect(stage(result, 'director').status).toBe('VALIDATING');
  });

  it('reports TTS as PARTIAL when the render stopped short of the full chunk set', async () => {
    const { service } = makeService({
      chunkCount: 100,
      audioChunks: [{ status: 'VALIDATED', count: 40 }],
      jobs: [{ type: 'generate_tts_chunk', status: 'SUCCEEDED', count: 40 }],
    });
    const result = await service.getBookProgress(principal, 'book-1');

    // The state a user reaches after cancelling mid-render: work stopped, but
    // it is not COMPLETED and it is not FAILED.
    expect(stage(result, 'tts').status).toBe('PARTIAL');
  });

  it('prefers a live job over a finished one when both exist for a stage', async () => {
    const { service } = makeService({
      chunkCount: 100,
      audioChunks: [{ status: 'VALIDATED', count: 40 }],
      jobs: [
        { type: 'generate_tts_chunk', status: 'SUCCEEDED', count: 40 },
        { type: 'generate_tts_chunk', status: 'RUNNING', count: 2 },
      ],
    });
    const result = await service.getBookProgress(principal, 'book-1');
    expect(stage(result, 'tts').status).toBe('RUNNING');
  });
});

describe('ProgressService — bounded responses and authorization', () => {
  it('caps active_job_ids rather than returning one entry per chunk', async () => {
    const activeJobs = Array.from({ length: 500 }, (_, i) => ({ id: `job-${i}` }));
    const { service, prisma } = makeService({ activeJobs });
    const result = await service.getBookProgress(principal, 'book-1');

    // §89: a 10 000-segment project must not produce a huge API response.
    // The query itself is bounded, not just the response.
    expect(prisma.processingJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );
    expect(result.active_job_ids.length).toBeLessThanOrEqual(500);
  });

  it('refuses another tenant with 404', async () => {
    const { service } = makeService();
    await expect(
      service.getBookProgress({ ...principal, tenantId: 'tenant-2' }, 'book-1'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('issues a fixed number of queries regardless of book size', async () => {
    const { service, prisma } = makeService({
      chunkCount: 10_000,
      chapterCount: 120,
      audioChunks: [{ status: 'VALIDATED', count: 8_000 }],
    });
    await service.getBookProgress(principal, 'book-1');

    // §90: the endpoint must not scan millions of rows. Every figure is one
    // aggregate; none of these is called per chapter or per chunk.
    expect(prisma.audioChunk.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.chapterAudio.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.processingJob.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.audioScriptChunk.count).toHaveBeenCalledTimes(2);
  });
});
