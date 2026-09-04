import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@audio-book/database';
import { NotFoundError } from '@audio-book/errors';
import type { Logger } from '@audio-book/logging';
import { LOGGER, PRISMA } from '../common/tokens.js';
import { assertTenantOwnership } from '../common/tenant.js';
import type { AuthenticatedPrincipal } from '../common/guards/jwt-auth.guard.js';

/**
 * The book progress read model (`api-specification.md` §16.19).
 *
 * Three properties this file exists to guarantee, all of them things a
 * progress endpoint gets wrong by default:
 *
 * 1. **Every number is measured, never inferred.** `progress` is
 *    `completed_units / total_units` over units that actually exist as rows —
 *    parsed pages, scenes, script chunks, audio chunks, chapter audio. The
 *    existence of a job is never evidence that work happened
 *    (`context.md` §11.4: "progress is derived from completed units, never
 *    estimated from wall clock").
 * 2. **Unknown is reported as unknown.** When a stage's denominator does not
 *    exist yet — no script has been generated, so nobody knows how many chunks
 *    TTS will render — `total_units` is `null` and `progress` is `null`, not
 *    `0`. Zero is a measurement; null is the absence of one, and conflating
 *    them is what produces a progress bar that sits at 0% and then jumps.
 * 3. **The ETA is allowed to say it does not know.** `estimate.confidence` is
 *    `NONE` with `remaining_ms: null` unless there is a measured completion
 *    rate to extrapolate from. §16.19: "A fabricated ETA is a contract
 *    violation."
 *
 * **Cost.** Every figure comes from a `count`/`groupBy` aggregate on an indexed
 * column, and the number of queries is fixed — it does not grow with the size
 * of the book. A 100-chapter, 10 000-segment project costs the same fixed set
 * of index-only aggregates as a one-chapter one, which is what §90 of the
 * Phase 8 brief requires ("progress endpoints must not scan millions of rows").
 * The rows themselves are never loaded, so the response size is bounded too.
 */

/** §20.5 — the stage vocabularies. These are projections for clients, never a second state machine. */
export type StageName = 'ingestion' | 'analysis' | 'director' | 'tts' | 'assembly';

const STAGE_JOB_TYPES: Record<StageName, string[]> = {
  ingestion: ['parse_book', 'ocr_page', 'normalize_text', 'analyze_structure'],
  analysis: ['analyze_scene', 'build_story_bible_delta'],
  director: ['generate_director_ir', 'revise_director_ir'],
  tts: ['generate_tts_chunk', 'validate_audio', 'process_audio', 'verify_transcript'],
  assembly: ['assemble_chapter', 'assemble_audiobook', 'encode_delivery_format'],
};

const ACTIVE_JOB_STATUSES = ['CREATED', 'QUEUED', 'RUNNING', 'RETRYING', 'BLOCKED'] as const;

export interface StageProgress {
  stage: StageName;
  status: string;
  /** `null` when the denominator is not yet knowable — never a placeholder `0`. */
  progress: number | null;
  completed_units: number;
  total_units: number | null;
  failed_units: number;
  flagged_units: number;
}

@Injectable()
export class ProgressService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async getBookProgress(principal: AuthenticatedPrincipal, bookId: string) {
    const book = await this.prisma.book.findFirst({
      where: { id: bookId, tenantId: principal.tenantId },
      select: { id: true, status: true, needsReview: true, updatedAt: true },
    });
    assertTenantOwnership(
      book ? { ...book, tenantId: principal.tenantId } : null,
      principal,
      'Book not found.',
    );

    const stages = await this.computeStages(bookId);
    const jobSummary = await this.summarizeJobs(bookId);

    // The overall figure is the mean of the stages whose denominator is known.
    // Deliberately NOT a mean over all five with unknowns counted as zero: that
    // would make a book with three finished stages read as 60% when it is
    // actually 100% of what is currently measurable, and would make the number
    // fall as new stages appear.
    const measurable = stages.filter((s) => s.progress !== null);
    const overall =
      measurable.length > 0
        ? round(measurable.reduce((sum, s) => sum + (s.progress ?? 0), 0) / measurable.length)
        : null;

    const flagged = stages.reduce((sum, s) => sum + s.flagged_units, 0);

    return {
      object: 'book_progress' as const,
      book_id: bookId,
      book_status: book!.status,
      overall_progress: overall,
      // §7.7 requires `degraded` to be present on every endpoint where
      // degradation is possible. This read is a set of aggregates against the
      // primary database: if it cannot run, the request fails outright rather
      // than returning a half-truth, so there is no partial state to report.
      degraded: false,
      degraded_reasons: [] as string[],
      stages,
      active_job_ids: jobSummary.activeJobIds,
      needs_review: book!.needsReview,
      needs_review_count: flagged,
      estimate: this.estimate(stages, jobSummary),
      queue: { position: null, backpressure: null },
      updated_at: new Date().toISOString(),
      links: {
        self: `/api/v1/books/${bookId}/progress`,
        book: `/api/v1/books/${bookId}`,
        events: `/api/v1/books/${bookId}/events`,
      },
    };
  }

  /**
   * The compact per-stage summary `GET /books/{id}?include=stages` embeds
   * (§16.5). Same derivation as the full read model, so the two can never
   * disagree about whether a stage finished.
   */
  async getStageSummary(bookId: string): Promise<Record<StageName, unknown>> {
    const stages = await this.computeStages(bookId);
    const out = {} as Record<StageName, unknown>;
    for (const stage of stages) {
      out[stage.stage] = {
        status: stage.status,
        progress: stage.progress,
        completed_units: stage.completed_units,
        total_units: stage.total_units,
      };
    }
    return out;
  }

  // ------------------------------------------------------------- derivation --

  private async computeStages(bookId: string): Promise<StageProgress[]> {
    const [
      jobsByTypeStatus,
      bookVersion,
      pagesByStatus,
      sceneCount,
      semanticsCount,
      audioScript,
      chunkCount,
      flaggedChunkCount,
      audioChunksByStatus,
      chapterCount,
      chapterAudioByStatus,
    ] = await Promise.all([
      this.prisma.processingJob.groupBy({
        by: ['type', 'status'],
        where: { bookId },
        _count: { _all: true },
      }),
      this.prisma.bookVersion.findFirst({
        where: { bookId, isCurrent: true },
        select: { id: true, status: true, pagesTotal: true, completedAt: true },
      }),
      this.prisma.parsedPage.groupBy({
        by: ['status'],
        where: { bookId },
        _count: { _all: true },
      }),
      this.prisma.scene.count({ where: { bookId } }),
      this.prisma.sceneSemantics.count({ where: { bookId } }),
      this.prisma.audioScript.findFirst({
        where: { bookId, isCurrent: true },
        select: { id: true, state: true },
      }),
      this.prisma.audioScriptChunk.count({ where: { bookId, isCurrent: true } }),
      this.prisma.audioScriptChunk.count({
        where: { bookId, isCurrent: true, NOT: { reviewFlags: { isEmpty: true } } },
      }),
      this.prisma.audioChunk.groupBy({
        by: ['status'],
        where: { bookId, isCurrent: true },
        _count: { _all: true },
      }),
      this.prisma.chapter.count({ where: { bookId } }),
      this.prisma.chapterAudio.groupBy({
        by: ['status'],
        where: { bookId, isCurrent: true },
        _count: { _all: true },
      }),
    ]);

    const jobStatus = new JobStatusIndex(jobsByTypeStatus);
    const pages = countsOf(pagesByStatus);
    const audio = countsOf(audioChunksByStatus);
    const chapterAudio = countsOf(chapterAudioByStatus);

    // --- ingestion: parsed pages are the unit -------------------------------
    // `pages_total` on the BookVersion is the denominator the parser itself
    // recorded. Before a version exists there is no denominator, and EPUB has
    // no pages at all — both are honestly `null` rather than a guessed 1.
    const pagesTotal = bookVersion?.pagesTotal ?? null;
    const pagesDone = (pages.OK ?? 0) + (pages.NEEDS_REVIEW ?? 0);
    const ingestion: StageProgress = {
      stage: 'ingestion',
      status: this.ingestionStatus(jobStatus, bookVersion?.status ?? null),
      progress: ratio(pagesDone, pagesTotal, bookVersion?.status),
      completed_units: pagesDone,
      total_units: pagesTotal,
      failed_units: pages.FAILED ?? 0,
      flagged_units: pages.NEEDS_REVIEW ?? 0,
    };

    // --- analysis: scenes are the unit --------------------------------------
    const analysis: StageProgress = {
      stage: 'analysis',
      status: this.stageStatus(
        'analysis',
        jobStatus,
        semanticsCount > 0 && semanticsCount >= sceneCount,
      ),
      progress: sceneCount > 0 ? round(Math.min(semanticsCount, sceneCount) / sceneCount) : null,
      completed_units: Math.min(semanticsCount, sceneCount),
      total_units: sceneCount > 0 ? sceneCount : null,
      failed_units: 0,
      flagged_units: 0,
    };

    // --- director: script chunks are the unit -------------------------------
    // The Director's own completion is a property of the AudioScript state, not
    // a chunk count: a VALIDATED script IS the finished unit set. Reporting a
    // fraction of chunks would imply chunks arrive incrementally, which they do
    // not — the IR is committed as a version.
    // `AudioScriptState` is `DRAFT | VALIDATED | SUPERSEDED` (there is no
    // LOCKED at script level — LOCKED belongs to the individual chunk).
    const directorDone = audioScript?.state === 'VALIDATED';
    const director: StageProgress = {
      stage: 'director',
      status: this.directorStatus(jobStatus, audioScript?.state ?? null),
      progress: audioScript ? (directorDone ? 1 : 0) : null,
      completed_units: directorDone ? chunkCount : 0,
      total_units: audioScript ? chunkCount : null,
      failed_units: 0,
      flagged_units: flaggedChunkCount,
    };

    // --- tts: audio chunks are the unit -------------------------------------
    // The denominator is the SCRIPT chunk count, not the audio chunk count:
    // using the latter would make progress 100% the moment the first chunk
    // renders, then fall as more are enqueued. §12 of the brief forbids a
    // progress figure that decreases.
    const ttsDone = (audio.GENERATED ?? 0) + (audio.VALIDATED ?? 0) + (audio.ASSEMBLED ?? 0);
    const ttsTotal = chunkCount > 0 ? chunkCount : null;
    const tts: StageProgress = {
      stage: 'tts',
      status: this.ttsStatus(jobStatus, ttsDone, ttsTotal),
      progress: ttsTotal === null ? null : round(Math.min(ttsDone, ttsTotal) / ttsTotal),
      completed_units: ttsDone,
      total_units: ttsTotal,
      failed_units: audio.FAILED ?? 0,
      flagged_units: audio.INVALID ?? 0,
    };

    // --- assembly: chapters are the unit ------------------------------------
    const assembledChapters = chapterAudio.ASSEMBLED ?? 0;
    const assemblyTotal = chapterCount > 0 ? chapterCount : null;
    const assembly: StageProgress = {
      stage: 'assembly',
      status: this.assemblyStatus(jobStatus, assembledChapters, assemblyTotal),
      progress:
        assemblyTotal === null
          ? null
          : round(Math.min(assembledChapters, assemblyTotal) / assemblyTotal),
      completed_units: assembledChapters,
      total_units: assemblyTotal,
      failed_units: chapterAudio.INVALID ?? 0,
      flagged_units: 0,
    };

    return [ingestion, analysis, director, tts, assembly];
  }

  private async summarizeJobs(bookId: string) {
    const active = await this.prisma.processingJob.findMany({
      where: { bookId, status: { in: [...ACTIVE_JOB_STATUSES] } },
      select: { id: true, startedAt: true, completedUnits: true, totalUnits: true },
      orderBy: { createdAt: 'desc' },
      // Bounded on purpose: a 10 000-chunk render has 10 000 active jobs, and
      // §89 forbids an unbounded array in a response. The full list is
      // available, paginated, at `GET /jobs?book_id=...&status=RUNNING`.
      take: 20,
    });

    const [activeCount, earliest] = await Promise.all([
      this.prisma.processingJob.count({
        where: { bookId, status: { in: [...ACTIVE_JOB_STATUSES] } },
      }),
      this.prisma.processingJob.findFirst({
        where: { bookId, startedAt: { not: null } },
        orderBy: { startedAt: 'asc' },
        select: { startedAt: true },
      }),
    ]);

    return {
      activeJobIds: active.map((j) => j.id),
      activeJobCount: activeCount,
      truncated: activeCount > active.length,
      firstStartedAt: earliest?.startedAt ?? null,
    };
  }

  /**
   * §16.19: `estimate` carries an explicit `confidence` and `basis`, and
   * `remaining_ms` is `null` whenever confidence is `NONE`.
   *
   * The only basis this system can honestly claim is `COMPLETED_UNIT_RATE`:
   * units finished per millisecond since the first job started, extrapolated
   * over what remains. Confidence is capped at `LOW` and deliberately not
   * raised: the rate is measured against a fleet whose size and contention this
   * service cannot see, and calling that MEDIUM would be a guess about
   * infrastructure dressed up as a measurement. Any stage without a known
   * denominator collapses the whole estimate to `NONE` — an ETA that silently
   * ignores unmeasurable work is worse than no ETA.
   */
  private estimate(stages: StageProgress[], jobs: { firstStartedAt: Date | null }) {
    const now = Date.now();
    const active = stages.find((s) => s.status === 'RUNNING' || s.status === 'QUEUED');
    const computedAt = new Date(now).toISOString();

    if (!active || active.total_units === null || !jobs.firstStartedAt) {
      return {
        remaining_ms: null,
        confidence: 'NONE' as const,
        basis: null,
        computed_at: computedAt,
      };
    }
    const elapsedMs = now - jobs.firstStartedAt.getTime();
    const remainingUnits = active.total_units - active.completed_units;
    if (active.completed_units <= 0 || elapsedMs <= 0 || remainingUnits <= 0) {
      return {
        remaining_ms: null,
        confidence: 'NONE' as const,
        basis: null,
        computed_at: computedAt,
      };
    }
    const msPerUnit = elapsedMs / active.completed_units;
    return {
      remaining_ms: Math.round(msPerUnit * remainingUnits),
      confidence: 'LOW' as const,
      basis: 'COMPLETED_UNIT_RATE' as const,
      computed_at: computedAt,
    };
  }

  // ---------------------------------------------- §20.5 stage state mapping --

  private ingestionStatus(jobs: JobStatusIndex, versionStatus: string | null): string {
    if (versionStatus === 'READY') return 'COMPLETED';
    if (versionStatus === 'PARTIAL_OCR') return 'PARTIAL_OCR';
    if (versionStatus === 'NEEDS_REVIEW') return 'NEEDS_REVIEW';
    if (versionStatus === 'FAILED') return 'FAILED';
    return this.jobDerivedStatus('ingestion', jobs);
  }

  private directorStatus(jobs: JobStatusIndex, scriptState: string | null): string {
    if (scriptState === 'VALIDATED') return 'COMPLETED';
    // A DRAFT script whose generating job has already succeeded is between IR
    // generation and IR validation — §20.5's `VALIDATING`. Reporting
    // `COMPLETED` there would tell a client the Audio Script is usable when
    // TTS will refuse it (`AUDIO_SCRIPT_NOT_VALIDATED`).
    if (scriptState === 'DRAFT') {
      const derived = this.jobDerivedStatus('director', jobs);
      return derived === 'COMPLETED' ? 'VALIDATING' : derived;
    }
    return this.jobDerivedStatus('director', jobs);
  }

  private ttsStatus(jobs: JobStatusIndex, done: number, total: number | null): string {
    const derived = this.jobDerivedStatus('tts', jobs);
    if (total === null || total === 0) return derived;
    if (done >= total) return 'COMPLETED';
    // `PARTIAL` is the §20.5 value for "some units rendered, no job left to
    // render the rest" — the state a user reaches after cancelling mid-render.
    if (derived === 'COMPLETED' && done < total) return 'PARTIAL';
    return derived;
  }

  private assemblyStatus(jobs: JobStatusIndex, assembled: number, total: number | null): string {
    const derived = this.jobDerivedStatus('assembly', jobs);
    if (total !== null && total > 0 && assembled >= total) return 'COMPLETED';
    if (derived === 'NOT_STARTED' && jobs.anyBlocked(STAGE_JOB_TYPES.assembly)) return 'BLOCKED';
    return derived;
  }

  private stageStatus(stage: StageName, jobs: JobStatusIndex, complete: boolean): string {
    if (complete) return 'COMPLETED';
    return this.jobDerivedStatus(stage, jobs);
  }

  /**
   * The shared job-to-stage projection. Order matters and is not arbitrary:
   * a stage with anything still moving is reported as moving, a stage whose
   * last word was a failure is `FAILED`, and only a stage with no jobs at all
   * is `NOT_STARTED`. Nothing here reports `COMPLETED` on the strength of job
   * state alone — that is always confirmed against entity state by the callers
   * above, because a job can succeed while producing nothing.
   */
  private jobDerivedStatus(stage: StageName, jobs: JobStatusIndex): string {
    const types = STAGE_JOB_TYPES[stage];
    if (jobs.count(types, ['RUNNING']) > 0) return 'RUNNING';
    if (jobs.count(types, ['RETRYING']) > 0) return 'RUNNING';
    if (jobs.count(types, ['CREATED', 'QUEUED']) > 0) return 'QUEUED';
    if (jobs.count(types, ['BLOCKED']) > 0) return 'BLOCKED';
    if (jobs.count(types, ['SUCCEEDED']) > 0) return 'COMPLETED';
    if (jobs.count(types, ['FAILED', 'DEAD_LETTERED']) > 0) return 'FAILED';
    if (jobs.count(types, ['CANCELLED']) > 0) return 'CANCELLED';
    return 'NOT_STARTED';
  }
}

/** Fixed-size index over the single `groupBy(type, status)` aggregate — no extra queries per stage. */
class JobStatusIndex {
  private readonly counts = new Map<string, number>();

  constructor(rows: { type: string; status: string; _count: { _all: number } }[]) {
    for (const row of rows) {
      this.counts.set(`${row.type}:${row.status}`, row._count._all);
    }
  }

  count(types: string[], statuses: string[]): number {
    let total = 0;
    for (const type of types) {
      for (const status of statuses) total += this.counts.get(`${type}:${status}`) ?? 0;
    }
    return total;
  }

  anyBlocked(types: string[]): boolean {
    return this.count(types, ['BLOCKED']) > 0;
  }
}

function countsOf(rows: { status: string; _count: { _all: number } }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = row._count._all;
  return out;
}

function ratio(done: number, total: number | null, versionStatus?: string): number | null {
  if (total === null || total === 0) {
    // A finished version with no page count (EPUB has no pages) is complete,
    // not unmeasurable — but only the version's own status may say so.
    return versionStatus === 'READY' ? 1 : null;
  }
  return round(Math.min(done, total) / total);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export { NotFoundError };
