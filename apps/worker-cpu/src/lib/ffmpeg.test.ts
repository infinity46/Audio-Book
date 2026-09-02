import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyTwoPassLoudnorm,
  buildFfmetadataChapters,
  concatDemuxCopy,
  detectSilence,
  encodeAac,
  encodeMp3,
  generateSilenceFile,
  getFfmpegVersion,
  measureClipping,
  measureEbur128,
  measureOverallRmsDb,
  probeAudio,
  probeChapters,
  runFfmpeg,
  trimAndConvert,
  writeConcatFileList,
} from './ffmpeg.js';

const execFileAsync = promisify(execFile);

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    await execFileAsync('ffprobe', ['-version']);
    return true;
  } catch {
    return false;
  }
}

const hasFfmpeg = await ffmpegAvailable();

describe('buildFfmetadataChapters (pure, no ffmpeg required)', () => {
  it('emits an FFMETADATA1 header, global tags, and one [CHAPTER] block per entry', () => {
    const content = buildFfmetadataChapters(
      { title: 'My Book', artist: 'An Author' },
      [
        { title: 'Chapter One', startMs: 0, endMs: 1000 },
        { title: 'Chapter Two', startMs: 1000, endMs: 2500 },
      ],
    );
    expect(content.startsWith(';FFMETADATA1\n')).toBe(true);
    expect(content).toContain('title=My Book');
    expect(content).toContain('artist=An Author');
    expect(content.match(/\[CHAPTER\]/g)).toHaveLength(2);
    expect(content).toContain('START=0');
    expect(content).toContain('END=1000');
    expect(content).toContain('START=1000');
    expect(content).toContain('END=2500');
    expect(content).toContain('title=Chapter One');
    expect(content).toContain('title=Chapter Two');
  });

  it('escapes ffmetadata special characters (= ; # \\) in tag values', () => {
    const content = buildFfmetadataChapters({ title: 'A=B;C#D\\E' }, []);
    expect(content).toContain('title=A\\=B\\;C\\#D\\\\E');
  });

  it('omits empty global tag values', () => {
    const content = buildFfmetadataChapters({ title: 'Title', artist: '' }, []);
    expect(content).toContain('title=Title');
    expect(content).not.toContain('artist=');
  });
});

/**
 * True integration tests: generate a few seconds of synthetic tone audio via
 * `ffmpeg -f lavfi -i sine=...` and run this module's real argv construction
 * against a real ffmpeg/ffprobe binary. Skipped (not failed) when ffmpeg
 * isn't on PATH — `which ffmpeg` was checked before writing these; CI/dev
 * environments without it still get full coverage from the mocked
 * orchestration tests in processors/assembly-*.test.ts.
 */
describe.skipIf(!hasFfmpeg)('ffmpeg integration (real binary)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ffmpeg-lib-test-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function generateTone(path: string, opts: { durationSec: number; freq?: number; sampleRate?: number; channels?: number }) {
    const sampleRate = opts.sampleRate ?? 24000;
    const channels = opts.channels ?? 1;
    const channelLayout = channels === 1 ? 'mono' : 'stereo';
    await runFfmpeg([
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${opts.freq ?? 440}:duration=${opts.durationSec}:sample_rate=${sampleRate}`,
      '-ac',
      String(channels),
      '-af',
      channels > 1 ? `pan=${channelLayout}|c0=c0|c1=c0` : 'anull',
      path,
    ]);
  }

  it('getFfmpegVersion parses the real installed version', async () => {
    const version = await getFfmpegVersion();
    expect(version).toMatch(/^\d+\.\d+(\.\d+)?$/);
  });

  it('probeAudio reports the correct duration/sampleRate/channels for a generated tone', async () => {
    const tonePath = join(dir, 'tone-2s.wav');
    await generateTone(tonePath, { durationSec: 2, sampleRate: 24000, channels: 1 });
    const probed = await probeAudio(tonePath);
    expect(probed.sampleRate).toBe(24000);
    expect(probed.channels).toBe(1);
    expect(probed.durationMs).toBeGreaterThanOrEqual(1900);
    expect(probed.durationMs).toBeLessThanOrEqual(2100);
  });

  it('generateSilenceFile + concat demuxer produces a file whose duration is the sum of its parts', async () => {
    const silencePath = join(dir, 'silence-1s.wav');
    await generateSilenceFile(silencePath, { durationMs: 1000, sampleRate: 24000, channels: 1 });
    const tonePath = join(dir, 'tone-for-concat.wav');
    await generateTone(tonePath, { durationSec: 1, sampleRate: 24000, channels: 1 });

    const listPath = join(dir, 'concat-list.txt');
    await writeConcatFileList(listPath, [silencePath, tonePath]);
    const outPath = join(dir, 'concatenated.wav');
    await concatDemuxCopy(listPath, outPath);

    const probed = await probeAudio(outPath);
    expect(probed.durationMs).toBeGreaterThanOrEqual(1900);
    expect(probed.durationMs).toBeLessThanOrEqual(2100);
  });

  it('detectSilence finds an injected silent gap', async () => {
    const silencePath = join(dir, 'silence-for-detect.wav');
    await generateSilenceFile(silencePath, { durationMs: 800, sampleRate: 24000, channels: 1 });
    const tonePath = join(dir, 'tone-for-detect.wav');
    await generateTone(tonePath, { durationSec: 1, sampleRate: 24000, channels: 1 });
    const listPath = join(dir, 'detect-list.txt');
    await writeConcatFileList(listPath, [silencePath, tonePath]);
    const combinedPath = join(dir, 'silence-then-tone.wav');
    await concatDemuxCopy(listPath, combinedPath);

    const intervals = await detectSilence(combinedPath, { thresholdDb: -50, minDurationSec: 0.3 });
    expect(intervals.length).toBeGreaterThanOrEqual(1);
    expect(intervals[0]!.startSec).toBeCloseTo(0, 1);
    expect(intervals[0]!.endSec).not.toBeNull();
    expect(intervals[0]!.endSec!).toBeGreaterThan(0.5);
  });

  it('trimAndConvert trims to the requested window and conforms sample rate/channels', async () => {
    const tonePath = join(dir, 'tone-for-trim.wav');
    await generateTone(tonePath, { durationSec: 3, sampleRate: 44100, channels: 1 });
    const trimmedPath = join(dir, 'trimmed.wav');
    await trimAndConvert(tonePath, trimmedPath, { startSec: 1, endSec: 2, sampleRate: 24000, channels: 1 });
    const probed = await probeAudio(trimmedPath);
    expect(probed.sampleRate).toBe(24000);
    expect(probed.durationMs).toBeGreaterThanOrEqual(900);
    expect(probed.durationMs).toBeLessThanOrEqual(1100);
  });

  it('two-pass loudnorm produces a decodable, measurably normalized output', async () => {
    const tonePath = join(dir, 'tone-for-loudnorm.wav');
    await generateTone(tonePath, { durationSec: 2, freq: 220, sampleRate: 24000, channels: 1 });
    const masteredPath = join(dir, 'mastered.wav');
    const measurement = await applyTwoPassLoudnorm(
      tonePath,
      masteredPath,
      { integratedLufs: -20, truePeakCeilingDbtp: -3, loudnessRange: 11 },
      { sampleRate: 24000, channels: 1 },
    );
    expect(Number(measurement.input_i)).toBeLessThan(0);

    const probed = await probeAudio(masteredPath);
    expect(probed.durationMs).toBeGreaterThan(0);

    const ebur128 = await measureEbur128(masteredPath);
    // A full-scale sine tone driven toward -20 LUFS should land in a broad neighborhood of it —
    // this asserts the pipeline actually ran, not exact mastering precision.
    expect(ebur128.integratedLufs).toBeGreaterThan(-30);
    expect(ebur128.integratedLufs).toBeLessThan(-10);
    expect(ebur128.truePeakDbtp).toBeLessThan(0);
  });

  it('measureClipping and measureOverallRmsDb return sane values for a clean tone', async () => {
    const tonePath = join(dir, 'tone-for-astats.wav');
    await generateTone(tonePath, { durationSec: 1, sampleRate: 24000, channels: 1 });
    const clipping = await measureClipping(tonePath);
    expect(clipping.clippedSamples).toBe(0);
    const rms = await measureOverallRmsDb(tonePath);
    expect(rms).toBeLessThan(0);
    expect(Number.isFinite(rms)).toBe(true);
  });

  it('encodeAac produces a decodable M4B with embedded chapter markers', async () => {
    const tonePath = join(dir, 'tone-for-m4b.wav');
    await generateTone(tonePath, { durationSec: 2, sampleRate: 44100, channels: 1 });
    const ffmetadata = buildFfmetadataChapters(
      { title: 'Test Book', artist: 'Test Author' },
      [
        { title: 'Chapter One', startMs: 0, endMs: 1000 },
        { title: 'Chapter Two', startMs: 1000, endMs: 2000 },
      ],
    );
    const ffmetadataPath = join(dir, 'chapters.txt');
    await (await import('node:fs/promises')).writeFile(ffmetadataPath, ffmetadata, 'utf8');

    const outPath = join(dir, 'output.m4b');
    await encodeAac(tonePath, outPath, {
      bitrateKbps: 64,
      sampleRate: 44100,
      channels: 1,
      metadataArgs: ['-metadata', 'title=Test Book'],
      ffmetadataPath,
    });

    const probed = await probeAudio(outPath);
    expect(probed.durationMs).toBeGreaterThanOrEqual(1800);
    const chapters = await probeChapters(outPath);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]!.title).toBe('Chapter One');
    expect(chapters[1]!.title).toBe('Chapter Two');
  });

  it('encodeMp3 produces a decodable CBR MP3', async () => {
    const tonePath = join(dir, 'tone-for-mp3.wav');
    await generateTone(tonePath, { durationSec: 1, sampleRate: 44100, channels: 1 });
    const outPath = join(dir, 'output.mp3');
    await encodeMp3(tonePath, outPath, { bitrateKbps: 192, sampleRate: 44100 });
    const probed = await probeAudio(outPath);
    expect(probed.durationMs).toBeGreaterThanOrEqual(900);
  });
});
