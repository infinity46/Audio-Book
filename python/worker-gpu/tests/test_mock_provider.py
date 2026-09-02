"""Unit tests for `MockTTSProvider` — the mandatory GPU-free dev/CI provider
(`deployment-architecture.md` §6). These exercise the exact properties Phase 5's
acceptance criteria name: voice consistency (§10, §71) and contract determinism (§40.3)."""

from __future__ import annotations

import pytest

from worker_gpu.tts.errors import TtsError, TtsErrorCode
from worker_gpu.tts.providers.mock import MockTTSProvider
from worker_gpu.tts.schemas import PerformanceIntent, SpeakerReference, SynthesisRequest, VoiceReferenceKind


def _request(*, voice_profile_version_id: str, text: str = "Hello, world.", seed: int | None = 42) -> SynthesisRequest:
    return SynthesisRequest(
        audio_script_chunk_id="chunk-1",
        audio_script_chunk_version=1,
        audio_script_id="script-1",
        tts_job_id="job-1",
        correlation_id="corr-1",
        job_id="job-1",
        text=text,
        language="en-US",
        voice_profile_id="profile-1",
        voice_profile_version_id=voice_profile_version_id,
        speaker_reference=SpeakerReference(kind=VoiceReferenceKind.LIBRARY),
        tts_provider_id="mock-tts",
        tts_model_version_id="model-version-1",
        performance=PerformanceIntent(speaker_type="NARRATOR"),
        generation_params_hash="a" * 64,
        seed=seed,
        target_sample_rate=24_000,
        target_channels=1,
    )


async def _loaded_provider() -> MockTTSProvider:
    provider = MockTTSProvider()
    await provider.load_model("model-version-1")
    return provider


async def test_synthesize_before_load_raises_model_load_failed() -> None:
    provider = MockTTSProvider()
    request = _request(voice_profile_version_id="voice-a")
    handle = await provider.prepare_voice(request)
    with pytest.raises(TtsError) as excinfo:
        await provider.synthesize(request, handle)
    assert excinfo.value.code is TtsErrorCode.MODEL_LOAD_FAILED


async def test_same_voice_produces_same_frequency_across_calls() -> None:
    """§10.1/§71: the same VoiceProfileVersion must sound the same whether it is
    chapter 1 or chapter 50 -- never re-derived per chunk."""
    provider = await _loaded_provider()
    handle_a = await provider.prepare_voice(_request(voice_profile_version_id="voice-a"))
    handle_b = await provider.prepare_voice(_request(voice_profile_version_id="voice-a"))
    assert handle_a.payload["frequency_hz"] == handle_b.payload["frequency_hz"]


async def test_different_voices_produce_different_frequencies() -> None:
    provider = await _loaded_provider()
    handle_a = await provider.prepare_voice(_request(voice_profile_version_id="voice-a"))
    handle_b = await provider.prepare_voice(_request(voice_profile_version_id="voice-b"))
    assert handle_a.payload["frequency_hz"] != handle_b.payload["frequency_hz"]


async def test_synthesis_is_bit_exact_for_identical_input() -> None:
    """§40.1's contract-determinism guarantee. Unlike a real engine (§40.2), the mock
    tone generator has no stochastic sampling, so this holds at the byte level."""
    provider = await _loaded_provider()
    request = _request(voice_profile_version_id="voice-a")
    handle = await provider.prepare_voice(request)
    first = await provider.synthesize(request, handle)
    second = await provider.synthesize(request, handle)
    assert first.audio_wav == second.audio_wav


async def test_synthesis_duration_scales_with_text_length() -> None:
    provider = await _loaded_provider()
    request_short = _request(voice_profile_version_id="voice-a", text="Hi.")
    request_long = _request(
        voice_profile_version_id="voice-a",
        text="This is a considerably longer sentence than the other one.",
    )
    handle = await provider.prepare_voice(request_short)
    short_result = await provider.synthesize(request_short, handle)
    long_result = await provider.synthesize(request_long, handle)
    assert long_result.duration_ms > short_result.duration_ms


async def test_capability_gaps_are_carried_onto_the_result() -> None:
    provider = await _loaded_provider()
    request = _request(voice_profile_version_id="voice-a").model_copy(
        update={"performance": PerformanceIntent(speaker_type="CHARACTER", delivery_mode="WHISPER")}
    )
    handle = await provider.prepare_voice(request)
    result = await provider.synthesize(request, handle)
    assert any(gap.field == "delivery_mode" for gap in result.capability_gaps)


async def test_validate_voice_rejects_handle_from_a_different_provider() -> None:
    provider = await _loaded_provider()
    request = _request(voice_profile_version_id="voice-a")
    handle = await provider.prepare_voice(request)
    foreign_handle = handle.model_copy(update={"provider_id": "some-other-provider"})
    validation = await provider.validate_voice(foreign_handle)
    assert validation.valid is False


async def test_health_reports_unavailable_before_load() -> None:
    provider = MockTTSProvider()
    health = await provider.health()
    assert health.status == "UNAVAILABLE"


async def test_health_reports_available_after_load() -> None:
    provider = await _loaded_provider()
    health = await provider.health()
    assert health.status == "AVAILABLE"
