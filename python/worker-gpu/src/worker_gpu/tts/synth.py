"""The shared middle phase: prepare voice, validate, synthesize, technical-check.

Factored out because `generate_tts_chunk` and `generate_voice_preview` both need exactly
this sequence and nothing else — a preview differs only in *what it does with the result*
(a disposable `VoicePreview` row instead of a lineage-bearing `AudioChunk`), never in how
the audio itself gets made (§47.1: a preview MUST use the same provider, model, and
generation parameters as production for that `VoiceProfileVersion`).
"""

from __future__ import annotations

from dataclasses import dataclass

from worker_gpu.tts.audio import AudioValidation, run_worker_checks
from worker_gpu.tts.errors import TtsError, TtsErrorCode
from worker_gpu.tts.provider import TTSProvider
from worker_gpu.tts.schemas import ProviderVoiceHandle, SynthesisRequest, SynthesisResult
from worker_gpu.tts.voice_cache import VoiceCache


@dataclass(frozen=True, slots=True)
class SynthesisOutcome:
    result: SynthesisResult
    technical: AudioValidation


async def prepare_voice_cached(
    provider: TTSProvider, request: SynthesisRequest, cache: VoiceCache
) -> ProviderVoiceHandle:
    """§8.1/§92 — resolve once per `(worker, VoiceProfileVersion)`, cached thereafter."""
    key = (request.voice_profile_version_id, provider.id, request.tts_model_version_id)
    cached = cache.get(key)
    if cached is not None:
        return cached
    handle = await provider.prepare_voice(request)
    await cache.put(handle)
    return handle


async def synthesize_and_check(
    provider: TTSProvider, request: SynthesisRequest, voice_cache: VoiceCache
) -> SynthesisOutcome:
    """`prepare_voice -> validate_voice -> synthesize -> technical checks` (§7.4, §4-§5,
    §28.3). Raises `TtsError` for any failure in the chain, already mapped onto the
    taxonomy by the individual pieces (`audio.py` raises `AUDIO_CORRUPTED` directly)."""
    handle = await prepare_voice_cached(provider, request, voice_cache)
    validation = await provider.validate_voice(handle)
    if not validation.valid:
        raise TtsError(
            TtsErrorCode.VOICE_MODEL_INCOMPATIBLE,
            validation.reason or "Voice handle failed provider validation.",
        )
    result = await provider.synthesize(request, handle)
    technical = run_worker_checks(
        result.audio_wav,
        expected_sample_rate=request.target_sample_rate,
        expected_channels=request.target_channels,
        source_char_count=len(request.text),
    )
    return SynthesisOutcome(result=result, technical=technical)


__all__ = ["SynthesisOutcome", "prepare_voice_cached", "synthesize_and_check"]
