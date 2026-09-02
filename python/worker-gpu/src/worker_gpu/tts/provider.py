"""The `TTSProvider` interface (`tts-provider-specification.md` §3.2).

This is the whole seam. Everything above it -- the handler, the repositories, the job
lifecycle -- is written against this Protocol and never against an engine, which is what
§88 rules 9-11 require ("no `if provider == 'xtts'` anywhere").

A Protocol rather than an ABC, matching how `worker_ai.director.analyzer` and
`workers_common.runtime.ModelProvider` already declare their seams in this codebase: an
adapter satisfies it structurally, without importing anything from here, so a future
adapter package cannot accidentally acquire a dependency on the core.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from worker_gpu.tts.schemas import (
    ModelIdentity,
    ProviderCapabilities,
    ProviderHealth,
    ProviderVoiceHandle,
    ResourceEstimate,
    SynthesisRequest,
    SynthesisResult,
    VoiceValidation,
)


@runtime_checkable
class TTSProvider(Protocol):
    """§3.2's operations, with the exact names the specification fixes."""

    @property
    def id(self) -> str:
        """Stable provider abstraction id (e.g. `kokoro-v1`). Never a hostname or worker
        address -- it is a routing and lineage identity (§3.2)."""
        ...

    @property
    def model_identity(self) -> ModelIdentity:
        """The (TTS, provider_id, model_id, version) tuple this adapter resolves against
        `model_registry`. Not part of §3.2's list; it exists because every generation must
        record a real `ModelVersion` id (§13.1) and the adapter is what knows which one."""
        ...

    def capabilities(self) -> ProviderCapabilities:
        """§3.3. Declared once and cached; never inferred by probing mid-request."""
        ...

    async def load_model(self, model_version_id: str) -> None:
        """§18. Load and VERIFY the weights, including a warmup synthesis (§51).

        Must raise on failure: a provider that returns without a working model drives the
        worker to MODEL_READY and causes real work to be routed to it.
        """
        ...

    async def unload_model(self, model_version_id: str) -> None:
        """§18.1's `UNLOADING`. Called on drain and on eviction. Must not raise."""
        ...

    async def prepare_voice(self, request: SynthesisRequest) -> ProviderVoiceHandle:
        """§7.4. Resolve a `VoiceProfileVersion` into something this engine can use.

        Runs once per `(worker, VoiceProfileVersion)` and its result is cached (§8.1, §92)
        -- never re-run per chunk, which is what keeps a character acoustically identical
        across chapters (§10.1) rather than re-derived each time.
        """
        ...

    async def validate_voice(self, handle: ProviderVoiceHandle) -> VoiceValidation:
        """§7.4's cheap precondition -- e.g. embedding dimension against the loaded model.

        A mismatch surfaces as `VOICE_MODEL_INCOMPATIBLE` (§9.2) before an inference
        attempt is spent, and never as a silent substitution of a "close enough" voice
        (§10.2 rule 3).
        """
        ...

    def estimate_resources(self, request: SynthesisRequest) -> ResourceEstimate:
        """§19.4. Advisory only. A scheduler that treats this as exact will eventually
        OOM, which is why §56.2's retry ladder exists."""
        ...

    async def synthesize(
        self, request: SynthesisRequest, handle: ProviderVoiceHandle
    ) -> SynthesisResult:
        """§4-§5. The one operation that produces audio.

        The adapter owns every translation from semantic intent to engine controls (§41.2)
        and MUST record a `capability_gap` for each field it could not honour exactly
        (§32.3), rather than dropping it.
        """
        ...

    async def health(self) -> ProviderHealth:
        """§3.2. Liveness plus loaded-model state."""
        ...


__all__ = ["TTSProvider"]
