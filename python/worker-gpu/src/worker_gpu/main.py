"""worker-gpu -- the TTS worker. Consumes the `gpu` queue.

PHASE 1 SCAFFOLDING. This module wires configuration, logging, health and queue
consumption together and proves the lifecycle reaches MODEL_READY. It performs **no speech
synthesis of any kind**: there is no model, no CUDA, no vocoder, and no audio output
anywhere in this service yet.

There is deliberately no `generate_fake_audio()` here. A stub that returned plausible
silent WAV bytes would flow through validation and assembly and produce a "successful"
audiobook of nothing, and the failure would surface far from its cause. The stub provider
below loads nothing and the handler synthesizes nothing; both say so loudly.

Job types this worker will eventually own (`event-contracts.md` §5.2, `gpu` queue):
`generate_tts_chunk`, `generate_voice_preview`, and `verify_transcript` where the
deployment routes ASR to GPU.

## Deployment isolation

worker-gpu is ALWAYS its own deployment unit. It is never co-located in a process or
container with worker-ai, worker-cpu, or the Node services. Two reasons, both load-bearing:
GPU nodes are the expensive, separately-scaled resource and must not be occupied by CPU
work; and this worker runs third-party model code over every tenant's content, so its blast
radius is deliberately kept small (see the narrow-role note in `workers_common.db`).
"""

from __future__ import annotations

import asyncio

from fastapi import FastAPI

from workers_common import (
    CommandEnvelope,
    WorkerSettings,
    get_logger,
    load_settings_or_exit,
)
from workers_common.runtime import create_worker_app

log = get_logger(__name__)


class StubTTSProvider:
    """A STUB. It loads no model, allocates no GPU memory, and synthesizes nothing.

    This exists for exactly one reason: to prove that the HEALTHY -> MODEL_READY transition
    and the readiness endpoint work end to end. It is NOT a TTS implementation, it does not
    produce audio, and it must never be swapped in for one or benchmarked as one.

    Replacing this with a real provider means implementing the `ModelProvider` protocol
    against an actual GPU-backed engine, at which point `load()` becomes real weight
    loading plus a verification pass, and the job handler gains real synthesis. Everything
    around it -- lifecycle, health, drain, correlation -- stays exactly as it is. That is
    the point of the seam.

    Two things the real implementation must add that this stub deliberately does not fake:

      * `load()` must VERIFY the model after loading (a test synthesis), not merely
        allocate it. MODEL_READY asserts the model works, not that a file was read.
      * The provider must advertise its concurrency from measured VRAM headroom, since
        the queue does not guess it (`context.md` §10.4 step 4).
    """

    def __init__(self, settings: WorkerSettings) -> None:
        self._settings = settings
        self._loaded = False

    @property
    def model_id(self) -> str:
        return self._settings.model.model_id

    async def load(self) -> None:
        log.warning(
            "model.stub_load",
            model_id=self.model_id,
            note="STUB provider: no TTS model is being loaded and no GPU is being "
            "allocated. Phase 1 scaffolding only.",
        )
        await asyncio.sleep(0.1)  # placeholder for real weight-load + verification latency
        self._loaded = True

    async def unload(self) -> None:
        # A real implementation frees VRAM here. Doing it on the drain path rather than at
        # process exit matters: a worker that holds its allocation until SIGKILL can leave
        # the GPU unusable for the replacement pod scheduled onto the same device.
        self._loaded = False
        log.info("model.stub_unloaded", model_id=self.model_id)

    @property
    def is_loaded(self) -> bool:
        return self._loaded


async def handle_job(envelope: CommandEnvelope) -> None:
    """STUB handler. Accepts a job, logs it, synthesizes nothing.

    It returns normally, which acks the job. That is correct for Phase 1 -- there is no
    queue wired to a real producer yet -- but it is the single most important line to
    change when real synthesis lands: acking without producing audio would silently mark
    chunks complete.
    """
    log.info(
        "job.received_by_stub",
        message_type=envelope.message_type.value,
        note="STUB handler: no synthesis is performed and no audio is produced. "
        "Phase 1 scaffolding only.",
    )


def create_app() -> FastAPI:
    settings = load_settings_or_exit()
    return create_worker_app(
        settings=settings,
        model_provider=StubTTSProvider(settings),
        handler=handle_job,
    )


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
