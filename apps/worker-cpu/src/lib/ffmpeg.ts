/**
 * Thin wrapper around ffmpeg/ffprobe for Phase 6 (audio assembly/mastering/
 * packaging). Every call goes through `node:child_process.execFile` with an
 * argv array — NEVER a shell string — so there is no command-injection
 * surface even though several inputs here (chapter titles, book metadata)
 * ultimately originate from user-supplied text. This is a hard requirement,
 * not a style preference: do not introduce `exec`/`spawn({shell:true})`
 * anywhere in this file.
 *
 * Callers (processors/assembly*.ts) treat every function here as the unit
 * boundary for mocking in orchestration tests — see `ffmpeg.test.ts` for the
 * handful of true integration tests that shell out to a real ffmpeg binary
 * (skipped automatically when `ffmpeg`/`ffprobe` are not on PATH).
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** ffprobe JSON / ffmpeg stderr output never approaches this; it's a sanity ceiling, not a tuned budget. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

async function run(bin: 'ffmpeg' | 'ffprobe', args: string[]): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { maxBuffer: MAX_BUFFER_BYTES });
    return { stdout, stderr };
  } catch (err) {
    // execFile rejects with an error object carrying stdout/stderr/code — surface all three
    // so a failing ffmpeg invocation is diagnosable from the worker's own logs (never from a
    // silently swallowed exit code).
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
    throw new Error(
      `${bin} failed (exit ${e.code ?? 'unknown'}): ${e.message ?? String(err)}\n` +
        `args: ${args.join(' ')}\n` +
        `stderr (tail): ${(e.stderr ?? '').slice(-2000)}`,
    );
  }
}

export function runFfmpeg(args: string[]): Promise<ExecResult> {
  return run('ffmpeg', args);
}

export function runFfprobe(args: string[]): Promise<ExecResult> {
  return run('ffprobe', args);
}

/**
 * Parses the ffmpeg version out of `ffmpeg -version`'s first line (e.g.
 * "ffmpeg version 6.1.1-static https://...\n" or "ffmpeg version 6.1.1
 * Copyright ..."). Deliberately never falls back to a hardcoded string —
 * the resolved version is looked up against the seeded AUDIO_TOOL
 * ModelRegistry/ModelVersion row (`resolveAudioToolModelVersionId` in
 * processors/assembly-shared.ts), which throws `DependencyFailureError` on
 * a mismatch. This is what makes a mismatched/unpinned ffmpeg fail loudly
 * instead of silently recording wrong provenance.
 */
export async function getFfmpegVersion(): Promise<string> {
  const { stdout } = await runFfmpeg(['-version']);
  const firstLine = stdout.split('\n')[0] ?? '';
  const match = /ffmpeg version (\d+\.\d+(?:\.\d+)?)/.exec(firstLine);
  if (!match) {
    throw new Error(`Could not parse ffmpeg version from "ffmpeg -version" output: ${firstLine}`);
  }
  return match[1]!;
}

export interface ProbeResult {
  durationMs: number;
  sampleRate: number;
  channels: number;
  formatName: string;
}

/** ffprobe -show_format -show_streams -print_format json, reduced to the fields assembly needs. */
export async function probeAudio(path: string): Promise<ProbeResult> {
  const { stdout } = await runFfprobe([
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: { codec_type?: string; sample_rate?: string; channels?: number }[];
  };
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
  if (!audioStream || !parsed.format?.duration) {
    throw new Error(`ffprobe found no decodable audio stream in ${path}`);
  }
  return {
    durationMs: Math.round(Number(parsed.format.duration) * 1000),
    sampleRate: Number(audioStream.sample_rate ?? 0),
    channels: Number(audioStream.channels ?? 0),
    formatName: parsed.format.format_name ?? '',
  };
}

export interface ProbeChapter {
  startMs: number;
  endMs: number;
  title: string | null;
}

/** Reads back embedded chapter markers (used to verify an M4B's markers round-tripped exactly). */
export async function probeChapters(path: string): Promise<ProbeChapter[]> {
  const { stdout } = await runFfprobe([
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_chapters',
    path,
  ]);
  const parsed = JSON.parse(stdout) as {
    chapters?: { start_time?: string; end_time?: string; tags?: { title?: string } }[];
  };
  return (parsed.chapters ?? []).map((c) => ({
    startMs: Math.round(Number(c.start_time ?? 0) * 1000),
    endMs: Math.round(Number(c.end_time ?? 0) * 1000),
    title: c.tags?.title ?? null,
  }));
}

export interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export interface LoudnessTarget {
  integratedLufs: number;
  truePeakCeilingDbtp: number;
  loudnessRange: number;
}

/**
 * Pass 1 of two-pass `loudnorm`: measures the input without altering it.
 * `loudnorm` prints its measurement as a JSON object to stderr, wrapped in
 * unrelated log lines — the trailing `{...}` block is the payload.
 */
export async function measureLoudnormPass(
  inputPath: string,
  target: LoudnessTarget,
): Promise<LoudnormMeasurement> {
  const filter = `loudnorm=I=${target.integratedLufs}:TP=${target.truePeakCeilingDbtp}:LRA=${target.loudnessRange}:print_format=json`;
  const { stderr } = await runFfmpeg([
    '-hide_banner',
    '-nostats',
    '-i',
    inputPath,
    '-af',
    filter,
    '-f',
    'null',
    '-',
  ]);
  return parseTrailingJsonBlock<LoudnormMeasurement>(stderr, 'loudnorm measurement');
}

/**
 * Finds the LAST `{...}` block in ffmpeg's stderr stream and parses it as
 * JSON. `loudnorm`'s `print_format=json` output is a single flat (non-nested)
 * object, always the final thing printed — taking the last brace pair rather
 * than the first is what makes this robust to earlier log lines that
 * legitimately contain braces (paths, filter graph descriptions).
 */
function parseTrailingJsonBlock<T>(text: string, what: string): T {
  const lastOpen = text.lastIndexOf('{');
  const lastClose = text.lastIndexOf('}');
  if (lastOpen === -1 || lastClose === -1 || lastClose < lastOpen) {
    throw new Error(`Could not find a ${what} JSON block in ffmpeg output`);
  }
  const block = text.slice(lastOpen, lastClose + 1);
  try {
    return JSON.parse(block) as T;
  } catch {
    throw new Error(`Could not parse ${what} JSON block: ${block}`);
  }
}

/** Converts a dBTP ceiling into `alimiter`'s linear amplitude `limit` parameter. */
function dbToLinearAmplitude(db: number): number {
  return Math.pow(10, db / 20);
}

export interface TwoPassLoudnormOptions {
  sampleRate: number;
  channels: number;
}

/**
 * Authoritative two-pass `loudnorm` + a chained `alimiter` safety ceiling
 * (never a general compressor — conservative, speech-safe mastering only).
 * Pass 1 measures; pass 2 applies `linear=true` with the measured_* params,
 * which is ffmpeg's documented two-pass recipe for sample-accurate loudness
 * correction (as opposed to single-pass dynamic normalization).
 */
export async function applyTwoPassLoudnorm(
  inputPath: string,
  outputPath: string,
  target: LoudnessTarget,
  opts: TwoPassLoudnormOptions,
): Promise<LoudnormMeasurement> {
  const measurement = await measureLoudnormPass(inputPath, target);
  const limiterLimit = dbToLinearAmplitude(target.truePeakCeilingDbtp).toFixed(6);
  const filter =
    `loudnorm=I=${target.integratedLufs}:TP=${target.truePeakCeilingDbtp}:LRA=${target.loudnessRange}:` +
    `measured_I=${measurement.input_i}:measured_TP=${measurement.input_tp}:` +
    `measured_LRA=${measurement.input_lra}:measured_thresh=${measurement.input_thresh}:` +
    `offset=${measurement.target_offset}:linear=true:print_format=summary,` +
    `alimiter=limit=${limiterLimit}:level=disabled`;
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-i',
    inputPath,
    '-af',
    filter,
    '-ar',
    String(opts.sampleRate),
    '-ac',
    String(opts.channels),
    '-c:a',
    'pcm_s16le',
    outputPath,
  ]);
  return measurement;
}

/** Light single-pass pre-normalization applied per chunk, before the authoritative chapter-level two-pass master — just enough so chunk joins don't jump. */
export async function applySinglePassLoudnorm(
  inputPath: string,
  outputPath: string,
  target: LoudnessTarget,
  opts: TwoPassLoudnormOptions,
): Promise<void> {
  const filter = `loudnorm=I=${target.integratedLufs}:TP=${target.truePeakCeilingDbtp}:LRA=${target.loudnessRange}:print_format=summary`;
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-i',
    inputPath,
    '-af',
    filter,
    '-ar',
    String(opts.sampleRate),
    '-ac',
    String(opts.channels),
    '-c:a',
    'pcm_s16le',
    outputPath,
  ]);
}

export interface SilenceInterval {
  startSec: number;
  /** `null` means the silence interval was still open when the stream ended (ffmpeg only emits `silence_end` on end-of-stream if flushed; treat as "extends to EOF"). */
  endSec: number | null;
}

/** Detects silence intervals via `silencedetect` — used only to trim leading/trailing engine-emitted dead air, never mid-utterance silence (that's `AudioScriptChunk.pauses`' job). */
export async function detectSilence(
  inputPath: string,
  opts: { thresholdDb: number; minDurationSec: number },
): Promise<SilenceInterval[]> {
  const filter = `silencedetect=noise=${opts.thresholdDb}dB:d=${opts.minDurationSec}`;
  const { stderr } = await runFfmpeg([
    '-hide_banner',
    '-nostats',
    '-i',
    inputPath,
    '-af',
    filter,
    '-f',
    'null',
    '-',
  ]);
  const intervals: SilenceInterval[] = [];
  const startRe = /silence_start:\s*(-?[\d.]+)/g;
  const endRe = /silence_end:\s*(-?[\d.]+)/g;
  const starts = [...stderr.matchAll(startRe)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(endRe)].map((m) => Number(m[1]));
  for (let i = 0; i < starts.length; i++) {
    intervals.push({ startSec: starts[i]!, endSec: ends[i] ?? null });
  }
  return intervals;
}

/** Writes a raw PCM silence file at the canonical rate/channels via `anullsrc`, for pause insertion. */
export async function generateSilenceFile(
  outputPath: string,
  opts: { durationMs: number; sampleRate: number; channels: number },
): Promise<void> {
  const channelLayout = opts.channels === 1 ? 'mono' : 'stereo';
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=${opts.sampleRate}:cl=${channelLayout}`,
    '-t',
    (opts.durationMs / 1000).toFixed(3),
    '-c:a',
    'pcm_s16le',
    outputPath,
  ]);
}

/** Trims to `[startSec, endSec)` (endSec omitted = to end-of-file) and conforms to the canonical rate/channels/codec in one pass. */
export async function trimAndConvert(
  inputPath: string,
  outputPath: string,
  opts: { startSec?: number; endSec?: number; sampleRate: number; channels: number },
): Promise<void> {
  const filterParts: string[] = [];
  if (opts.startSec !== undefined || opts.endSec !== undefined) {
    const atrimArgs: string[] = [];
    if (opts.startSec !== undefined) atrimArgs.push(`start=${opts.startSec}`);
    if (opts.endSec !== undefined) atrimArgs.push(`end=${opts.endSec}`);
    filterParts.push(`atrim=${atrimArgs.join(':')}`, 'asetpts=PTS-STARTPTS');
  }
  const args = ['-y', '-hide_banner', '-i', inputPath];
  if (filterParts.length > 0) {
    args.push('-af', filterParts.join(','));
  }
  args.push(
    '-ar',
    String(opts.sampleRate),
    '-ac',
    String(opts.channels),
    '-c:a',
    'pcm_s16le',
    outputPath,
  );
  await runFfmpeg(args);
}

/** Writes an ffmpeg `concat` demuxer file list (`file '<escaped path>'` per line, `-safe 0` is passed by the caller). */
export async function writeConcatFileList(listPath: string, files: string[]): Promise<void> {
  const content = files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
  await fs.writeFile(listPath, content, 'utf8');
}

/** Concatenates via the `concat` demuxer with `-c copy` — cheap and lossless, valid only when every listed file already shares the same codec/sample-rate/channels (true here: every intermediate is conformed to the canonical PCM WAV format before this is called). */
export async function concatDemuxCopy(fileListPath: string, outputPath: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    fileListPath,
    '-c',
    'copy',
    outputPath,
  ]);
}

export interface Ebur128Measurement {
  integratedLufs: number;
  truePeakDbtp: number;
}

/** Independent post-mastering re-measurement (never trusts loudnorm's own self-reported prediction) used for validation/persisted metrics. */
export async function measureEbur128(inputPath: string): Promise<Ebur128Measurement> {
  const { stderr } = await runFfmpeg([
    '-hide_banner',
    '-nostats',
    '-i',
    inputPath,
    '-af',
    'ebur128=peak=true:framelog=quiet',
    '-f',
    'null',
    '-',
  ]);
  const integrated = lastNumberAfter(stderr, /I:\s*(-?[\d.]+)\s*LUFS/g);
  const peak = lastNumberAfter(stderr, /Peak:\s*(-?[\d.]+)\s*dBFS/g);
  if (integrated === null || peak === null) {
    throw new Error(`Could not parse ebur128 summary from ffmpeg output:\n${stderr.slice(-2000)}`);
  }
  return { integratedLufs: integrated, truePeakDbtp: peak };
}

export interface ClippingReport {
  clippedSamples: number;
  peakDbfs: number;
}

/** `astats` summary (the "Overall" section, printed last) for clipping detection during validation. */
export async function measureClipping(inputPath: string): Promise<ClippingReport> {
  const { stderr } = await runFfmpeg([
    '-hide_banner',
    '-nostats',
    '-i',
    inputPath,
    '-af',
    'astats=metadata=0',
    '-f',
    'null',
    '-',
  ]);
  const clipped = lastNumberAfter(stderr, /Number of clipped samples:\s*(-?[\d.]+)/g) ?? 0;
  const peak = lastNumberAfter(stderr, /Peak level dB:\s*(-?[\d.]+)/g) ?? Number.NaN;
  return { clippedSamples: clipped, peakDbfs: peak };
}

/**
 * Overall RMS level (dBFS) as a proxy for noise-floor flagging
 * (`MASTERING_POLICY_V1.noiseFloorFlagThresholdDbRms`). This measures the
 * WHOLE file's RMS, not just silence regions specifically — a documented
 * approximation. A true "noise floor during silence regions" measurement
 * would require locating silence intervals first and re-running `astats`
 * scoped to just those regions; since this check is diagnostic-only (never
 * blocks a job) the whole-file RMS is judged sufficient signal for now.
 */
export async function measureOverallRmsDb(inputPath: string): Promise<number> {
  const { stderr } = await runFfmpeg([
    '-hide_banner',
    '-nostats',
    '-i',
    inputPath,
    '-af',
    'astats=metadata=0',
    '-f',
    'null',
    '-',
  ]);
  const rms = lastNumberAfter(stderr, /RMS level dB:\s*(-?[\d.]+)/g);
  if (rms === null) {
    throw new Error(`Could not parse RMS level from ffmpeg astats output:\n${stderr.slice(-2000)}`);
  }
  return rms;
}

function lastNumberAfter(text: string, pattern: RegExp): number | null {
  const matches = [...text.matchAll(pattern)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : null;
}

/** A gentle per-segment gain trim (a plain `volume` filter, never a full `loudnorm` re-run) used for book-level chapter-to-chapter loudness consistency. */
export async function applyGainAndConvert(
  inputPath: string,
  outputPath: string,
  gainDb: number,
  opts: { sampleRate: number; channels: number },
): Promise<void> {
  const filter = gainDb === 0 ? 'anull' : `volume=${gainDb}dB`;
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-i',
    inputPath,
    '-af',
    filter,
    '-ar',
    String(opts.sampleRate),
    '-ac',
    String(opts.channels),
    '-c:a',
    'pcm_s16le',
    outputPath,
  ]);
}

export interface FfmetadataChapter {
  title: string | null;
  startMs: number;
  endMs: number;
}

/** Builds an ffmetadata (`FFMETADATA1`) chapters file for `-i chapters.txt -map_chapters`. */
export function buildFfmetadataChapters(
  globalTags: Record<string, string>,
  chapters: FfmetadataChapter[],
): string {
  const lines = [';FFMETADATA1'];
  for (const [key, value] of Object.entries(globalTags)) {
    if (value) lines.push(`${key}=${escapeFfmetadataValue(value)}`);
  }
  for (const chapter of chapters) {
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${chapter.startMs}`, `END=${chapter.endMs}`);
    if (chapter.title) lines.push(`title=${escapeFfmetadataValue(chapter.title)}`);
  }
  return lines.join('\n') + '\n';
}

function escapeFfmetadataValue(value: string): string {
  return value.replace(/([=;#\\\n])/g, '\\$1');
}

export interface EncodeAacOptions {
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
  /** `-metadata key=value` pairs, flattened, e.g. `['-metadata', 'title=...']`. */
  metadataArgs: string[];
  ffmetadataPath?: string;
  coverPath?: string;
}

/** AAC-in-MP4 encode (M4B/M4A), with optional embedded chapter markers and cover art. */
export async function encodeAac(
  inputAudioPath: string,
  outputPath: string,
  opts: EncodeAacOptions,
): Promise<void> {
  const args: string[] = ['-y', '-hide_banner', '-i', inputAudioPath];
  let nextInputIndex = 1;
  let chapterInputIndex: number | undefined;
  let coverInputIndex: number | undefined;

  if (opts.ffmetadataPath) {
    args.push('-i', opts.ffmetadataPath);
    chapterInputIndex = nextInputIndex++;
  }
  if (opts.coverPath) {
    args.push('-i', opts.coverPath);
    coverInputIndex = nextInputIndex++;
  }

  if (chapterInputIndex !== undefined) {
    args.push('-map_metadata', String(chapterInputIndex), '-map_chapters', String(chapterInputIndex));
  }
  args.push('-map', '0:a');
  if (coverInputIndex !== undefined) {
    args.push(
      '-map',
      `${coverInputIndex}:v`,
      '-disposition:v:0',
      'attached_pic',
      '-c:v',
      'copy',
    );
  }
  args.push(
    '-c:a',
    'aac',
    '-b:a',
    `${opts.bitrateKbps}k`,
    '-ar',
    String(opts.sampleRate),
    '-ac',
    String(opts.channels),
    ...opts.metadataArgs,
    '-movflags',
    '+faststart',
    outputPath,
  );
  await runFfmpeg(args);
}

export interface EncodeMp3Options {
  bitrateKbps: number;
  sampleRate: number;
  metadataArgs?: string[];
}

/** MP3 CBR encode (one file per chapter for the `MP3_PER_CHAPTER` delivery format). Plain `-b:a` (no `-q:a` VBR flag) is libmp3lame's CBR mode. */
export async function encodeMp3(
  inputAudioPath: string,
  outputPath: string,
  opts: EncodeMp3Options,
): Promise<void> {
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-i',
    inputAudioPath,
    '-c:a',
    'libmp3lame',
    '-b:a',
    `${opts.bitrateKbps}k`,
    '-ar',
    String(opts.sampleRate),
    '-ac',
    '1',
    ...(opts.metadataArgs ?? []),
    outputPath,
  ]);
}
