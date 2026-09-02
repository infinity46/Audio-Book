/**
 * Consumes the `encode_delivery_format` command: encodes the book-level
 * master WAV (produced by `processAssembleAudiobookJob`) into one requested
 * delivery format (`M4B` AAC/MP4 with embedded chapters + cover art, `M4A`
 * AAC/MP4, or `MP3_PER_CHAPTER` — one CBR MP3 per chapter). Re-opens every
 * encoded artifact with ffprobe and verifies it before persisting it as
 * `READY` — an artifact that fails verification is never published.
 *
 * `Audiobook.status → 'READY'` happens ONLY here, and only once every
 * originally-requested delivery format has a `READY` rendition — this is
 * the sole atomic-publication gate (never set anywhere else). A retry for
 * one failed/missing format never touches an already-`READY` rendition or
 * re-does chapter/book-master assembly (verified by construction: the
 * idempotency check below is what makes a retry against an already-`READY`
 * format a clean no-op).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient, Tx } from '@audio-book/database';
import { withTransaction } from '@audio-book/database';
import type { Audiobook, AudiobookChapter, ProcessingJob } from '@prisma/client';
import { generateId, writeOutboxMessage } from '@audio-book/events';
import type { Logger } from '@audio-book/logging';
import type { QueueJobEnvelope } from '@audio-book/queue';
import { buildStorageKey, type StorageProvider } from '@audio-book/storage';
import {
  buildFfmetadataChapters,
  encodeAac,
  encodeMp3,
  probeAudio,
  probeChapters,
  runFfprobe,
  trimAndConvert,
} from '../lib/ffmpeg.js';
import { MASTERING_POLICY_V1, PACKAGING_POLICY_V1 } from '../lib/mastering-policy.js';
import type { AudiobookRenditionStatus } from '../lib/audiobook-rendition-status.js';
import {
  PRODUCER,
  PRODUCER_VERSION,
  errorClassOf,
  errorCodeOf,
  errorMessage,
  resolveAudioToolModelVersionId,
  resolveRequestedDeliveryFormats,
  withTempDir,
} from './assembly-shared.js';

export type DeliveryFormatName = 'M4B' | 'M4A' | 'MP3_PER_CHAPTER';

export interface EncodeDeliveryFormatCommandPayload {
  audiobook_id: string;
  format: DeliveryFormatName;
}

export interface ProcessEncodeDeliveryFormatJobDeps {
  prisma: PrismaClient;
  storage: StorageProvider;
  logger: Logger;
  envelope: QueueJobEnvelope<EncodeDeliveryFormatCommandPayload>;
  attemptsMade: number;
  maxAttempts: number;
}

/** ~40ms — one PCM sample block of slop for float-duration/rounding differences across probes. */
const DURATION_TOLERANCE_MS = 75;
const CHAPTER_MARKER_TOLERANCE_MS = 75;

export async function processEncodeDeliveryFormatJob(
  deps: ProcessEncodeDeliveryFormatJobDeps,
): Promise<void> {
  const { prisma, storage, logger, envelope, attemptsMade, maxAttempts } = deps;

  const processingJobId = envelope.entity_id;
  if (!processingJobId) {
    throw new Error('encode_delivery_format envelope is missing entity_id (the ProcessingJob id)');
  }

  const job = await prisma.processingJob.findUnique({ where: { id: processingJobId } });
  if (!job) {
    throw new Error(`ProcessingJob ${processingJobId} not found`);
  }
  if (job.status === 'SUCCEEDED' || job.status === 'FAILED') {
    logger.info(
      { job_id: processingJobId, status: job.status },
      'Encode job already terminal; skipping redelivered message',
    );
    return;
  }

  const format = envelope.payload.format;
  const audiobook = await prisma.audiobook.findUnique({
    where: { id: envelope.payload.audiobook_id },
  });
  if (!audiobook) {
    throw new Error(`Audiobook ${envelope.payload.audiobook_id} not found`);
  }
  if (!audiobook.storageKey) {
    // Programming error: assemble_audiobook must always populate the book-level master's
    // storage fields before an encode_delivery_format job can exist for it.
    throw new Error(`Audiobook ${audiobook.id} has no book-level master storage key`);
  }

  const chapterCount = audiobook.chapterCount;

  // --- Idempotency: this exact format is already READY under the current packaging policy. ---
  if (await isFormatFullyReady(prisma, audiobook.id, format, chapterCount)) {
    await withTransaction(prisma, async (tx: Tx) => {
      await tx.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'SUCCEEDED',
          statusChangedAt: new Date(),
          completedAt: new Date(),
          progress: 1,
          resultResourceType: 'audiobook',
          resultResourceId: audiobook.id,
          resultVersion: audiobook.version,
        },
      });
    });
    logger.info(
      { job_id: job.id, audiobook_id: audiobook.id, format },
      'Encode is a no-op: this format is already READY under the current packaging policy',
    );
    await maybePublishAudiobook({ prisma, logger, job, audiobook });
    return;
  }

  await prisma.processingJob.update({
    where: { id: job.id },
    data: {
      status: 'RUNNING',
      statusChangedAt: new Date(),
      startedAt: job.startedAt ?? new Date(),
      progressStage: 'ENCODING',
      attemptCount: { increment: 1 },
    },
  });

  try {
    const audioToolModelVersionId = await resolveAudioToolModelVersionId(prisma);
    const chapters = await prisma.audiobookChapter.findMany({
      where: { audiobookId: audiobook.id },
      orderBy: { orderIndex: 'asc' },
    });

    await withTempDir(`encode-${job.id}-`, async (dir) => {
      const masterPath = join(dir, 'master.wav');
      await downloadToFile(storage, audiobook.storageKey, masterPath);

      if (format === 'MP3_PER_CHAPTER') {
        await encodeMp3PerChapter({
          prisma,
          storage,
          dir,
          masterPath,
          audiobook,
          chapters,
          audioToolModelVersionId,
        });
      } else {
        await encodeSingleFileFormat({
          prisma,
          storage,
          dir,
          masterPath,
          audiobook,
          chapters,
          format,
          audioToolModelVersionId,
        });
      }
    });

    await withTransaction(prisma, async (tx: Tx) => {
      await tx.processingJob.update({
        where: { id: job.id },
        data: {
          status: 'SUCCEEDED',
          statusChangedAt: new Date(),
          completedAt: new Date(),
          progress: 1,
          progressStage: 'DONE',
          resultResourceType: 'audiobook',
          resultResourceId: audiobook.id,
          resultVersion: audiobook.version,
        },
      });
    });

    logger.info({ job_id: job.id, audiobook_id: audiobook.id, format }, 'Delivery format encoded');
    await maybePublishAudiobook({ prisma, logger, job, audiobook });
  } catch (err) {
    await handleEncodeFailure({ prisma, logger, job, audiobook, format, err, attemptsMade, maxAttempts });
    throw err;
  }
}

// ---------------------------------------------------------------- single-file formats (M4B/M4A) ----

async function encodeSingleFileFormat(args: {
  prisma: PrismaClient;
  storage: StorageProvider;
  dir: string;
  masterPath: string;
  audiobook: Audiobook;
  chapters: AudiobookChapter[];
  format: 'M4B' | 'M4A';
  audioToolModelVersionId: string;
}): Promise<void> {
  const { prisma, storage, dir, masterPath, audiobook, chapters, format, audioToolModelVersionId } = args;

  const metadataArgs = buildMetadataArgs(audiobook);
  let ffmetadataPath: string | undefined;
  if (chapters.length > 0) {
    const ffmetadata = buildFfmetadataChapters(
      { title: audiobook.metadataTitle, artist: audiobook.metadataAuthor ?? '', album: audiobook.metadataTitle },
      chapters.map((c) => ({ title: c.title, startMs: c.startMs, endMs: c.startMs + c.durationMs })),
    );
    ffmetadataPath = join(dir, 'chapters.ffmetadata.txt');
    await writeFile(ffmetadataPath, ffmetadata, 'utf8');
  }

  // Cover art is embedded for M4B only (plan's call: "no attached_pic requirement necessarily"
  // for M4A) — kept consistent with M4B's other tagging, just without the extra binary stream.
  let coverPath: string | undefined;
  if (format === 'M4B' && audiobook.audiobookCoverId) {
    const cover = await prisma.audiobookCover.findUnique({ where: { id: audiobook.audiobookCoverId } });
    if (cover) {
      coverPath = join(dir, `cover.${extensionForMimeType(cover.mimeType)}`);
      await downloadToFile(storage, cover.storageKey, coverPath);
    }
  }

  const outputExt = format === 'M4B' ? 'm4b' : 'm4a';
  const outputPath = join(dir, `output.${outputExt}`);
  const bitrateKbps =
    format === 'M4B' ? PACKAGING_POLICY_V1.m4bAacBitrateKbps : PACKAGING_POLICY_V1.m4aAacBitrateKbps;

  await encodeAac(masterPath, outputPath, {
    bitrateKbps,
    sampleRate: PACKAGING_POLICY_V1.deliverySampleRateHz,
    channels: MASTERING_POLICY_V1.canonicalChannels,
    metadataArgs,
    ffmetadataPath,
    coverPath,
  });

  // --- Verify before persisting as READY. ---
  const expectedDurationMs = audiobook.durationMs;
  const probed = await probeAudio(outputPath);
  if (Math.abs(probed.durationMs - expectedDurationMs) > DURATION_TOLERANCE_MS) {
    throw new Error(
      `${format} duration mismatch: expected ~${expectedDurationMs}ms, got ${probed.durationMs}ms`,
    );
  }
  if (chapters.length > 0) {
    const probedChapters = await probeChapters(outputPath);
    verifyChapterMarkers(probedChapters, chapters);
  }
  const tags = await probeFormatTags(outputPath);
  if (normalizeTag(getTag(tags, 'title')) !== normalizeTag(audiobook.metadataTitle)) {
    throw new Error(`${format} metadata verification failed: title tag did not round-trip`);
  }
  if (coverPath) {
    const hasArt = await probeHasAttachedPic(outputPath);
    if (!hasArt) {
      throw new Error(`${format} verification failed: expected embedded cover art, found none`);
    }
  }

  const bytes = await readFile(outputPath);
  const versionedKey = buildStorageKey({
    tenantId: audiobook.tenantId,
    segments: ['books', audiobook.bookId, 'audiobook', `v${audiobook.version}`, `${outputExt}`, `delivery.${outputExt}`],
  });
  const putMeta = await storage.put({
    key: versionedKey,
    body: bytes,
    contentType: format === 'M4B' ? 'audio/mp4' : 'audio/mp4',
  });

  await upsertRendition(prisma, {
    audiobook,
    format,
    chapterId: null,
    bitrateKbps,
    sampleRate: PACKAGING_POLICY_V1.deliverySampleRateHz,
    channels: MASTERING_POLICY_V1.canonicalChannels,
    durationMs: probed.durationMs,
    audioToolModelVersionId,
    status: 'READY',
    storageKey: versionedKey,
    storageBucket: putMeta.bucket,
    contentHash: putMeta.checksum.hash,
    sizeBytes: BigInt(putMeta.sizeBytes),
  });
}

// ---------------------------------------------------------------- MP3_PER_CHAPTER ----

async function encodeMp3PerChapter(args: {
  prisma: PrismaClient;
  storage: StorageProvider;
  dir: string;
  masterPath: string;
  audiobook: Audiobook;
  chapters: AudiobookChapter[];
  audioToolModelVersionId: string;
}): Promise<void> {
  const { prisma, storage, dir, masterPath, audiobook, chapters, audioToolModelVersionId } = args;

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;

    // Per-chapter resumability: skip any chapter that's already READY under the current
    // packaging policy, so a retry of MP3_PER_CHAPTER doesn't re-encode chapters that already
    // succeeded on a prior attempt.
    const existing = await prisma.audiobookRendition.findFirst({
      where: { audiobookId: audiobook.id, format: 'MP3_PER_CHAPTER', chapterId: chapter.chapterId, status: 'READY' },
    });
    if (existing && matchesCurrentPolicy(existing.encodeParams)) continue;

    const clipPath = join(dir, `chapter-${i}.wav`);
    await trimAndConvert(masterPath, clipPath, {
      startSec: chapter.startMs / 1000,
      endSec: (chapter.startMs + chapter.durationMs) / 1000,
      sampleRate: MASTERING_POLICY_V1.canonicalSampleRateHz,
      channels: MASTERING_POLICY_V1.canonicalChannels,
    });

    const outputPath = join(dir, `chapter-${i}.mp3`);
    await encodeMp3(clipPath, outputPath, {
      bitrateKbps: PACKAGING_POLICY_V1.mp3BitrateKbps,
      sampleRate: PACKAGING_POLICY_V1.deliverySampleRateHz,
      metadataArgs: buildMetadataArgs(audiobook, chapter.title ?? undefined, i + 1),
    });

    const probed = await probeAudio(outputPath);
    if (Math.abs(probed.durationMs - chapter.durationMs) > DURATION_TOLERANCE_MS) {
      throw new Error(
        `MP3_PER_CHAPTER duration mismatch for chapter ${chapter.chapterId}: expected ~${chapter.durationMs}ms, got ${probed.durationMs}ms`,
      );
    }

    const bytes = await readFile(outputPath);
    const versionedKey = buildStorageKey({
      tenantId: audiobook.tenantId,
      segments: [
        'books',
        audiobook.bookId,
        'audiobook',
        `v${audiobook.version}`,
        'mp3',
        `chapter-${String(i + 1).padStart(4, '0')}.mp3`,
      ],
    });
    const putMeta = await storage.put({ key: versionedKey, body: bytes, contentType: 'audio/mpeg' });

    await upsertRendition(prisma, {
      audiobook,
      format: 'MP3_PER_CHAPTER',
      chapterId: chapter.chapterId,
      bitrateKbps: PACKAGING_POLICY_V1.mp3BitrateKbps,
      sampleRate: PACKAGING_POLICY_V1.deliverySampleRateHz,
      channels: MASTERING_POLICY_V1.canonicalChannels,
      durationMs: probed.durationMs,
      audioToolModelVersionId,
      status: 'READY',
      storageKey: versionedKey,
      storageBucket: putMeta.bucket,
      contentHash: putMeta.checksum.hash,
      sizeBytes: BigInt(putMeta.sizeBytes),
    });
  }
}

// ---------------------------------------------------------------- shared helpers ----

function buildMetadataArgs(
  audiobook: { metadataTitle: string; metadataAuthor: string | null },
  chapterTitle?: string,
  trackNumber?: number,
): string[] {
  const args: string[] = ['-metadata', `title=${chapterTitle ?? audiobook.metadataTitle}`];
  if (audiobook.metadataAuthor) {
    args.push('-metadata', `artist=${audiobook.metadataAuthor}`);
  }
  args.push('-metadata', `album=${audiobook.metadataTitle}`);
  if (trackNumber !== undefined) {
    args.push('-metadata', `track=${trackNumber}`);
  }
  return args;
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  return 'jpg';
}

async function probeFormatTags(path: string): Promise<Record<string, string>> {
  const { stdout } = await runFfprobe(['-v', 'error', '-print_format', 'json', '-show_format', path]);
  const parsed = JSON.parse(stdout) as { format?: { tags?: Record<string, string> } };
  return parsed.format?.tags ?? {};
}

function getTag(tags: Record<string, string>, key: string): string | undefined {
  const lowerKey = key.toLowerCase();
  for (const [k, v] of Object.entries(tags)) {
    if (k.toLowerCase() === lowerKey) return v;
  }
  return undefined;
}

function normalizeTag(value: string | undefined): string {
  return (value ?? '').trim();
}

async function probeHasAttachedPic(path: string): Promise<boolean> {
  const { stdout } = await runFfprobe(['-v', 'error', '-print_format', 'json', '-show_streams', path]);
  const parsed = JSON.parse(stdout) as {
    streams?: { codec_type?: string; disposition?: Record<string, number> }[];
  };
  return (parsed.streams ?? []).some(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1,
  );
}

function verifyChapterMarkers(
  probed: { startMs: number; endMs: number; title: string | null }[],
  expected: AudiobookChapter[],
): void {
  if (probed.length !== expected.length) {
    throw new Error(
      `M4B chapter marker count mismatch: expected ${expected.length}, got ${probed.length}`,
    );
  }
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i]!;
    const got = probed[i]!;
    if (Math.abs(got.startMs - exp.startMs) > CHAPTER_MARKER_TOLERANCE_MS) {
      throw new Error(
        `M4B chapter ${i} start mismatch: expected ${exp.startMs}ms, got ${got.startMs}ms`,
      );
    }
    const expectedEnd = exp.startMs + exp.durationMs;
    if (Math.abs(got.endMs - expectedEnd) > CHAPTER_MARKER_TOLERANCE_MS) {
      throw new Error(`M4B chapter ${i} end mismatch: expected ${expectedEnd}ms, got ${got.endMs}ms`);
    }
  }
}

interface UpsertRenditionArgs {
  audiobook: Audiobook;
  format: DeliveryFormatName;
  chapterId: string | null;
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  durationMs: number;
  audioToolModelVersionId: string;
  status: AudiobookRenditionStatus;
  storageKey: string;
  storageBucket: string;
  contentHash: string;
  sizeBytes: bigint;
}

async function upsertRendition(prisma: PrismaClient, args: UpsertRenditionArgs): Promise<void> {
  const {
    audiobook,
    format,
    chapterId,
    bitrateKbps,
    sampleRate,
    channels,
    durationMs,
    audioToolModelVersionId,
    status,
    storageKey,
    storageBucket,
    contentHash,
    sizeBytes,
  } = args;

  const existing = await prisma.audiobookRendition.findFirst({
    where: { audiobookId: audiobook.id, format: format as never, chapterId },
  });

  const data = {
    tenantId: audiobook.tenantId,
    bookId: audiobook.bookId,
    audiobookId: audiobook.id,
    format: format as never,
    chapterId,
    bitrateKbps,
    sampleRate,
    channels,
    durationMs,
    audioToolModelVersionId,
    encodeParams: { policy_version: PACKAGING_POLICY_V1.version },
    status,
    storageKey,
    storageBucket,
    contentHash,
    sizeBytes,
    objectVerifiedAt: new Date(),
  };

  if (existing) {
    await prisma.audiobookRendition.update({ where: { id: existing.id }, data });
  } else {
    await prisma.audiobookRendition.create({ data: { id: generateId(), ...data } });
  }
}

function matchesCurrentPolicy(encodeParams: unknown): boolean {
  return (
    Boolean(encodeParams) &&
    typeof encodeParams === 'object' &&
    (encodeParams as { policy_version?: string }).policy_version === PACKAGING_POLICY_V1.version
  );
}

async function isFormatFullyReady(
  prisma: PrismaClient,
  audiobookId: string,
  format: DeliveryFormatName,
  chapterCount: number,
): Promise<boolean> {
  if (format === 'MP3_PER_CHAPTER') {
    const rows = await prisma.audiobookRendition.findMany({
      where: { audiobookId, format: 'MP3_PER_CHAPTER', status: 'READY', chapterId: { not: null } },
      select: { encodeParams: true },
    });
    return rows.length === chapterCount && rows.every((r) => matchesCurrentPolicy(r.encodeParams));
  }
  const rendition = await prisma.audiobookRendition.findFirst({
    where: { audiobookId, format: format as never, status: 'READY', chapterId: null },
  });
  return Boolean(rendition) && matchesCurrentPolicy(rendition!.encodeParams);
}

async function downloadToFile(storage: StorageProvider, key: string, destPath: string): Promise<void> {
  const { body } = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
  }
  await writeFile(destPath, Buffer.concat(chunks));
}

// ---------------------------------------------------------------- publication gate ----

/**
 * The SOLE place `Audiobook.status` becomes `'READY'`. Re-derives "every
 * originally-requested format" via `resolveRequestedDeliveryFormats`
 * (robust across a packaging-only retry, see that function's doc) and only
 * flips status + emits `audiobook.completed` once all of them have a READY
 * rendition. Called after EVERY successful (including no-op/idempotent)
 * encode — same "ask twice, get the same safe answer" shape as the chapter
 * handler's fan-in trigger.
 */
async function maybePublishAudiobook(args: {
  prisma: PrismaClient;
  logger: Logger;
  job: ProcessingJob;
  audiobook: Audiobook;
}): Promise<void> {
  const { prisma, logger, job, audiobook } = args;
  if (audiobook.status === 'READY') return; // already published — nothing to do

  const requestedFormats = await resolveRequestedDeliveryFormats(prisma, audiobook.id);
  if (requestedFormats.length === 0) return;

  const readiness = await Promise.all(
    requestedFormats.map((f) =>
      isFormatFullyReady(prisma, audiobook.id, f as DeliveryFormatName, audiobook.chapterCount),
    ),
  );
  if (!readiness.every(Boolean)) return;

  const primaryFormat = requestedFormats.includes('M4B') ? 'M4B' : requestedFormats[0]!;
  const totalSizeBytes = await sumRenditionSizeBytes(prisma, audiobook.id);

  await withTransaction(prisma, async (tx: Tx) => {
    const current = await tx.audiobook.findUnique({ where: { id: audiobook.id } });
    if (!current || current.status === 'READY') return; // redelivery safety
    await tx.audiobook.update({
      where: { id: audiobook.id },
      data: { status: 'READY' },
    });
    // Point the Book at its live audiobook, in the same transaction that makes
    // it READY. This mirrors the convention the rest of the pipeline follows —
    // ingestion sets `currentBookVersionId` when a version becomes current, and
    // the Director sets `currentAudioScriptId` — but was never implemented for
    // audiobooks, leaving `current_audiobook_id` written by nothing at all
    // (F-16). The assembly API derives its response from the Audiobook table so
    // nothing was visibly broken, which is exactly why it went unnoticed.
    if (audiobook.bookId) {
      await tx.book.update({
        where: { id: audiobook.bookId },
        data: { currentAudiobookId: audiobook.id },
      });
    }
    await writeOutboxMessage(tx, {
      eventType: 'audiobook.completed',
      schemaVersion: '1.0',
      tenantId: audiobook.tenantId,
      bookId: audiobook.bookId,
      jobId: job.id,
      correlationId: job.correlationId,
      causationId: job.correlationId,
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      aggregateType: 'audiobook',
      aggregateId: audiobook.id,
      payload: {
        audiobook_id: audiobook.id,
        version: audiobook.version,
        duration_ms: audiobook.durationMs,
        size_bytes: totalSizeBytes,
        container_format: primaryFormat,
        available_formats: requestedFormats,
        book_wer: audiobook.bookWer,
      },
    });
  });

  logger.info(
    { audiobook_id: audiobook.id, available_formats: requestedFormats },
    'Audiobook published: every requested delivery format is READY',
  );
}

async function sumRenditionSizeBytes(prisma: PrismaClient, audiobookId: string): Promise<number> {
  const rows = await prisma.audiobookRendition.findMany({
    where: { audiobookId, status: 'READY' },
    select: { sizeBytes: true },
  });
  return rows.reduce((sum, r) => sum + Number(r.sizeBytes ?? 0), 0);
}

// ---------------------------------------------------------------- failure handling ----

async function handleEncodeFailure(args: {
  prisma: PrismaClient;
  logger: Logger;
  job: ProcessingJob;
  audiobook: Audiobook;
  format: DeliveryFormatName;
  err: unknown;
  attemptsMade: number;
  maxAttempts: number;
}): Promise<void> {
  const { prisma, logger, job, audiobook, format, err, attemptsMade, maxAttempts } = args;
  const isFinalAttempt = attemptsMade + 1 >= maxAttempts;

  if (!isFinalAttempt) {
    logger.info(
      { job_id: job.id, format, error: errorMessage(err), attempts_made: attemptsMade },
      'Encode attempt failed; will retry',
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
        errorCode: errorCodeOf(err, 'DELIVERY_FORMAT_ENCODE_FAILED'),
        errorClass: errorClassOf(err),
        errorMessage: errorMessage(err),
        errorRetryable: false,
        errorTerminal: true,
      },
    });

    // A FAILED AudiobookRendition row, for observability — never READY. The already-READY
    // renditions for OTHER formats are left untouched; a later retry of just this format
    // re-enters here and, on success, still finds those intact (never re-assembled).
    const existingRendition = await tx.audiobookRendition.findFirst({
      where: { audiobookId: audiobook.id, format: format as never, chapterId: null },
    });
    if (existingRendition) {
      await tx.audiobookRendition.update({
        where: { id: existingRendition.id },
        data: { status: 'FAILED' },
      });
    } else {
      await tx.audiobookRendition.create({
        data: {
          id: generateId(),
          tenantId: audiobook.tenantId,
          bookId: audiobook.bookId,
          audiobookId: audiobook.id,
          format: format as never,
          chapterId: null,
          bitrateKbps: 0,
          sampleRate: 0,
          channels: 0,
          durationMs: 0,
          audioToolModelVersionId: audiobook.audioToolModelVersionId,
          status: 'FAILED',
          storageKey: '',
          storageBucket: '',
          contentHash: ''.padEnd(64, '0'),
        },
      });
    }

    // The book's chapter masters and any ALREADY-READY renditions remain valid — only
    // publication (Audiobook.status='READY') is blocked until a retry succeeds.
    const currentAudiobook = await tx.audiobook.findUnique({ where: { id: audiobook.id } });
    if (currentAudiobook && currentAudiobook.status !== 'READY') {
      await tx.audiobook.update({ where: { id: audiobook.id }, data: { status: 'FAILED' } });
    }

    await writeOutboxMessage(tx, {
      eventType: 'audiobook.failed',
      schemaVersion: '1.0',
      tenantId: audiobook.tenantId,
      bookId: audiobook.bookId,
      jobId: job.id,
      correlationId: job.correlationId,
      causationId: job.correlationId,
      producer: PRODUCER,
      producerVersion: PRODUCER_VERSION,
      aggregateType: 'audiobook',
      aggregateId: audiobook.id,
      payload: {
        audiobook_id: audiobook.id,
        error_code: errorCodeOf(err, 'DELIVERY_FORMAT_ENCODE_FAILED'),
        error_class: errorClassOf(err),
        failing_precondition: `ENCODE_${format}`,
        blocking_chapter_ids: [],
      },
    });
  });

  logger.info(
    { job_id: job.id, audiobook_id: audiobook.id, format, error: errorMessage(err) },
    'Encode job failed terminally',
  );
}
