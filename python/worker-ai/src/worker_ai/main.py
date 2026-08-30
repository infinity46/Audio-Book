"""worker-ai -- the Director / LLM worker. Consumes the `ai` queue.

PHASE 1 SCAFFOLDING. This module wires configuration, logging, health and queue
consumption together and proves the lifecycle reaches MODEL_READY. It performs **no LLM
work of any kind**: there is no prompt construction, no context bundling, no model call,
and no IR generation anywhere in this service yet.

Job types this worker will eventually own (`event-contracts.md` §5.2, `ai` queue):
`analyze_scene`, `build_story_bible_delta`, `generate_director_ir`, `revise_director_ir`.
None of them are implemented. The handler below accepts a job, logs it, and returns.
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


class StubDirectorModelProvider:
    """A STUB. It loads nothing and cannot generate anything.

    This exists for exactly one reason: to prove that the HEALTHY -> MODEL_READY transition
    and the readiness endpoint work end to end. It is not a partial implementation of a
    Director model, and it must never be presented or measured as one.

    `load()` sleeps briefly and flips ready. That sleep is a deliberate placeholder for the
    real load's latency, so the "health endpoints must answer during model load" property
    of the startup path is actually exercised rather than assumed.

    Replacing this with a real provider means implementing the `ModelProvider` protocol
    against an actual LLM backend (a hosted API client, or vLLM if the deployment
    self-hosts). The lifecycle around it does not change.
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
            note="STUB provider: no model is being loaded. Phase 1 scaffolding only.",
        )
        await asyncio.sleep(0.1)  # placeholder for real load latency
        self._loaded = True

    async def unload(self) -> None:
        self._loaded = False
        log.info("model.stub_unloaded", model_id=self.model_id)

    @property
    def is_loaded(self) -> bool:
        return self._loaded


async def handle_job(envelope: CommandEnvelope) -> None:
    """STUB handler. Accepts a job, logs it, does nothing.

    Every id needed for correlation is already bound to the logging context by the time
    this runs (see `workers_common.correlation`), so nothing here passes ids explicitly.

    NOTE the deliberate absence of `envelope.payload` in the log call: an `ai`-queue payload
    references book content, and the logging contract forbids putting that in the log
    stream. Only the message type and identifiers are logged.
    """
    log.info(
        "job.received_by_stub",
        message_type=envelope.message_type.value,
        note="STUB handler: no Director work is performed. Phase 1 scaffolding only.",
    )


def create_app() -> FastAPI:
    settings = load_settings_or_exit()
    return create_worker_app(
        settings=settings,
        model_provider=StubDirectorModelProvider(settings),
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
