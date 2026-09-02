"""worker-ai -- the Director / narrative-understanding worker. Consumes the `ai` queue.

Phase 3 implements `analyze_scene` and `build_story_bible_delta` (narrative
understanding -- character registry, scenes, relationships, Story Bible,
narrative state). Phase 4 implements the remaining two job types:
`generate_director_ir` and `revise_director_ir` (the Director -- speaker
resolution, emotion/pacing/delivery decisions, Audio Script IR generation and
validation). Both job families run in this one process against the same `ai`
queue, each behind its own provider-independent seam
(`worker_ai.semantic.SemanticAnalyzer` / `worker_ai.director.DirectorModelProvider`)
so neither depends on a specific LLM provider or on the other's implementation.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import FastAPI

from worker_ai.director import DirectorModelProvider, build_director_provider, load_director_config
from worker_ai.handlers.analyze_scene import handle_analyze_scene
from worker_ai.handlers.build_story_bible_delta import handle_build_story_bible_delta
from worker_ai.handlers.generate_director_ir import handle_generate_director_ir
from worker_ai.handlers.revise_director_ir import handle_revise_director_ir
from worker_ai.queue_producer import BullMqAiQueueProducer, QueueProducer
from worker_ai.semantic import SemanticAnalyzer, build_semantic_analyzer, load_semantic_config
from workers_common import (
    get_logger,
    load_settings_or_exit,
)
from workers_common.queue import JobContext
from workers_common.runtime import ModelProvider, create_worker_app

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


class DirectorModelProviderAdapter:
    """Adapts a `DirectorModelProvider` to `workers_common.runtime.ModelProvider`,
    mirroring `SemanticAnalyzerModelProvider` exactly -- see that class's
    docstring for why `load()` is a no-op for the deterministic default and
    an `openai_compatible` provider performs no eager connection check."""

    def __init__(self, provider: DirectorModelProvider) -> None:
        self._provider = provider

    @property
    def model_id(self) -> str:
        identity = self._provider.model_identity
        return f"{identity.provider_id}/{identity.model_id}@{identity.version}"

    async def load(self) -> None:
        log.info("director_provider.ready", model_id=self.model_id)

    async def unload(self) -> None:
        aclose = getattr(self._provider, "aclose", None)
        if aclose is not None:
            await aclose()

    @property
    def is_loaded(self) -> bool:
        return True


class CompositeModelProvider:
    """This worker consumes two families of `ai`-queue jobs (narrative
    understanding, and the Director) with two independently-configured
    providers -- but `workers_common.runtime.WorkerRuntime` (shared by every
    worker in this repo) tracks readiness for exactly ONE `ModelProvider`.
    Rather than widen that shared contract for one worker's needs, this
    composes both providers behind the single-provider interface: `load()`/
    `unload()` delegate to both, and `model_id` reports both identities so
    an operator can see which two are actually running.
    """

    def __init__(self, *providers: ModelProvider) -> None:
        self._providers = providers

    @property
    def model_id(self) -> str:
        return "+".join(p.model_id for p in self._providers)

    async def load(self) -> None:
        for p in self._providers:
            await p.load()

    async def unload(self) -> None:
        for p in self._providers:
            await p.unload()


def _build_handler(
    analyzer: SemanticAnalyzer,
    director_provider: DirectorModelProvider,
    queue_producer: QueueProducer,
) -> Callable[[JobContext], Awaitable[None]]:
    async def handle_job(ctx: JobContext) -> None:
        if ctx.message_type == "analyze_scene":
            await handle_analyze_scene(ctx, analyzer=analyzer, queue_producer=queue_producer)
        elif ctx.message_type == "build_story_bible_delta":
            await handle_build_story_bible_delta(ctx, queue_producer=queue_producer)
        elif ctx.message_type == "generate_director_ir":
            await handle_generate_director_ir(
                ctx, provider=director_provider, queue_producer=queue_producer
            )
        elif ctx.message_type == "revise_director_ir":
            await handle_revise_director_ir(ctx, provider=director_provider)
        else:
            log.warning("job.unknown_message_type", message_type=ctx.message_type)

    return handle_job


def create_app() -> FastAPI:
    settings = load_settings_or_exit()
    semantic_config = load_semantic_config()
    analyzer = build_semantic_analyzer(semantic_config)
    director_config = load_director_config()
    director_provider = build_director_provider(director_config)
    queue_producer: QueueProducer = BullMqAiQueueProducer(
        redis_url=str(settings.secrets.redis_url), queue_prefix=settings.app.queue_prefix
    )

    return create_worker_app(
        settings=settings,
        model_provider=CompositeModelProvider(
            SemanticAnalyzerModelProvider(analyzer),
            DirectorModelProviderAdapter(director_provider),
        ),
        handler=_build_handler(analyzer, director_provider, queue_producer),
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
