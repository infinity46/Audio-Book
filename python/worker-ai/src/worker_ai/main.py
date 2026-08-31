"""worker-ai -- the Director / narrative-understanding worker. Consumes the `ai` queue.

Phase 3 implements two of this worker's four eventual job types for real:
`analyze_scene` and `build_story_bible_delta` (narrative understanding -- character
registry, scenes, relationships, Story Bible, narrative state). `generate_director_ir`
and `revise_director_ir` (the Director itself -- speaker/emotion/pacing decisions,
Audio Script IR) remain an explicit no-op stub: that is Phase 4, and nothing in this
module produces a performance decision of any kind.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import FastAPI

from worker_ai.handlers.analyze_scene import handle_analyze_scene
from worker_ai.handlers.build_story_bible_delta import handle_build_story_bible_delta
from worker_ai.queue_producer import BullMqAiQueueProducer, QueueProducer
from worker_ai.semantic import SemanticAnalyzer, build_semantic_analyzer, load_semantic_config
from workers_common import (
    get_logger,
    load_settings_or_exit,
)
from workers_common.queue import JobContext
from workers_common.runtime import create_worker_app

log = get_logger(__name__)


class SemanticAnalyzerModelProvider:
    """Adapts a `SemanticAnalyzer` to `workers_common.runtime.ModelProvider`.

    The deterministic analyzer needs no loading at all -- `load()` is an immediate
    no-op, and MODEL_READY is reached as soon as dependencies (DB/Redis/storage) are
    verified. An `openai_compatible` analyzer similarly performs no eager connection
    check here (the endpoint is verified on first real use); this keeps the startup
    path identical regardless of which provider `SEMANTIC_ANALYZER_PROVIDER` selects.
    """

    def __init__(self, analyzer: SemanticAnalyzer) -> None:
        self._analyzer = analyzer

    @property
    def model_id(self) -> str:
        identity = self._analyzer.model_identity
        return f"{identity.provider_id}/{identity.model_id}@{identity.version}"

    async def load(self) -> None:
        log.info("semantic_analyzer.ready", model_id=self.model_id)

    async def unload(self) -> None:
        aclose = getattr(self._analyzer, "aclose", None)
        if aclose is not None:
            await aclose()

    @property
    def is_loaded(self) -> bool:
        return True


def _build_handler(
    analyzer: SemanticAnalyzer, queue_producer: QueueProducer
) -> Callable[[JobContext], Awaitable[None]]:
    async def handle_job(ctx: JobContext) -> None:
        if ctx.message_type == "analyze_scene":
            await handle_analyze_scene(ctx, analyzer=analyzer, queue_producer=queue_producer)
        elif ctx.message_type == "build_story_bible_delta":
            await handle_build_story_bible_delta(ctx, queue_producer=queue_producer)
        elif ctx.message_type in ("generate_director_ir", "revise_director_ir"):
            log.info(
                "job.received_by_stub",
                message_type=ctx.message_type,
                note="STUB handler: the Director is Phase 4. No IR is generated here.",
            )
        else:
            log.warning("job.unknown_message_type", message_type=ctx.message_type)

    return handle_job


def create_app() -> FastAPI:
    settings = load_settings_or_exit()
    semantic_config = load_semantic_config()
    analyzer = build_semantic_analyzer(semantic_config)
    queue_producer: QueueProducer = BullMqAiQueueProducer(
        redis_url=str(settings.secrets.redis_url), queue_prefix=settings.app.queue_prefix
    )

    return create_worker_app(
        settings=settings,
        model_provider=SemanticAnalyzerModelProvider(analyzer),
        handler=_build_handler(analyzer, queue_producer),
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
