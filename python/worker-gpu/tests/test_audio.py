"""Unit tests for `worker_gpu.tts.audio` — encode/measure round-trip and the worker-side
technical checks (§26-§30, §64-§67)."""

from __future__ import annotations

import math

import pytest

from worker_gpu.tts.audio import ValidationThresholds, encode_wav, measure_wav, run_worker_checks
from worker_gpu.tts.errors import TtsError, TtsErrorCode


def _tone(*, frequency: float, seconds: float, sample_rate: int, amplitude: float = 0.5) -> list[float]:
    n = int(seconds * sample_rate)
    return [amplitude * math.sin(2 * math.pi * frequency * (i / sample_rate)) for i in range(n)]


def test_encode_measure_round_trip_reports_correct_shape() -> None:
    samples = _tone(frequency=220.0, seconds=1.0, sample_rate=24_000)
    wav = encode_wav(samples, sample_rate=24_000, channels=1)
    measurements = measure_wav(wav)
    assert measurements.sample_rate == 24_000
    assert measurements.channels == 1
    assert 990 <= measurements.duration_ms <= 1010
    assert measurements.clipped_sample_ratio == 0.0
    assert measurements.peak_dbfs < 0.0  # amplitude 0.5 is well under full scale


def test_full_scale_amplitude_is_flagged_as_clipping() -> None:
    # A full-scale SINE only reaches full scale at the top of each cycle, so
    # its clipped-sample ratio is a few percent — not a majority. What matters
    # is that it clears the rejection threshold, which is what the real guard
    # (`true_peak_clipping`) compares against.
    samples = _tone(frequency=220.0, seconds=0.5, sample_rate=24_000, amplitude=1.0)
    wav = encode_wav(samples, sample_rate=24_000, channels=1)
    measurements = measure_wav(wav)
    assert measurements.clipped_sample_ratio > ValidationThresholds().max_clipped_sample_ratio

    outcome = run_worker_checks(
        wav, expected_sample_rate=24_000, expected_channels=1, source_char_count=60
    )
    assert outcome.status == "FAIL"
    assert outcome.failing_check == "true_peak_clipping"


def test_silent_audio_is_measured_as_silent() -> None:
    wav = encode_wav([0.0] * 24_000, sample_rate=24_000, channels=1)
    measurements = measure_wav(wav)
    assert measurements.rms_dbfs <= -60.0
    assert measurements.leading_silence_ms >= 900


def test_nan_sample_raises_audio_corrupted() -> None:
    with pytest.raises(TtsError) as excinfo:
        encode_wav([0.0, float("nan"), 0.0], sample_rate=24_000, channels=1)
    assert excinfo.value.code is TtsErrorCode.AUDIO_CORRUPTED


def test_undecodable_bytes_raise_audio_corrupted() -> None:
    with pytest.raises(TtsError) as excinfo:
        measure_wav(b"not a wav file")
    assert excinfo.value.code is TtsErrorCode.AUDIO_CORRUPTED


def test_worker_checks_pass_for_well_formed_audio() -> None:
    text = "Hello there, this is a normal sentence of speech."
    samples = _tone(frequency=180.0, seconds=len(text) / 14.0, sample_rate=24_000)
    wav = encode_wav(samples, sample_rate=24_000, channels=1)
    outcome = run_worker_checks(
        wav, expected_sample_rate=24_000, expected_channels=1, source_char_count=len(text)
    )
    assert outcome.status == "PASS"
    assert outcome.failing_check is None


def test_worker_checks_fail_on_wrong_sample_rate() -> None:
    samples = _tone(frequency=180.0, seconds=1.0, sample_rate=16_000)
    wav = encode_wav(samples, sample_rate=16_000, channels=1)
    outcome = run_worker_checks(wav, expected_sample_rate=24_000, expected_channels=1, source_char_count=14)
    assert outcome.status == "FAIL"
    assert outcome.failing_check == "sample_rate_matches_expected"


def test_worker_checks_fail_on_implausible_duration_for_text() -> None:
    """100 characters rendered in 10ms is exactly the §67 failure mode."""
    thresholds = ValidationThresholds(min_duration_ms=1)
    samples = _tone(frequency=180.0, seconds=0.01, sample_rate=24_000)
    wav = encode_wav(samples, sample_rate=24_000, channels=1)
    outcome = run_worker_checks(
        wav,
        expected_sample_rate=24_000,
        expected_channels=1,
        source_char_count=100,
        thresholds=thresholds,
    )
    assert outcome.status == "FAIL"
    assert outcome.failing_check == "duration_plausible_for_text"


def test_worker_checks_do_not_reject_intentional_dramatic_pause_by_default() -> None:
    """§30.2 — a moderate internal gap must not be auto-rejected as if it were pathological."""
    speech_a = _tone(frequency=180.0, seconds=0.5, sample_rate=24_000)
    silence = [0.0] * int(0.4 * 24_000)
    speech_b = _tone(frequency=180.0, seconds=0.5, sample_rate=24_000)
    wav = encode_wav(speech_a + silence + speech_b, sample_rate=24_000, channels=1)
    outcome = run_worker_checks(wav, expected_sample_rate=24_000, expected_channels=1, source_char_count=20)
    assert outcome.status == "PASS"
