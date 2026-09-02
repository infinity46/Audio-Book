"""`MockTTSProvider` — the deterministic, GPU-free provider `deployment-architecture.md`
§6 makes a *mandatory* development capability, not a convenience.

It satisfies the full `TTSProvider` interface with synthetic output: a sine tone whose
frequency is a stable function of `voice_profile_version_id` (never of the chunk or a
random draw), so the same character renders at the same pitch in chapter 1 and chapter 50
— the exact property §71's speaker-consistency test checks for, made trivially true here
so contract/integration tests can assert on it without a real model. Duration is a
deterministic function of the input text length and the negotiated speed control, so
identical input always produces bit-identical output (§40.1's contract-determinism
guarantee, and — unlike a real engine — also model-determinism, since a tone generator has
no stochastic sampling to seed).

This is not a placeholder for a future engine; it stays in the codebase permanently as the
CI/unit-test/contract-test provider (`context.md` §22.2, `deployment-architecture.md` §7).
"""

from __future__ import annotations

import hashlib
import math
import time

from worker_gpu.tts.audio import encode_wav
from worker_gpu.tts.capability import negotiate
from worker_gpu.tts.errors import TtsError, TtsErrorCode
from worker_gpu.tts.schemas import (
    EmotionControl,
    ModelIdentity,
    ProviderCapabilities,
    ProviderHealth,
    ProviderVoiceHandle,
    ResourceEstimate,
    SynthesisRequest,
    SynthesisResult,
    VoiceReferenceKind,
    VoiceValidation,
)
from worker_gpu.tts.text_prep import prepare_text

_BASE_FREQUENCY_HZ = 160.0
_FREQUENCY_RANGE_HZ = 220.0
_CHARS_PER_SECOND = 14.0
_MIN_DURATION_MS = 250
_MAX_INPUT_CHARS = 2_000


def _voice_frequency(voice_profile_version_id: str) -> float:
    """A stable Hz value per voice, deterministic and never re-derived per chunk."""
    digest = hashlib.sha256(voice_profile_version_id.encode("utf-8")).digest()
    fraction = int.from_bytes(digest[:4], "big") / 0xFFFFFFFF
    return _BASE_FREQUENCY_HZ + fraction * _FREQUENCY_RANGE_HZ


class MockTTSProvider:
    """No GPU, no model weights, no network. Structurally a full `TTSProvider`."""

    def __init__(self, *, model_version: str = "v1") -> None:
        self._model_version = model_version
        self._loaded_model_version_id: str | None = None

    @property
    def id(self) -> str:
        return "mock-tts"

    @property
    def model_identity(self) -> ModelIdentity:
        return ModelIdentity(provider_id=self.id, model_id="mock-tone", version=self._model_version)

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            models=("mock-tone",),
            languages=("*",),
            max_input_chars=_MAX_INPUT_CHARS,
            native_sample_rate=24_000,
            supports_reference_audio=False,
            supports_embedding=False,
            supports_streaming=False,
            emotion_control=EmotionControl.NONE,
            deterministic_seed=True,
            max_batch=1,
            supports_pitch_control=True,
            supports_speed_control=True,
            supports_ssml=False,
            supports_phoneme_input=False,
        )

    async def load_model(self, model_version_id: str) -> None:
        # §51: a real provider's load() must VERIFY via test synthesis, not merely
        # allocate. The mock has nothing to allocate, so the verification IS the warmup
        # call below — exercising the exact code path load-bearing for MODEL_READY.
        _ = encode_wav([0.0] * 240, sample_rate=24_000, channels=1)
        self._loaded_model_version_id = model_version_id

    async def unload_model(self, model_version_id: str) -> None:
        self._loaded_model_version_id = None

    async def prepare_voice(self, request: SynthesisRequest) -> ProviderVoiceHandle:
        return ProviderVoiceHandle(
            voice_profile_version_id=request.voice_profile_version_id,
            provider_id=self.id,
            tts_model_version_id=request.tts_model_version_id,
            kind=VoiceReferenceKind.LIBRARY,
            payload={"frequency_hz": _voice_frequency(request.voice_profile_version_id)},
        )

    async def validate_voice(self, handle: ProviderVoiceHandle) -> VoiceValidation:
        if handle.provider_id != self.id:
            return VoiceValidation(
                valid=False, reason=f"Handle prepared for provider {handle.provider_id!r}, not {self.id!r}."
            )
        return VoiceValidation(valid=True)

    def estimate_resources(self, request: SynthesisRequest) -> ResourceEstimate:
        estimated_ms = max(_MIN_DURATION_MS, int(len(request.text) / _CHARS_PER_SECOND * 1000))
        return ResourceEstimate(vram_mb=0, estimated_duration_ms=estimated_ms)

    async def synthesize(
        self, request: SynthesisRequest, handle: ProviderVoiceHandle
    ) -> SynthesisResult:
        if self._loaded_model_version_id is None:
            raise TtsError(TtsErrorCode.MODEL_LOAD_FAILED, "MockTTSProvider.synthesize() called before load_model().")
        if handle.provider_id != self.id or handle.tts_model_version_id != request.tts_model_version_id:
            raise TtsError(
                TtsErrorCode.VOICE_MODEL_INCOMPATIBLE,
                "Voice handle was prepared for a different provider/model.",
            )

        capabilities = self.capabilities()
        negotiation = negotiate(
            request.performance,
            capabilities=capabilities,
            language=request.language,
            text_length=len(request.text),
        )
        prepared = prepare_text(request)

        base_frequency = handle.payload["frequency_hz"] if handle.payload else _BASE_FREQUENCY_HZ
        frequency = max(20.0, base_frequency + negotiation.controls.pitch_semitones * 6.0)
        amplitude = 0.35 * (10 ** (negotiation.controls.gain_db / 20))
        amplitude = max(0.02, min(0.9, amplitude))

        char_count = max(1, len(prepared.text))
        duration_s = max(
            _MIN_DURATION_MS / 1000,
            (char_count / _CHARS_PER_SECOND) / max(0.25, negotiation.controls.speed),
        )
        sample_rate = request.target_sample_rate
        channels = request.target_channels
        frame_count = int(duration_s * sample_rate)

        started = time.monotonic()
        mono = [
            amplitude * math.sin(2 * math.pi * frequency * (i / sample_rate))
            for i in range(frame_count)
        ]
        samples = mono if channels == 1 else [value for value in mono for _ in range(channels)]
        wav_bytes = encode_wav(samples, sample_rate=sample_rate, channels=channels)
        latency_ms = int((time.monotonic() - started) * 1000)

        return SynthesisResult(
            tts_job_id=request.tts_job_id,
            audio_script_chunk_id=request.audio_script_chunk_id,
            generation_version=1,  # the handler overwrites this with the real ordinal
            provider_id=self.id,
            tts_model_version_id=request.tts_model_version_id,
            voice_profile_version_id=request.voice_profile_version_id,
            audio_wav=wav_bytes,
            sample_rate=sample_rate,
            channels=channels,
            duration_ms=int(round(frame_count * 1000 / sample_rate)),
            generation_latency_ms=latency_ms,
            provider_metadata={"frequency_hz": round(frequency, 2), "note": "MockTTSProvider synthetic tone"},
            capability_gaps=negotiation.gaps,
            seed_used=request.seed,
        )

    async def health(self) -> ProviderHealth:
        return ProviderHealth(
            status="AVAILABLE" if self._loaded_model_version_id else "UNAVAILABLE",
            loaded_models=(self._loaded_model_version_id,) if self._loaded_model_version_id else (),
            vram_free_mb=None,
        )


__all__ = ["MockTTSProvider"]
