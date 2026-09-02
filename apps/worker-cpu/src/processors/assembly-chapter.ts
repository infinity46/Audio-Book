/**
 * Consumes the `assemble_chapter` command (event-contracts.md §12.7 /
 * api-specification.md §16.16): concatenates a chapter's `VALIDATED`
 * `AudioChunk`s, in `chapterSequenceIndex` order, into one mastered
 * `ChapterAudio` track, and — on the DB-observed completion of the LAST
 * chapter a book needs — auto-triggers `assemble_audiobook`
 * (event-contracts.md §31.2's DB-query fan-in, never a queue-message count).
 *
 * Mirrors processors/ingestion.ts's transactional shape: a short
 * read/freeze transaction (mark RUNNING + emit `chapter.assembly_started`),
 * heavy ffmpeg work done entirely outside any transaction, then a short
 * persist transaction (ChapterAudio + members + job SUCCEEDED +
 * `chapter.completed`), with a `handle*` function on every failure path.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Prisma, PrismaClient, Tx } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import type { ProcessingJob } from '@prisma/client';
import { generateId, writeOutboxMessage } from '@audio-book/events';
import type { Logger } from '@audio-book/logging';
import type { QueueJobEnvelope } from '@audio-book/queue';
import { enqueueProcessingJob, QueueManager } from '@audio-book/queue';
import { buildStorageKey, type StorageProvider } from '@audio-book/storage';
import {
  applySinglePassLoudnorm,
  applyTwoPassLoudnorm,
  concatDemuxCopy,
  detectSilence,
  generateSilenceFile,
  measureClipping,
  measureEbur128,
  measureOverallRmsDb,
  probeAudio,
  trimAndConvert,
  writeConcatFileList,
  type SilenceInterval,
} from '../lib/ffmpeg.js';
import { MASTERING_POLICY_V1, SILENCE_TRIM_POLICY_V1 } from '../lib/mastering-policy.js';
import {
  ASSEMBLY_PIPELINE_VERSION,
  PRODUCER,
  PRODUCER_VERSION,
  checkAudiobookReadiness,
  computeManifestHash,
  errorClassOf,
  errorCodeOf,
  errorMessage,
  readJobScope,
  resolveAudioToolModelVersionId,
  withTempDir,
} from './assembly-shared.js';

export interface AssembleChapterCommandPayload {
  chapter_id: string;
}

export interface ProcessAssembleChapterJobDeps {
  prisma: PrismaClient;
  storage: StorageProvider;
  logger: Logger;
  envelope: QueueJobEnvelope<AssembleChapterCommandPayload>;
  /**
   * Not part of processIngestionJob's dependency shape, but required here:
   * the last chapter to finish assembling auto-enqueues `assemble_audiobook`
   * (the DB-query fan-in trigger, see `maybeTriggerAudiobookFanIn` below),
   * which needs a way to actually put a job on the `audio` queue.
   */
  queueManager: QueueManager;
  attemptsMade: number;
  maxAttempts: number;
}

interface OrderedChunk {
  id: string;
  chapterSequenceIndex: number;
  directorVersion: string;
  characterId: string | null;
  voiceProfileVersionId: string | null;
  pauses: unknown;
  currentAudioChunk: {
    id: string;
    storageKey: string;
    contentHash: string;
    status: string;
    sampleRate: number;
    channels: number;
  } | null;
}

export async function processAssembleChapterJob(deps: ProcessAssembleChapterJobDeps): Promise<void> {
  const { prisma, storage, logger, envelope, queueManager, attemptsMade, maxAttempts } = deps;

  const processingJobId = envelope.entity_id;
  if (!processingJobId) {
    throw new Error('assemble_chapter envelope is missing entity_id (the ProcessingJob id)');
  }

  const job = await prisma.processingJob.findUnique({ where: { id: processingJobId } });
  if (!job) {
    throw new Error(`ProcessingJob ${processingJobId} not found`);
  }
  if (job.status === 'SUCCEEDED' || job.status === 'FAILED') {
    logger.info(
      { job_id: processingJobId, status: job.status },
      'Chapter assembly job already terminal; skipping redelivered message',
    );
    return;
  }
  if (!job.bookId) {
    throw new Error(`ProcessingJob ${processingJobId} has no bookId`);
  }

  const chapter = await prisma.chapter.findUnique({ where: { id: envelope.payload.chapter_id } });
  if (!chapter) {
    throw new Error(`Chapter ${envelope.payload.chapter_id} not found`);
  }

  const chunks = (await prisma.audioScriptChunk.findMany({
    where: { chapterId: chapter.id, isCurrent: true },
    orderBy: { chapterSequenceIndex: 'asc' },
    include: {
      currentAudioChunk: {
        select: {
          id: true,
          storageKey: true,
          contentHash: true,
          status: true,
          sampleRate: true,
          channels: true,
        },
      },
    },
  })) as unknown as OrderedChunk[];

  // --- Preconditions: completeness + single Director version. Both are checked BEFORE any
  // ffmpeg work or RUNNING transition — a foredoomed job should fail cheaply. ---
  const missing = chunks.filter(
    (c) => !c.currentAudioChunk || c.currentAudioChunk.status !== 'VALIDATED',
  );
  if (chunks.length === 0 || missing.length > 0) {
    await handleChapterManifestIncomplete({
      prisma,
      logger,
      job,
      missingChunkIds: chunks.length === 0 ? [chapter.id] : missing.map((c) => c.id),
      reason: chunks.length === 0 ? 'NO_SCRIPT_CHUNKS' : 'CHUNKS_MISSING_OR_NOT_VALIDATED',
    });
    return;
  }

  const directorVersions = new Set(chunks.map((c) => c.directorVersion));
  if (directorVersions.size > 1) {
    await handleDirectorVersionMixing({ prisma, logger, job, directorVersions: [...directorVersions] });
    return;
  }
  const directorVersion = chunks[0]!.directorVersion;

  const manifestParts = chunks.map((c) => `${c.currentAudioChunk!.id}:${c.currentAudioChunk!.contentHash}`);
  const chunkManifestHash = computeManifestHash(manifestParts);

  // --- Idempotency: an identical manifest was already assembled — no re-assembly, no re-upload. ---
  const existing = await prisma.chapterAudio.findFirst({
    where: { chapterId: chapter.id, chunkManifestHash, isPreviewBuild: false },
  });
  if (existing) {
    await withTransaction(prisma, async (tx) => {
      await tx.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'SUCCEEDED',
          statusChangedAt: new Date(),
          completedAt: new Date(),
          progress: 1,
          resultResourceType: 'chapter_audio',
          resultResourceId: existing.id,
          resultVersion: existing.version,
        },
      });
    });
    logger.info(
      { job_id: job.id, chapter_id: chapter.id, chapter_audio_id: existing.id },
      'Chapter assembly is a no-op: manifest unchanged since the last successful assembly',
    );
    await maybeTriggerAudiobookFanIn({ prisma, queueManager, logger, job });
    return;
  }

  const voiceConsistency = computeVoiceConsistency(chunks);
  const voiceConsistencyVerified = voiceConsistency.verified;

  // --- Freeze/mark-RUNNING transaction: the domain state change and its event, atomically. ---
  await withTransaction(prisma, async (tx) => {
    await tx.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'RUNNING',
        statusChangedAt: new Date(),
        startedAt: job.startedAt ?? new Date(),
        progressStage: 'ASSEMBLING',
        attemptCount: { increment: 1 },
      },
    });
    await writeOutboxMessage(tx, {
      eventType: 'chapter.assembly_started',
      schemaVersion: '1.0',
      tenantId: job.tenantId,
      bookId: job.bookId!,
      jobId: job.id,
      correlationId: job.correlationId,
      causationId: job.correlationId,
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      aggregateType: 'chapter',
      aggregateId: chapter.id,
      payload: {
        chapter_id: chapter.id,
        chunk_count: chunks.length,
        ordered_chunk_manifest_hash: chunkManifestHash,
      },
    });
  });

  try {
    const audioToolModelVersionId = await resolveAudioToolModelVersionId(prisma);

    const nextVersion =
      ((await prisma.chapterAudio.aggregate({ where: { chapterId: chapter.id }, _max: { version: true } }))
        ._max.version ?? 0) + 1;
    const versionedKey = buildStorageKey({
      tenantId: job.tenantId,
      segments: ['books', job.bookId!, 'chapters', chapter.id, 'audio', `v${nextVersion}.wav`],
    });

    // The master WAV is read and uploaded from WITHIN the temp-dir callback — `withTempDir`
    // removes the directory the instant its callback resolves, so reading `assembled.masterPath`
    // after this call returns would race a deleted file.
    const { assembled, putMeta } = await withTempDir(`assembly-chapter-${job.id}-`, async (dir) => {
      const assembled = await assembleChapterAudio({ storage, dir, tenantId: job.tenantId, chunks });
      const bytes = await readFile(assembled.masterPath);
      const putMeta = await storage.put({ key: versionedKey, body: bytes, contentType: 'audio/wav' });
      return { assembled, putMeta };
    });

    const chapterAudioId = generateId();
    await withTransaction(prisma, async (tx) => {
      await tx.chapterAudio.updateMany({
        where: { chapterId: chapter.id, isCurrent: true },
        data: { isCurrent: false, supersededAt: new Date() },
      });
      await tx.chapterAudio.create({
        data: {
          id: chapterAudioId,
          tenantId: job.tenantId,
          bookId: job.bookId!,
          chapterId: chapter.id,
          version: nextVersion,
          isCurrent: true,
          isPreviewBuild: false,
          status: 'ASSEMBLED',
          durationMs: assembled.durationMs,
          chunkCount: chunks.length,
          chunkManifestHash,
          format: 'WAV',
          integratedLufs: assembled.integratedLufs,
          truePeakDbtp: assembled.truePeakDbtp,
          validation: assembled.validation as Prisma.InputJsonValue,
          voiceConsistencyVerified,
          voiceConsistency: voiceConsistency.byCharacter as Prisma.InputJsonValue,
          directorVersion,
          pipelineVersion: ASSEMBLY_PIPELINE_VERSION,
          audioToolModelVersionId,
          assemblyVersion: MASTERING_POLICY_V1.version,
          jobId: job.id,
          storageKey: versionedKey,
          storageBucket: putMeta.bucket,
          contentHash: putMeta.checksum.hash,
          sizeBytes: BigInt(putMeta.sizeBytes),
          objectVerifiedAt: new Date(),
        },
      });
      await tx.chapterAudioMember.createMany({
        data: assembled.members.map((m) => ({
          chapterAudioId,
          orderIndex: m.orderIndex,
          audioChunkId: m.audioChunkId,
          bookId: job.bookId!,
          startMs: m.startMs,
          durationMs: m.durationMs,
          leadSilenceTrimmedMs: m.leadSilenceTrimmedMs,
          pauseAppliedMs: m.pauseAppliedMs,
        })),
      });
      await tx.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'SUCCEEDED',
          statusChangedAt: new Date(),
          completedAt: new Date(),
          progress: 1,
          progressStage: 'DONE',
          resultResourceType: 'chapter_audio',
          resultResourceId: chapterAudioId,
          resultVersion: nextVersion,
        },
      });
      await writeOutboxMessage(tx, {
        eventType: 'chapter.completed',
        schemaVersion: '1.0',
        tenantId: job.tenantId,
        bookId: job.bookId!,
        jobId: job.id,
        correlationId: job.correlationId,
        causationId: job.correlationId,
        producer: PRODUCER,
        producerVersion: PRODUCER_VERSION,
        aggregateType: 'chapter_audio',
        aggregateId: chapterAudioId,
        payload: {
          chapter_id: chapter.id,
          chapter_audio_id: chapterAudioId,
          version: nextVersion,
          duration_ms: assembled.durationMs,
          chunk_count: chunks.length,
          voice_consistency_verified: voiceConsistencyVerified,
          is_preview_build: false,
        },
      });
    });

    logger.info(
      {
        job_id: job.id,
        chapter_id: chapter.id,
        chapter_audio_id: chapterAudioId,
        version: nextVersion,
        duration_ms: assembled.durationMs,
        chunk_count: chunks.length,
      },
      'Chapter assembled',
    );

    await maybeTriggerAudiobookFanIn({ prisma, queueManager, logger, job });
  } catch (err) {
    await handleChapterAssemblyFailure({ prisma, logger, job, err, attemptsMade, maxAttempts });
    throw err; // let BullMQ's own retry/DLQ policy decide what happens next
  }
}

// ---------------------------------------------------------------- assembly pipeline ----

interface ChapterAudioMemberResult {
  audioChunkId: string;
  orderIndex: number;
  startMs: number;
  durationMs: number;
  leadSilenceTrimmedMs: number;
  pauseAppliedMs: number;
}

interface AssembledChapter {
  masterPath: string;
  durationMs: number;
  integratedLufs: number;
  truePeakDbtp: number;
  members: ChapterAudioMemberResult[];
  validation: Record<string, unknown>;
}

async function assembleChapterAudio(args: {
  storage: StorageProvider;
  dir: string;
  tenantId: string;
  chunks: OrderedChunk[];
}): Promise<AssembledChapter> {
  const { storage, dir, chunks } = args;
  const { canonicalSampleRateHz: sampleRate, canonicalChannels: channels } = MASTERING_POLICY_V1;
  const loudnessTarget = {
    integratedLufs: MASTERING_POLICY_V1.integratedLoudnessTargetLufs,
    truePeakCeilingDbtp: MASTERING_POLICY_V1.truePeakCeilingDbtp,
    loudnessRange: MASTERING_POLICY_V1.loudnessRangeTarget,
  };

  const members: ChapterAudioMemberResult[] = [];
  const chunkFinalPaths: string[] = [];
  let cumulativeMs = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const audioChunk = chunk.currentAudioChunk!;
    const rawPath = join(dir, `chunk-${i}-raw.wav`);
    await downloadToFile(storage, audioChunk.storageKey, rawPath);

    // 1. Detect + trim ONLY leading/trailing engine-emitted silence — never mid-utterance
    // silence, which is `AudioScriptChunk.pauses`' job (applied explicitly below).
    const probed = await probeAudio(rawPath);
    const silences = await detectSilence(rawPath, SILENCE_TRIM_POLICY_V1);
    const { trimStartSec, trimEndSec, leadTrimmedMs } = computeLeadTrailTrim(
      silences,
      probed.durationMs / 1000,
    );

    const conformedPath = join(dir, `chunk-${i}-conformed.wav`);
    await trimAndConvert(rawPath, conformedPath, {
      startSec: trimStartSec,
      endSec: trimEndSec,
      sampleRate,
      channels,
    });

    // 2. Light single-pass pre-normalization so chunk-to-chunk joins don't jump — NOT the
    // authoritative master (that's the two-pass loudnorm run once over the whole chapter below).
    const prenormPath = join(dir, `chunk-${i}-prenorm.wav`);
    await applySinglePassLoudnorm(conformedPath, prenormPath, loudnessTarget, { sampleRate, channels });

    // 3. Apply this chunk's own LEADING/TRAILING pauses (Director-authored silence, distinct
    // from the engine dead-air trimmed above) as literal silence prepended/appended.
    const leadingPauseMs = sumPauseMs(chunk.pauses, 'LEADING');
    const trailingPauseMs = sumPauseMs(chunk.pauses, 'TRAILING');
    const pieces: string[] = [];
    if (leadingPauseMs > 0) {
      const leadSilencePath = join(dir, `chunk-${i}-lead-pause.wav`);
      await generateSilenceFile(leadSilencePath, { durationMs: leadingPauseMs, sampleRate, channels });
      pieces.push(leadSilencePath);
    }
    pieces.push(prenormPath);
    if (trailingPauseMs > 0) {
      const trailSilencePath = join(dir, `chunk-${i}-trail-pause.wav`);
      await generateSilenceFile(trailSilencePath, { durationMs: trailingPauseMs, sampleRate, channels });
      pieces.push(trailSilencePath);
    }

    const chunkFinalPath = join(dir, `chunk-${i}-final.wav`);
    if (pieces.length === 1) {
      await trimAndConvert(pieces[0]!, chunkFinalPath, { sampleRate, channels });
    } else {
      const listPath = join(dir, `chunk-${i}-list.txt`);
      await writeConcatFileList(listPath, pieces);
      await concatDemuxCopy(listPath, chunkFinalPath);
    }

    const finalProbe = await probeAudio(chunkFinalPath);
    members.push({
      audioChunkId: audioChunk.id,
      orderIndex: i,
      startMs: cumulativeMs,
      durationMs: finalProbe.durationMs,
      leadSilenceTrimmedMs: leadTrimmedMs,
      pauseAppliedMs: leadingPauseMs + trailingPauseMs,
    });
    cumulativeMs += finalProbe.durationMs;
    chunkFinalPaths.push(chunkFinalPath);
  }

  // 4. Concatenate every per-chunk final file (concat demuxer, `-c copy` — every piece is
  // already conformed to the canonical PCM WAV format, so this is lossless and cheap).
  const chapterListPath = join(dir, 'chapter-list.txt');
  await writeConcatFileList(chapterListPath, chunkFinalPaths);
  const preMasterPath = join(dir, 'chapter-premaster.wav');
  await concatDemuxCopy(chapterListPath, preMasterPath);

  // 5. Authoritative two-pass loudnorm + alimiter safety ceiling over the WHOLE chapter.
  const masterPath = join(dir, 'chapter-master.wav');
  await applyTwoPassLoudnorm(preMasterPath, masterPath, loudnessTarget, { sampleRate, channels });

  // 6. Validate: decodability/duration, independent ebur128 re-measurement, clipping, and a
  // diagnostic (never job-blocking) noise-floor flag.
  const finalProbe = await probeAudio(masterPath);
  const ebur128 = await measureEbur128(masterPath);
  const clipping = await measureClipping(masterPath);
  if (clipping.clippedSamples > 0) {
    throw new Error(
      `Post-mastering clipping detected (${clipping.clippedSamples} clipped samples, peak ${clipping.peakDbfs}dBFS) — the alimiter safety ceiling should prevent this; treating as a pipeline defect rather than shipping a clipped chapter.`,
    );
  }

  const validation: Record<string, unknown> = {
    decodable: true,
    duration_ms: finalProbe.durationMs,
    clipped_samples: clipping.clippedSamples,
    peak_dbfs: clipping.peakDbfs,
  };
  const noiseFloorDb = await measureNoiseFloorDuringSilence(masterPath, { sampleRate, channels }, dir);
  if (noiseFloorDb !== null) {
    validation.measured_noise_floor_db_rms = noiseFloorDb;
    if (noiseFloorDb > MASTERING_POLICY_V1.noiseFloorFlagThresholdDbRms) {
      validation.noise_floor_flag = true;
    }
  }

  return {
    masterPath,
    durationMs: finalProbe.durationMs,
    integratedLufs: ebur128.integratedLufs,
    truePeakDbtp: ebur128.truePeakDbtp,
    members,
    validation,
  };
}

/** Diagnostic-only noise-floor estimate: RMS of the single longest detected near-silence interval (a looser threshold than the leading/trailing trim pass, so it also catches Director-authored pauses), never the whole track's RMS (which is dominated by speech level and would always exceed -60dB). Returns `null` when no silence interval was found at all. */
async function measureNoiseFloorDuringSilence(
  masterPath: string,
  opts: { sampleRate: number; channels: number },
  dir: string,
): Promise<number | null> {
  const intervals = await detectSilence(masterPath, { thresholdDb: -35, minDurationSec: 0.5 });
  if (intervals.length === 0) return null;
  const longest = intervals.reduce<SilenceInterval | null>((best, iv) => {
    const end = iv.endSec ?? Number.POSITIVE_INFINITY;
    const dur = end - iv.startSec;
    if (!best) return iv;
    const bestEnd = best.endSec ?? Number.POSITIVE_INFINITY;
    return dur > bestEnd - best.startSec ? iv : best;
  }, null);
  if (!longest) return null;
  const clipPath = join(dir, 'noise-floor-sample.wav');
  await trimAndConvert(masterPath, clipPath, {
    startSec: longest.startSec,
    endSec: longest.endSec ?? undefined,
    sampleRate: opts.sampleRate,
    channels: opts.channels,
  });
  return measureOverallRmsDb(clipPath);
}

function computeLeadTrailTrim(
  intervals: SilenceInterval[],
  totalDurationSec: number,
): { trimStartSec: number | undefined; trimEndSec: number | undefined; leadTrimmedMs: number } {
  const EPSILON_SEC = 0.05;
  let trimStartSec: number | undefined;
  let leadTrimmedMs = 0;
  const first = intervals[0];
  if (first && first.startSec <= EPSILON_SEC && first.endSec !== null && first.endSec < totalDurationSec) {
    trimStartSec = first.endSec;
    leadTrimmedMs = Math.round(first.endSec * 1000);
  }

  let trimEndSec: number | undefined;
  const last = intervals.at(-1);
  if (last) {
    const lastEnd = last.endSec ?? totalDurationSec;
    if (
      lastEnd >= totalDurationSec - EPSILON_SEC &&
      last.startSec > (trimStartSec ?? 0) + EPSILON_SEC
    ) {
      trimEndSec = last.startSec;
    }
  }

  return { trimStartSec, trimEndSec, leadTrimmedMs };
}

interface ChunkPauseJson {
  position: 'LEADING' | 'TRAILING' | 'OFFSET';
  duration_ms: number;
}

function sumPauseMs(pauses: unknown, position: 'LEADING' | 'TRAILING'): number {
  if (!Array.isArray(pauses)) return 0;
  let total = 0;
  for (const raw of pauses) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Partial<ChunkPauseJson>;
    if (p.position === position && typeof p.duration_ms === 'number') {
      total += p.duration_ms;
    }
  }
  return total;
}

interface VoiceConsistencyResult {
  verified: boolean;
  /** character_id ('NARRATOR' for unassigned/narrator lines) -> distinct voiceProfileVersionIds used. More than one entry for a character is the inconsistency. */
  byCharacter: Record<string, string[]>;
}

/**
 * A simple internal-consistency check, not a deep audio analysis (per task
 * scope): every chunk sharing a `characterId` within this chapter must be
 * pinned to the same `voiceProfileVersionId`. The full per-character mapping
 * is kept (not just the boolean) so `ChapterAudio.voiceConsistency` is
 * useful for debugging a `false` result, not just a flag.
 */
function computeVoiceConsistency(chunks: OrderedChunk[]): VoiceConsistencyResult {
  const byCharacter = new Map<string, Set<string>>();
  for (const c of chunks) {
    if (!c.voiceProfileVersionId) continue;
    const key = c.characterId ?? 'NARRATOR';
    const set = byCharacter.get(key) ?? new Set<string>();
    set.add(c.voiceProfileVersionId);
    byCharacter.set(key, set);
  }
  const byCharacterRecord: Record<string, string[]> = {};
  for (const [key, set] of byCharacter) byCharacterRecord[key] = [...set];
  return {
    verified: [...byCharacter.values()].every((set) => set.size <= 1),
    byCharacter: byCharacterRecord,
  };
}

async function downloadToFile(storage: StorageProvider, key: string, destPath: string): Promise<void> {
  const { body } = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
  }
  await writeFile(destPath, Buffer.concat(chunks));
}

// ---------------------------------------------------------------- fan-in trigger ----

/**
 * The DB-query-driven fan-in trigger (event-contracts.md §31.2: never
 * subscribe to a count of `chapter.completed` events — query the database).
 * Called after EVERY successful (including no-op/idempotent) chapter
 * assembly. Fires `assemble_audiobook` only when:
 *   1. The originating assembly request's scope was `AUDIOBOOK`, not a lone
 *      `CHAPTERS` re-assembly — carried on `ProcessingJob.scope` (see
 *      `readJobScope` in assembly-shared.ts; this worker does not control
 *      the API module that sets it, so an absent/malformed scope is read as
 *      "do nothing", never assumed to be AUDIOBOOK).
 *   2. `checkAudiobookReadiness` finds every current Chapter of the book's
 *      current BookVersion has a current ASSEMBLED ChapterAudio.
 *   3. No `assemble_audiobook` ProcessingJob is already in flight.
 *
 * This is intentionally NOT perfectly race-free: two chapters finishing
 * within milliseconds of each other could both observe "ready" and both
 * pass the in-flight check before either job row commits, producing two
 * `assemble_audiobook` ProcessingJob rows. That's accepted, not a bug — the
 * audiobook handler's own `chapterManifestHash`-keyed idempotency check
 * (assembly-audiobook.ts) makes the second one a no-op that does no
 * redundant work, which is exactly the "idempotent, self-healing" property
 * §31.2 asks fan-in checks to have.
 */
async function maybeTriggerAudiobookFanIn(args: {
  prisma: PrismaClient;
  queueManager: QueueManager;
  logger: Logger;
  job: ProcessingJob;
}): Promise<void> {
  const { prisma, queueManager, logger, job } = args;
  if (!job.bookId) return;

  const scope = readJobScope(job.scope);
  if (scope?.scope !== 'AUDIOBOOK') return;

  const readiness = await checkAudiobookReadiness(prisma, job.bookId);
  if (!readiness.ready || !readiness.bookVersionId) return;

  const inFlight = await prisma.processingJob.findFirst({
    where: {
      bookId: job.bookId,
      type: 'assemble_audiobook',
      status: { in: ['CREATED', 'QUEUED', 'RUNNING', 'RETRYING', 'BLOCKED'] },
    },
  });
  if (inFlight) return;

  const deliveryFormats = scope.delivery_formats?.length ? scope.delivery_formats : ['M4B'];
  const newJobId = generateId();
  const now = new Date();
  // Built once: persisted on the row and reused by the dispatch below, so an
  // orphaned fan-in job can be recovered by ProcessingJobSweeper (F-4).
  const envelope = {
    job_id: newJobId,
    entity_id: newJobId,
    correlation_id: job.correlationId,
    tenant_id: job.tenantId,
    payload: { book_id: job.bookId, delivery_formats: deliveryFormats },
  };

  await prisma.processingJob.create({
    data: {
      id: newJobId,
      tenantId: job.tenantId,
      bookId: job.bookId,
      type: 'assemble_audiobook',
      queue: 'audio',
      priority: job.priority,
      relatedResourceType: 'book_version',
      relatedResourceId: readiness.bookVersionId,
      scope: { scope: 'AUDIOBOOK', delivery_formats: deliveryFormats } as Prisma.InputJsonValue,
      status: 'CREATED',
      statusChangedAt: now,
      maxAttempts: 3,
      idempotencyKey: `assemble_audiobook:${readiness.bookVersionId}`,
      idempotencyFingerprint: readiness.bookVersionId,
      correlationId: job.correlationId,
      createdByUserId: job.createdByUserId,
      dispatchEnvelope: envelope,
    },
  });

  await enqueueProcessingJob(prisma, queueManager, {
    processingJobId: newJobId,
    queue: 'audio',
    envelope,
    jobName: 'assemble_audiobook',
    maxAttempts: 3,
  });

  logger.info(
    { book_id: job.bookId, job_id: newJobId, book_version_id: readiness.bookVersionId },
    'Auto-triggered assemble_audiobook: every chapter is now ASSEMBLED',
  );
}

// ---------------------------------------------------------------- failure handlers ----

async function handleChapterManifestIncomplete(args: {
  prisma: PrismaClient;
  logger: Logger;
  job: ProcessingJob;
  missingChunkIds: string[];
  reason: string;
}): Promise<void> {
  const { prisma, logger, job, missingChunkIds, reason } = args;
  await withTransaction(prisma, async (tx: Tx) => {
    const current = await tx.processingJob.findUnique({ where: { id: job.id } });
    if (!current || current.status === 'FAILED' || current.status === 'SUCCEEDED') return;
    const now = new Date();
    await tx.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        statusChangedAt: now,
        completedAt: now,
        errorCode: 'CHAPTER_MANIFEST_INCOMPLETE',
        errorClass: 'ConflictError',
        errorMessage: `Chapter manifest incomplete: ${missingChunkIds.length} chunk(s) missing or not VALIDATED (${reason}).`,
        errorRetryable: false,
        errorTerminal: true,
      },
    });
    await writeOutboxMessage(tx, {
      eventType: 'job.failed',
      schemaVersion: '1.0',
      tenantId: job.tenantId,
      bookId: job.bookId ?? undefined,
      jobId: job.id,
      correlationId: job.correlationId,
      causationId: job.correlationId,
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      aggregateType: 'processing_job',
      aggregateId: job.id,
      payload: {
        job_id: job.id,
        error_code: 'CHAPTER_MANIFEST_INCOMPLETE',
        error_class: 'ConflictError',
        failing_precondition: reason,
        missing_chunk_ids: missingChunkIds.slice(0, 20),
      },
    });
  });
  logger.info(
    { job_id: job.id, missing_count: missingChunkIds.length, reason },
    'Chapter assembly blocked: manifest incomplete — no ChapterAudio row created',
  );
}

async function handleDirectorVersionMixing(args: {
  prisma: PrismaClient;
  logger: Logger;
  job: ProcessingJob;
  directorVersions: string[];
}): Promise<void> {
  const { prisma, logger, job, directorVersions } = args;
  await withTransaction(prisma, async (tx: Tx) => {
    const current = await tx.processingJob.findUnique({ where: { id: job.id } });
    if (!current || current.status === 'FAILED' || current.status === 'SUCCEEDED') return;
    const now = new Date();
    await tx.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        statusChangedAt: now,
        completedAt: now,
        errorCode: 'DIRECTOR_VERSION_MIXING_FORBIDDEN',
        errorClass: 'ConflictError',
        errorMessage: `Chapter's chunks span multiple Director versions: ${directorVersions.join(', ')}.`,
        errorRetryable: false,
        errorTerminal: true,
      },
    });
    await writeOutboxMessage(tx, {
      eventType: 'job.failed',
      schemaVersion: '1.0',
      tenantId: job.tenantId,
      bookId: job.bookId ?? undefined,
      jobId: job.id,
      correlationId: job.correlationId,
      causationId: job.correlationId,
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      aggregateType: 'processing_job',
      aggregateId: job.id,
      payload: {
        job_id: job.id,
        error_code: 'DIRECTOR_VERSION_MIXING_FORBIDDEN',
        error_class: 'ConflictError',
        failing_precondition: 'SINGLE_DIRECTOR_VERSION',
      },
    });
  });
  logger.info(
    { job_id: job.id, director_versions: directorVersions },
    'Chapter assembly blocked: Director version mixing forbidden',
  );
}

async function handleChapterAssemblyFailure(args: {
  prisma: PrismaClient;
  logger: Logger;
  job: ProcessingJob;
  err: unknown;
  attemptsMade: number;
  maxAttempts: number;
}): Promise<void> {
  const { prisma, logger, job, err, attemptsMade, maxAttempts } = args;
  const isFinalAttempt = attemptsMade + 1 >= maxAttempts;

  if (!isFinalAttempt) {
    logger.info(
      { job_id: job.id, error: errorMessage(err), attempts_made: attemptsMade },
      'Chapter assembly attempt failed; will retry',
    );
    return;
  }

  const now = new Date();
  await withTransaction(prisma, async (tx: Tx) => {
    const current = await tx.processingJob.findUnique({ where: { id: job.id } });
    if (!current || current.status === 'FAILED') return;
    await tx.processingJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        statusChangedAt: now,
        completedAt: now,
        errorCode: errorCodeOf(err, 'CHAPTER_ASSEMBLY_FAILED'),
        errorClass: errorClassOf(err),
        errorMessage: errorMessage(err),
        errorRetryable: false,
        errorTerminal: true,
      },
    });
    await writeOutboxMessage(tx, {
      eventType: 'job.failed',
      schemaVersion: '1.0',
      tenantId: job.tenantId,
      bookId: job.bookId ?? undefined,
      jobId: job.id,
      correlationId: job.correlationId,
      causationId: job.correlationId,
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      aggregateType: 'processing_job',
      aggregateId: job.id,
      payload: {
        job_id: job.id,
        error_code: errorCodeOf(err, 'CHAPTER_ASSEMBLY_FAILED'),
        error_class: errorClassOf(err),
        failing_precondition: 'ASSEMBLY_PIPELINE_ERROR',
      },
    });
  });
  logger.info(
    { job_id: job.id, error: errorMessage(err), final_attempt: isFinalAttempt },
    'Chapter assembly job failed terminally',
  );
}
