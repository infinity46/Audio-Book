"""worker-gpu -- the TTS worker. Consumes the `gpu` queue.

Phase 5 replaces the Phase 1 `StubTTSProvider`/`handle_job` scaffolding with the real TTS
Provider Runtime: a configurable `TTSProvider` (`mock` by default, `kokoro` where
configured), the capability negotiation and audio-validation pipeline of `worker_gpu.tts`,
and the two job handlers this worker actually owns -- `generate_tts_chunk` and
`generate_voice_preview` (`event-contracts.md` §5.2, `gpu` queue).

## Deployment isolation

worker-gpu is ALWAYS its own deployment unit, mirroring `worker-ai/main.py`'s note: never
co-located with worker-ai, worker-cpu, or the Node services, both because GPU nodes are the
expensive, separately-scaled resource, and because this worker runs third-party model code
over every tenant's content, so its blast radius is deliberately kept small (the narrow
`app_worker_gpu` DB role in `workers_common.db`'s docstring is the other half of that).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import FastAPI

from worker_gpu.handlers.generate_tts_chunk import handle_generate_tts_chunk
from worker_gpu.handlers.generate_voice_preview import handle_generate_voice_preview
from worker_gpu.tts import TTSProvider, TtsConfig, VoiceCache, build_tts_provider, load_tts_config
from workers_common import (
    WorkerSettings,
    get_logger,
    load_settings_or_exit,
)
from workers_common.queue import JobContext
from workers_common.runtime import create_worker_app

log = get_logger(__name__)


class TTSModelProviderAdapter:
    """Adapts a `TTSProvider` to `workers_common.runtime.ModelProvider`.

    `load()` is where §51's model warming and §18.1's `COLD -> LOADING -> READY`
    transition actually happen -- `TTSProvider.load_model()` itself is required to VERIFY
    (a real synthesis, not just an allocation) before returning, which is what makes this
    worker's `MODEL_READY` state honest (`workers_common.runtime.ModelProvider`'s own
    contract). The identity passed to `load_model`/`unload_model` is a diagnostic label,
    not the database's `model_version.id` -- the authoritative DB-registered UUID is
    resolved fresh, per job, via `worker_gpu.repo.model_registry` inside each handler
    (§13.3: a worker's *advertised* identity is what is checked against the job's pinned
    UUID, not whatever label it logged at boot).
    """

    def __init__(self, provider: TTSProvider) -> None:
        self._provider = provider

    @property
    def model_id(self) -> str:
        identity = self._provider.model_identity
        return f"{identity.provider_id}/{identity.model_id}@{identity.version}"

    async def load(self) -> None:
        await self._provider.load_model(self._provider.model_identity.version)
        log.info("tts_provider.ready", model_id=self.model_id)

    async def unload(self) -> None:
        await self._provider.unload_model(self._provider.model_identity.version)

    @property
    def is_loaded(self) -> bool:
        return True


def _build_handler(
    provider: TTSProvider, voice_cache: VoiceCache
) -> Callable[[JobContext], Awaitable[None]]:
    async def handle_job(ctx: JobContext) -> None:
        if ctx.message_type == "generate_tts_chunk":
            await handle_generate_tts_chunk(ctx, provider=provider, voice_cache=voice_cache)
        elif ctx.message_type == "generate_voice_preview":
            await handle_generate_voice_preview(ctx, provider=provider, voice_cache=voice_cache)
        else:
            log.warning("job.unknown_message_type", message_type=ctx.message_type)

    return handle_job


def create_app() -> FastAPI:
    settings = load_settings_or_exit()
    tts_config: TtsConfig = load_tts_config()
    provider = build_tts_provider(tts_config)
    voice_cache = VoiceCache(max_size=tts_config.voice_cache_size, on_evict=_evict_voice)

    return create_worker_app(
        settings=settings,
        model_provider=TTSModelProviderAdapter(provider),
        handler=_build_handler(provider, voice_cache),
    )


async def _evict_voice(handle: object) -> None:
    # §94 -- eviction releases whatever the adapter held for this voice (an embedding
    # tensor, a decoded reference clip). Every current adapter's handle payload is a plain
    # dict with no external resource to release, so this is a no-op today; it exists as the
    # seam a future provider with real GPU-resident voice state plugs into.
    return None


app = create_app()


def main() -> None:
    """Container entrypoint."""
    import uvicorn

    settings = load_settings_or_exit()
    uvicorn.run(
        app,
        host="0.0.0.0",  # noqa: S104 - bound inside the pod network, not publicly routed
        port=settings.app.health_port,
        log_config=None,  # structlog owns logging; uvicorn must not reconfigure it
        access_log=False,  # probe traffic would otherwise dominate the log volume
    )


if __name__ == "__main__":
    main()
