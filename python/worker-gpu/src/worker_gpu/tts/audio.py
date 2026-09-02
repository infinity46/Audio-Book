"""PCM WAV encoding, measurement and the worker-side technical checks (§26-§30).

Canonical intermediate format, per §26.1: **PCM WAV**, one project-canonical sample rate,
16- or 24-bit, mono for speech. Exactly one lossy encode happens in this system and it
happens at final delivery, never here.

## What this module measures, and what it deliberately does not

`peak_dbfs` and `rms_dbfs` are computed exactly from the samples. `integrated_lufs` and
`true_peak_dbtp` are **left unmeasured** (the columns are nullable) rather than filled with
an approximation: BS.1770 integrated loudness needs K-weighting filters and gated block
analysis, and true-peak needs oversampling. §25.1 assigns both loudness passes to Audio
Processing, which has the tooling to do them properly, and §69.2 forbids asserting
numerical audio claims that were not actually measured. A field labelled `integrated_lufs`
holding something that is not LUFS would be worse than a null, because mastering would
trust it.

## Where the boundary falls

§28.3: the GPU worker runs only the cheap, immediate checks needed before it may report
success -- decodable, non-empty, right shape, not pathological. The fuller QC chain is the
`validate_audio` job on the `audio` queue, running on CPU, so GPU time stays reserved for
synthesis. `run_worker_checks` is the former; it is deliberately not the whole of §28.1.
"""

from __future__ import annotations

import io
import math
import struct
import wave
from array import array
from dataclasses import dataclass, field
from typing import Literal, Sequence

from worker_gpu.tts.errors import TtsError, TtsErrorCode

_INT16_FULL_SCALE = 32767
_SILENCE_FLOOR_DBFS = -60.0


@dataclass(frozen=True, slots=True)
class AudioMeasurements:
    duration_ms: int
    sample_rate: int
    channels: int
    sample_width_bits: int
    frame_count: int
    peak_dbfs: float
    rms_dbfs: float
    clipped_sample_ratio: float
    leading_silence_ms: int
    trailing_silence_ms: int
    longest_internal_silence_ms: int


@dataclass(frozen=True, slots=True)
class CheckOutcome:
    check: str
    outcome: Literal["PASS", "FAIL"]
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class AudioValidation:
    status: Literal["PASS", "FAIL"]
    checks: tuple[CheckOutcome, ...]
    measurements: AudioMeasurements
    failing_check: str | None = None

    def as_json(self) -> dict[str, object]:
        """The shape written to `audio_chunk.validation` (`database-schema.md` §16.2)."""
        return {
            "status": self.status,
            "failing_check": self.failing_check,
            "checks": [
                {"check": c.check, "outcome": c.outcome, **({"detail": c.detail} if c.detail else {})}
                for c in self.checks
            ],
            "measurements": {
                "duration_ms": self.measurements.duration_ms,
                "sample_rate": self.measurements.sample_rate,
                "channels": self.measurements.channels,
                "peak_dbfs": self.measurements.peak_dbfs,
                "rms_dbfs": self.measurements.rms_dbfs,
                "clipped_sample_ratio": self.measurements.clipped_sample_ratio,
                "leading_silence_ms": self.measurements.leading_silence_ms,
                "trailing_silence_ms": self.measurements.trailing_silence_ms,
                "longest_internal_silence_ms": self.measurements.longest_internal_silence_ms,
            },
        }


@dataclass(frozen=True, slots=True)
class ValidationThresholds:
    """Every threshold is configuration (§19.1, §69.2) -- none is a hard-coded claim.

    `min_chars_per_second`/`max_chars_per_second` implement §35/§67's duration plausibility
    band as a *heuristic*, deliberately wide: a rigid language-dependent ratio would reject
    legitimate dense or sparse text. It catches the real failure modes (100 characters
    rendered as 0.01s, or as ten minutes), not stylistic variation.
    """

    min_duration_ms: int = 40
    max_duration_ms: int = 600_000
    max_clipped_sample_ratio: float = 0.005
    silence_floor_dbfs: float = _SILENCE_FLOOR_DBFS
    max_leading_silence_ms: int = 2_000
    max_trailing_silence_ms: int = 3_000
    max_internal_silence_ms: int = 5_000
    min_chars_per_second: float = 1.0
    max_chars_per_second: float = 60.0


def encode_wav(
    samples: Sequence[float], *, sample_rate: int, channels: int, bit_depth: int = 16
) -> bytes:
    """Encode interleaved float samples in [-1, 1] to PCM WAV.

    NaN/Inf are rejected here rather than silently coerced: they are a known inference
    failure mode (§28.1), and encoding them would push a corrupt artifact downstream where
    the cause is much harder to attribute.
    """
    if bit_depth not in (16, 24):
        raise TtsError(
            TtsErrorCode.AUDIO_CORRUPTED, f"Unsupported bit depth {bit_depth}; §26.1 allows 16/24."
        )
    if not samples:
        raise TtsError(TtsErrorCode.AUDIO_CORRUPTED, "Synthesis produced no samples.")

    pcm = bytearray()
    if bit_depth == 16:
        ints = array("h")
        for value in samples:
            ints.append(_to_int(value, _INT16_FULL_SCALE))
        pcm.extend(ints.tobytes())
    else:
        full_scale = (1 << 23) - 1
        for value in samples:
            packed = struct.pack("<i", _to_int(value, full_scale))
            pcm.extend(packed[:3])

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(bit_depth // 8)
        handle.setframerate(sample_rate)
        handle.writeframes(bytes(pcm))
    return buffer.getvalue()


def _to_int(value: float, full_scale: int) -> int:
    if not math.isfinite(value):
        raise TtsError(
            TtsErrorCode.AUDIO_CORRUPTED,
            "Synthesis produced a non-finite sample (NaN/Inf).",
        )
    return max(-full_scale - 1, min(full_scale, int(round(value * full_scale))))


def measure_wav(data: bytes) -> AudioMeasurements:
    """Decode and measure. Raises `AUDIO_CORRUPTED` for anything undecodable."""
    try:
        with wave.open(io.BytesIO(data), "rb") as handle:
            channels = handle.getnchannels()
            sample_width = handle.getsampwidth()
            sample_rate = handle.getframerate()
            frame_count = handle.getnframes()
            raw = handle.readframes(frame_count)
    except (wave.Error, EOFError, struct.error) as exc:
        raise TtsError(TtsErrorCode.AUDIO_CORRUPTED, f"Undecodable WAV container: {exc}") from exc

    if sample_rate <= 0 or channels <= 0 or frame_count <= 0:
        raise TtsError(
            TtsErrorCode.AUDIO_CORRUPTED,
            f"Degenerate WAV header (rate={sample_rate}, channels={channels}, "
            f"frames={frame_count}).",
        )

    normalized = _normalize_samples(raw, sample_width)
    if not normalized:
        raise TtsError(TtsErrorCode.AUDIO_CORRUPTED, "WAV contains no readable sample data.")

    # Per-frame magnitude: silence and peak are properties of the moment, not of one
    # channel, so a frame counts as silent only when every channel in it is silent.
    frame_magnitudes = _frame_magnitudes(normalized, channels)

    peak = max(frame_magnitudes)
    sum_squares = 0.0
    clipped = 0
    for value in normalized:
        sum_squares += value * value
        if abs(value) >= 0.999:
            clipped += 1
    rms = math.sqrt(sum_squares / len(normalized))

    floor_amplitude = _dbfs_to_amplitude(_SILENCE_FLOOR_DBFS)
    leading, trailing, internal = _silence_spans(frame_magnitudes, floor_amplitude, sample_rate)

    return AudioMeasurements(
        duration_ms=int(round(frame_count * 1000 / sample_rate)),
        sample_rate=sample_rate,
        channels=channels,
        sample_width_bits=sample_width * 8,
        frame_count=frame_count,
        peak_dbfs=_amplitude_to_dbfs(peak),
        rms_dbfs=_amplitude_to_dbfs(rms),
        clipped_sample_ratio=clipped / len(normalized),
        leading_silence_ms=leading,
        trailing_silence_ms=trailing,
        longest_internal_silence_ms=internal,
    )


def _normalize_samples(raw: bytes, sample_width: int) -> list[float]:
    if sample_width == 2:
        ints = array("h")
        ints.frombytes(raw[: len(raw) - (len(raw) % 2)])
        return [value / 32768.0 for value in ints]
    if sample_width == 3:
        values: list[float] = []
        for offset in range(0, len(raw) - 2, 3):
            chunk = raw[offset : offset + 3]
            value = int.from_bytes(chunk, "little", signed=True)
            values.append(value / 8388608.0)
        return values
    if sample_width == 1:
        return [(byte - 128) / 128.0 for byte in raw]
    raise TtsError(
        TtsErrorCode.AUDIO_CORRUPTED, f"Unsupported PCM sample width: {sample_width} bytes."
    )


def _frame_magnitudes(samples: list[float], channels: int) -> list[float]:
    if channels == 1:
        return [abs(value) for value in samples]
    magnitudes: list[float] = []
    for index in range(0, len(samples) - channels + 1, channels):
        magnitudes.append(max(abs(value) for value in samples[index : index + channels]))
    return magnitudes


def _silence_spans(
    magnitudes: list[float], floor_amplitude: float, sample_rate: int
) -> tuple[int, int, int]:
    total = len(magnitudes)
    leading = 0
    while leading < total and magnitudes[leading] < floor_amplitude:
        leading += 1
    if leading == total:
        # Entirely silent: report it as leading silence and no internal gap, so the
        # "complete silence" check (§30.1) is the one that fires rather than a misleading
        # "long internal gap".
        return _frames_to_ms(total, sample_rate), 0, 0

    trailing = 0
    while trailing < total and magnitudes[total - 1 - trailing] < floor_amplitude:
        trailing += 1

    longest = 0
    current = 0
    for magnitude in magnitudes[leading : total - trailing]:
        if magnitude < floor_amplitude:
            current += 1
            longest = max(longest, current)
        else:
            current = 0

    return (
        _frames_to_ms(leading, sample_rate),
        _frames_to_ms(trailing, sample_rate),
        _frames_to_ms(longest, sample_rate),
    )


def _frames_to_ms(frames: int, sample_rate: int) -> int:
    return int(round(frames * 1000 / sample_rate))


def _amplitude_to_dbfs(amplitude: float) -> float:
    if amplitude <= 0:
        return -144.0
    return round(20 * math.log10(amplitude), 2)


def _dbfs_to_amplitude(dbfs: float) -> float:
    return 10 ** (dbfs / 20)


def run_worker_checks(
    data: bytes,
    *,
    expected_sample_rate: int,
    expected_channels: int,
    source_char_count: int,
    thresholds: ValidationThresholds | None = None,
) -> AudioValidation:
    """The GPU worker's own pre-success checks (§17.1 step 7, §28.3).

    Cheap, immediate, and about *this* artifact's technical integrity only. The verdict is
    deterministic, which is exactly why a failure is never retried as-is (§21.3): it is
    recorded, the chunk goes `INVALID`, and regeneration -- a different operation -- is what
    follows.
    """
    limits = thresholds or ValidationThresholds()
    measurements = measure_wav(data)
    checks: list[CheckOutcome] = [CheckOutcome("container_decodable", "PASS")]

    def add(name: str, ok: bool, detail: str | None = None) -> None:
        checks.append(CheckOutcome(name, "PASS" if ok else "FAIL", None if ok else detail))

    add(
        "duration_within_bounds",
        limits.min_duration_ms <= measurements.duration_ms <= limits.max_duration_ms,
        f"{measurements.duration_ms}ms outside "
        f"[{limits.min_duration_ms}, {limits.max_duration_ms}]",
    )
    add(
        "sample_rate_matches_expected",
        measurements.sample_rate == expected_sample_rate,
        f"got {measurements.sample_rate}, expected {expected_sample_rate}",
    )
    add(
        "channels_match_expected",
        measurements.channels == expected_channels,
        f"got {measurements.channels}, expected {expected_channels}",
    )
    add(
        "not_silent",
        measurements.rms_dbfs > limits.silence_floor_dbfs,
        f"integrated RMS {measurements.rms_dbfs} dBFS is at or below the "
        f"{limits.silence_floor_dbfs} dBFS floor",
    )
    add(
        "true_peak_clipping",
        measurements.clipped_sample_ratio <= limits.max_clipped_sample_ratio,
        f"{measurements.clipped_sample_ratio:.4%} of samples at full scale",
    )
    add(
        "leading_silence_within_bounds",
        measurements.leading_silence_ms <= limits.max_leading_silence_ms,
        f"{measurements.leading_silence_ms}ms of leading silence",
    )
    add(
        "trailing_silence_within_bounds",
        measurements.trailing_silence_ms <= limits.max_trailing_silence_ms,
        f"{measurements.trailing_silence_ms}ms of trailing silence",
    )
    # §30.2: this flags silence the ENGINE produced and the IR did not ask for. The IR's own
    # pause plan is applied downstream by Audio Processing and is not present in these
    # bytes, so a long gap here is always unrequested by construction.
    add(
        "internal_silence_within_bounds",
        measurements.longest_internal_silence_ms <= limits.max_internal_silence_ms,
        f"{measurements.longest_internal_silence_ms}ms unbroken internal silence",
    )

    seconds = max(measurements.duration_ms / 1000, 0.001)
    chars_per_second = source_char_count / seconds
    add(
        "duration_plausible_for_text",
        source_char_count == 0
        or limits.min_chars_per_second <= chars_per_second <= limits.max_chars_per_second,
        f"{chars_per_second:.1f} chars/second for {source_char_count} characters",
    )

    failing = next((c for c in checks if c.outcome == "FAIL"), None)
    return AudioValidation(
        status="FAIL" if failing else "PASS",
        checks=tuple(checks),
        measurements=measurements,
        failing_check=failing.check if failing else None,
    )


__all__ = [
    "AudioMeasurements",
    "AudioValidation",
    "CheckOutcome",
    "ValidationThresholds",
    "encode_wav",
    "measure_wav",
    "run_worker_checks",
]
