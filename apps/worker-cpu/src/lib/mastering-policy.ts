/**
 * Phase 6 (audio assembly/mastering/packaging) numeric policy — the ONLY
 * place loudness/peak/bitrate/sample-rate numbers live. Every handler in
 * `processors/assembly*.ts` imports from here; none hardcode a number
 * inline. Bumping any of these values is a deliberate, reviewable, one-line
 * change, and (per the versioned `version` string below) shows up in every
 * `ChapterAudio.assemblyVersion` / rendition's `encodeParams` row it
 * produced, so a policy change is traceable back to the artifacts it
 * affected.
 *
 * Rationale (`docs/architecture/deployment-architecture.md` never pins an
 * exact loudness/bitrate number itself, so these are ACX/Audible's published
 * submission spec, the closest thing this domain has to an industry
 * standard):
 *  - ACX requires RMS/integrated loudness between -18 and -23 dB; -20 LUFS
 *    is the midpoint, giving equal headroom in both directions.
 *  - ACX requires peak level no higher than -3dB; used here as a hard
 *    `alimiter` safety ceiling chained after the authoritative loudnorm
 *    pass, not just a target.
 *  - ACX flags a noise floor above -60dB RMS. This is diagnostic-only in
 *    this pipeline (logged + stored in `ChapterAudio.validation`) — never
 *    auto-corrected, because noise reduction is exactly the kind of
 *    non-conservative, speech-altering DSP this pipeline deliberately
 *    avoids (see `MASTERING_POLICY_V1` doc below).
 *  - ACX's literal submission spec is MP3 192kbps CBR / 44.1kHz. Applied to
 *    M4B/M4A too (`PACKAGING_POLICY_V1`) for consistency across delivery
 *    formats rather than inventing a second bitrate policy with no spec
 *    backing it.
 */

export const MASTERING_POLICY_V1 = {
  version: 'mastering.v1-acx',
  /** ACX target midpoint (-18 to -23 dB RMS/integrated loudness). */
  integratedLoudnessTargetLufs: -20,
  /** ACX peak ceiling; enforced by a post-loudnorm `alimiter`, not just targeted. */
  truePeakCeilingDbtp: -3,
  /** Diagnostic-only: logged + stored in `validation`, never auto-corrected. */
  noiseFloorFlagThresholdDbRms: -60,
  /** ffmpeg `loudnorm`'s own default LRA — conservative, no dynamics squashing. */
  loudnessRangeTarget: 11,
  /** TTS engines in this pipeline render at 24kHz mono (`AudioChunk.sampleRate`/`channels`). */
  canonicalSampleRateHz: 24000,
  canonicalChannels: 1,
} as const;

export const PACKAGING_POLICY_V1 = {
  version: 'packaging.v1-acx',
  /** ACX's literal submission spec. */
  deliverySampleRateHz: 44100,
  m4bAacBitrateKbps: 192,
  m4aAacBitrateKbps: 192,
  /** CBR — matches ACX spec exactly (see module doc above). */
  mp3BitrateKbps: 192,
} as const;

/** Conservative silence-detection defaults for trimming engine-emitted leading/trailing dead air only — never mid-utterance silence. */
export const SILENCE_TRIM_POLICY_V1 = {
  thresholdDb: -50,
  minDurationSec: 0.3,
} as const;
