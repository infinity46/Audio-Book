"""Unit tests for `worker_gpu.tts.errors` (§78-§79): the taxonomy stays exhaustively
classified, and adapter error translation lands on the documented codes."""

from __future__ import annotations

from workers_common.queue import TerminalJobError, TransientJobError

from worker_gpu.tts.errors import CLASSIFICATION, Classification, TtsError, TtsErrorCode, classify_provider_error, to_job_error


def test_every_error_code_is_classified() -> None:
    """§78.2: no code may be left unclassified."""
    for code in TtsErrorCode:
        assert code in CLASSIFICATION, f"{code} has no classification"


def test_validation_verdict_is_never_retryable() -> None:
    """§21.3/§28.3: re-running a deterministic validation failure cannot fix it."""
    assert CLASSIFICATION[TtsErrorCode.AUDIO_VALIDATION_FAILED] is Classification.NON_RETRYABLE


def test_gpu_oom_is_retryable() -> None:
    assert CLASSIFICATION[TtsErrorCode.GPU_OUT_OF_MEMORY] is Classification.RETRYABLE


def test_missing_voice_profile_blocks_rather_than_retries() -> None:
    """§56.1: missing voice blocks, it does not retry its way to existing."""
    assert CLASSIFICATION[TtsErrorCode.MISSING_VOICE_PROFILE] is Classification.NON_RETRYABLE


def test_to_job_error_maps_retryable_to_transient() -> None:
    err = TtsError(TtsErrorCode.GPU_OUT_OF_MEMORY, "cuda oom")
    job_error = to_job_error(err)
    assert isinstance(job_error, TransientJobError)
    assert job_error.error_code == "GPU_OUT_OF_MEMORY"


def test_to_job_error_maps_non_retryable_to_terminal() -> None:
    err = TtsError(TtsErrorCode.VOICE_LANGUAGE_MISMATCH, "no fr-FR")
    job_error = to_job_error(err)
    assert isinstance(job_error, TerminalJobError)


def test_classify_provider_error_worked_examples() -> None:
    """§79.1's three worked examples, verbatim."""
    assert classify_provider_error(RuntimeError("CUDA out of memory")).code is TtsErrorCode.GPU_OUT_OF_MEMORY
    assert (
        classify_provider_error(RuntimeError("Voice embedding dimension mismatch")).code
        is TtsErrorCode.VOICE_MODEL_INCOMPATIBLE
    )
    assert classify_provider_error(RuntimeError("429 Too Many Requests")).code is TtsErrorCode.PROVIDER_RATE_LIMIT


def test_classify_provider_error_unrecognized_defaults_to_retryable_synthesis_failed() -> None:
    """§21.2's safe default: an unclassifiable failure is treated as retryable-but-bounded."""
    result = classify_provider_error(RuntimeError("some entirely novel engine error"))
    assert result.code is TtsErrorCode.SYNTHESIS_FAILED
    assert result.retryable is True


def test_classify_provider_error_passes_through_an_existing_tts_error() -> None:
    original = TtsError(TtsErrorCode.MODEL_NOT_FOUND, "not registered")
    assert classify_provider_error(original) is original
