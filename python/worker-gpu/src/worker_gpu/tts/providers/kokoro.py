"""`KokoroProvider` — the first real TTS engine (`context.md` §23: Kokoro is named
alongside XTTS-v2 as one of the two v1-selected providers, chosen here as the first one
actually wired up because it is CPU-runnable, open-weight, and has a fixed, stable
per-voice identity that needs no reference-audio pipeline to stand up (§8 of the task
brief's selection criteria: local inference, stable voice identity, deployment
feasibility, no mandatory GPU).

This is the ONLY file in the codebase allowed to import `kokoro_onnx` or reference an ONNX
runtime concept (`tts-provider-specification.md` §88 rule 10-11). Everything it returns is
already translated into the provider-neutral shapes of `worker_gpu.tts.schemas`.

## Voice representation

Kokoro ships a fixed catalogue of named voices (e.g. `af_heart`, `am_michael`) rather than
supporting reference-audio cloning or speaker embeddings — `capabilities()` below declares
`supports_reference_audio=False` and `supports_embedding=False` accordingly (§7.3: a
predefined-voice provider is fully expressible through `capabilities()` alone). A
`VoiceProfileVersion` bound to this provider therefore carries the Kokoro voice name in its
own `base_generation_params` (the provider-specific parameter bag §41.1 already assigns
this to), under the key `kokoro_voice` — never as a new IR field, and never inferred by
this adapter.

## Model weights

Kokoro requires two on-disk artifacts (an ONNX model and a voices file). Boot-time
verification against `model_version.weights_content_hash` (§14.2) happens one layer up, in
`worker_gpu.tts.config`'s factory, which resolves and checksums the paths before this class
is even constructed — this class receives ready, verified file paths and does not fetch or
verify anything itself.

## Certification status

This adapter satisfies the `TTSProvider` contract structurally and is written against the
`kokoro-onnx` package's documented synchronous API. It has NOT been run through the seven
`tts-provider-specification.md` §73 certification gates (voice consistency, pronunciation,
long-form, benchmark, failure/retry, artifact integrity) — that is deployment-time work
requiring the actual model weights and a GPU-or-CPU target machine, both outside this
environment. Do not route production traffic to it before §73 has actually been run.
"""

from __future__ import annotations

import asyncio
import time
from functools import partial
from typing import Any

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

_DEFAULT_VOICE = "af_heart"
_NATIVE_SAMPLE_RATE = 24_000
_MAX_INPUT_CHARS = 500


class KokoroProvider:
    """Wraps `kokoro_onnx.Kokoro`. Requires the `worker-gpu[kokoro]` extra installed."""

    def __init__(self, *, model_path: str, voices_path: str, model_version: str) -> None:
        self._model_path = model_path
        self._voices_path = voices_path
        self._model_version = model_version
        self._engine: Any = None

    @property
    def id(self) -> str:
        return "kokoro-v1"

    @property
    def model_identity(self) -> ModelIdentity:
        return ModelIdentity(provider_id=self.id, model_id="kokoro", version=self._model_version)

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            models=("kokoro",),
            # Kokoro's public voice catalogue spans American/British English, plus a
            # handful of other languages depending on the release; American English is the
            # only one certified here (§73) and the only one this adapter advertises.
            languages=("en-US",),
            max_input_chars=_MAX_INPUT_CHARS,
            native_sample_rate=_NATIVE_SAMPLE_RATE,
            supports_reference_audio=False,
            supports_embedding=False,
            supports_streaming=False,
            emotion_control=EmotionControl.NONE,
            # No explicit seed parameter is exposed by kokoro-onnx's synchronous API; a
            # feed-forward ONNX graph over identical input is expected to be
            # reproducible in practice, but nothing here promises bit-exactness across
            # ONNX Runtime versions or hardware (§40.2 — declared false, the honest
            # default, until measured and certified otherwise per §73).
            deterministic_seed=False,
            max_batch=1,
            supports_pitch_control=False,
            supports_speed_control=True,
            supports_ssml=False,
            supports_phoneme_input=False,
        )

    async def load_model(self, model_version_id: str) -> None:
        try:
            from kokoro_onnx import Kokoro  # noqa: PLC0415 - the one place this import may occur
        except ImportError as exc:  # pragma: no cover - exercised only without the extra
            raise TtsError(
                TtsErrorCode.MODEL_LOAD_FAILED,
                "kokoro_onnx is not installed. Install the `worker-gpu[kokoro]` extra.",
            ) from exc

        try:
            self._engine = await asyncio.to_thread(Kokoro, self._model_path, self._voices_path)
            # §51/§18.1: MODEL_READY must mean "verified", not "a file was read" — run one
            # real synthesis before declaring readiness.
            await self._run_inference(f"warmup. model version {model_version_id}.", _DEFAULT_VOICE, 1.0)
        except TtsError:
            raise
        except Exception as exc:  # noqa: BLE001 - translate to the taxonomy, §79.2
            self._engine = None
            raise TtsError(TtsErrorCode.MODEL_LOAD_FAILED, f"Kokoro model load failed: {exc}") from exc

    async def unload_model(self, model_version_id: str) -> None:
        self._engine = None

    async def prepare_voice(self, request: SynthesisRequest) -> ProviderVoiceHandle:
        voice_name = str(request.generation_params.get("kokoro_voice", _DEFAULT_VOICE))
        return ProviderVoiceHandle(
            voice_profile_version_id=request.voice_profile_version_id,
            provider_id=self.id,
            tts_model_version_id=request.tts_model_version_id,
            kind=VoiceReferenceKind.LIBRARY,
            payload={"kokoro_voice": voice_name},
        )

    async def validate_voice(self, handle: ProviderVoiceHandle) -> VoiceValidation:
        if handle.provider_id != self.id:
            return VoiceValidation(valid=False, reason=f"Handle prepared for {handle.provider_id!r}.")
        voice_name = (handle.payload or {}).get("kokoro_voice")
        if not voice_name:
            return VoiceValidation(valid=False, reason="No kokoro_voice recorded on the handle.")
        return VoiceValidation(valid=True)

    def estimate_resources(self, request: SynthesisRequest) -> ResourceEstimate:
        # Measured, not invented (§19.1) — these are placeholders pending the §69/§72
        # benchmark this environment cannot run; a deployment MUST replace them with
        # measured figures before relying on them for scheduling.
        estimated_ms = max(300, int(len(request.text) / 14 * 1000))
        return ResourceEstimate(vram_mb=1_500, estimated_duration_ms=estimated_ms)

    async def synthesize(
        self, request: SynthesisRequest, handle: ProviderVoiceHandle
    ) -> SynthesisResult:
        if self._engine is None:
            raise TtsError(TtsErrorCode.MODEL_LOAD_FAILED, "KokoroProvider.synthesize() called before load_model().")
        if handle.provider_id != self.id or handle.tts_model_version_id != request.tts_model_version_id:
            raise TtsError(
                TtsErrorCode.VOICE_MODEL_INCOMPATIBLE,
                "Voice handle was prepared for a different provider/model.",
            )

        negotiation = negotiate(
            request.performance,
            capabilities=self.capabilities(),
            language=request.language,
            text_length=len(request.text),
        )
        prepared = prepare_text(request)
        voice_name = (handle.payload or {}).get("kokoro_voice", _DEFAULT_VOICE)

        started = time.monotonic()
        samples, sample_rate = await self._run_inference(
            prepared.text, voice_name, negotiation.controls.speed
        )
        latency_ms = int((time.monotonic() - started) * 1000)

        channels = request.target_channels
        frame_samples = samples if channels == 1 else [v for v in samples for _ in range(channels)]
        wav_bytes = encode_wav(frame_samples, sample_rate=sample_rate, channels=channels)

        return SynthesisResult(
            tts_job_id=request.tts_job_id,
            audio_script_chunk_id=request.audio_script_chunk_id,
            generation_version=1,  # overwritten by the handler with the real ordinal
            provider_id=self.id,
            tts_model_version_id=request.tts_model_version_id,
            voice_profile_version_id=request.voice_profile_version_id,
            audio_wav=wav_bytes,
            sample_rate=sample_rate,
            channels=channels,
            duration_ms=int(round(len(samples) * 1000 / sample_rate)),
            generation_latency_ms=latency_ms,
            provider_metadata={"kokoro_voice": voice_name},
            capability_gaps=negotiation.gaps,
            seed_used=None,
        )

    async def health(self) -> ProviderHealth:
        return ProviderHealth(
            status="AVAILABLE" if self._engine is not None else "UNAVAILABLE",
            loaded_models=(self._model_version,) if self._engine is not None else (),
            vram_free_mb=None,
        )

    async def _run_inference(
        self, text: str, voice_name: str, speed: float
    ) -> tuple[list[float], int]:
        """The one call into `kokoro_onnx`. Dispatched to a thread: the ONNX runtime call
        is synchronous and CPU/GPU-bound, and must not block the worker's event loop."""
        try:
            samples, sample_rate = await asyncio.to_thread(
                partial(self._engine.create, text, voice=voice_name, speed=speed, lang="en-us")
            )
        except Exception as exc:  # noqa: BLE001 - §79.2 translation boundary
            raise TtsError(TtsErrorCode.SYNTHESIS_FAILED, f"Kokoro inference failed: {exc}") from exc
        return list(samples), int(sample_rate)


__all__ = ["KokoroProvider"]
