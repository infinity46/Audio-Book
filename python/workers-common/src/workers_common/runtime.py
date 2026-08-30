"""Worker lifecycle orchestration.

This exists so that `worker-ai/main.py` and `worker-gpu/main.py` stay genuinely thin. The
startup sequence, the signal handling and the drain ordering are identical for both workers
and are easy to get subtly wrong, so they live here and are written once.

The startup sequence, in order:

    STARTING      construct dependencies
                  verify storage, queue and database are all reachable
    HEALTHY       dependencies verified -- the process is alive, but cannot work yet
                  load the assigned model set via the injected ModelProvider
    MODEL_READY   readiness flips true; the consumer starts
    IDLE          consuming, awaiting work

    ... SIGTERM ...

    DRAINING      stop accepting, finish in-flight work within the grace period,
                  close queue, close storage, dispose db, flush logs
    STOPPED       exit 0
"""

from __future__ import annotations

import asyncio
import contextlib
import signal
from collections.abc import AsyncIterator
from typing import Protocol, runtime_checkable

from fastapi import FastAPI

from workers_common.config import WorkerSettings
from workers_common.db import Database
from workers_common.events import CommandEnvelope
from workers_common.health import WorkerHealth, WorkerState, create_health_router
from workers_common.logging import configure_logging, get_logger
from workers_common.queue import JobHandler, QueueConsumer
from workers_common.storage import ObjectStorage

log = get_logger(__name__)


@runtime_checkable
class ModelProvider(Protocol):
    """The seam a real model implementation plugs into.

    Phase 1 ships only stubs behind this. The interface exists so that the lifecycle can be
    built and tested now, and so that the eventual real provider is a drop-in replacement
    rather than a rewrite of the startup path.

    A `ModelProvider` is responsible for exactly two things: making itself ready, and
    releasing its resources. It is NOT responsible for doing work -- that is the job
    handler's concern. This keeps the readiness signal honest: `MODEL_READY` means "load
    succeeded and was verified", nothing more.
    """

    @property
    def model_id(self) -> str: ...

    async def load(self) -> None:
        """Load and VERIFY the assigned model set.

        Must raise on failure. A provider that returns without a usable model would drive
        the worker to MODEL_READY and cause the orchestrator to route real work to it.
        """
        ...

    async def unload(self) -> None:
        """Release model resources. Called during drain. Must not raise."""
        ...


class WorkerRuntime:
    """Owns every long-lived resource and the lifecycle that moves between them."""

    def __init__(
        self,
        *,
        settings: WorkerSettings,
        model_provider: ModelProvider,
        handler: JobHandler,
    ) -> None:
        self._settings = settings
        self._model = model_provider
        self._handler = handler

        self.health = WorkerHealth(
            service=settings.app.service_name,
            worker_id=settings.app.worker_id,
            model_id=model_provider.model_id,
        )
        self.db = Database(settings)
        self.storage = ObjectStorage(settings)
        self.consumer = QueueConsumer(settings, self.health, handler)
        self._shutdown_complete = asyncio.Event()

    # ------------------------------------------------------------- startup
    async def start(self) -> None:
        """Run the startup sequence up to MODEL_READY, then begin consuming."""
        await self._verify_dependencies()
        await self._load_model()
        await self.consumer.start()
        self.health.mark_idle()

    async def _verify_dependencies(self) -> None:
        """STARTING -> HEALTHY, or -> FAILED_START.

        All three dependencies are checked even if the first fails, so an operator sees
        every problem at once instead of fixing them one restart at a time.
        """
        log.info("worker.verifying_dependencies")

        storage_ok, queue_ok, db_ok = await asyncio.gather(
            self.storage.ping(),
            self.consumer.ping(),
            self._connect_db(),
        )
        self.health.set_dependency("storage", healthy=storage_ok)
        self.health.set_dependency("queue", healthy=queue_ok)
        self.health.set_dependency("database", healthy=db_ok)

        if not (storage_ok and queue_ok and db_ok):
            failed = [
                name
                for name, ok in (
                    ("storage", storage_ok),
                    ("queue", queue_ok),
                    ("database", db_ok),
                )
                if not ok
            ]
            self.health.mark_failed_start("DEPENDENCY_UNREACHABLE")
            raise RuntimeError(f"Dependencies unreachable: {', '.join(failed)}")

        self.health.mark_dependencies_ready()

    async def _connect_db(self) -> bool:
        try:
            await self.db.connect()
            return True
        except Exception as exc:  # noqa: BLE001 - a startup probe reports, it does not raise
            log.warning("db.connect_failed", error_code="DB_UNREACHABLE", error=str(exc))
            return False

    async def _load_model(self) -> None:
        """HEALTHY -> MODEL_READY, or -> FAILED_START.

        A load failure means the worker never reaches MODEL_READY, `/ready` stays false,
        and the orchestrator does not route work to it (§52.2).
        """
        log.info("model.loading", model_id=self._model.model_id)
        try:
            await asyncio.wait_for(
                self._model.load(),
                timeout=self._settings.model.model_load_timeout_seconds,
            )
        except TimeoutError:
            self.health.mark_failed_start("MODEL_LOAD_TIMEOUT")
            raise
        except Exception:
            self.health.mark_failed_start("MODEL_LOAD_FAILED")
            raise
        self.health.mark_model_ready()
        log.info("model.ready", model_id=self._model.model_id)

    # ------------------------------------------------------------ shutdown
    async def shutdown(self) -> None:
        """The graceful shutdown sequence. Safe to call more than once.

        Resource release runs even for a worker that never started successfully. A
        FAILED_START worker still constructed an engine and a storage client, and leaking
        those on the way out would hold a database connection slot open for every crash-
        looping replica.
        """
        if self.health.state in (WorkerState.DRAINING, WorkerState.STOPPED):
            return

        # FAILED_START is terminal: DRAINING is not reachable from it, and there is
        # nothing to drain anyway since the consumer never started. Skip the transition
        # but still release everything below.
        failed_start = self.health.state is WorkerState.FAILED_START
        if not failed_start:
            self.health.mark_draining()
            # 1+2. Stop accepting, finish in-flight work within the grace period.
            await self.consumer.drain(self._settings.app.shutdown_grace_period_seconds)

        # 3. Release model resources.
        with contextlib.suppress(Exception):
            await self._model.unload()

        # 4. Close connections. Storage and DB last, because steps above may still have
        #    needed them to persist a result.
        with contextlib.suppress(Exception):
            await self.storage.close()
        with contextlib.suppress(Exception):
            await self.db.dispose()

        if not failed_start:
            self.health.mark_stopped()
        log.info("worker.stopped", failed_start=failed_start)
        self._shutdown_complete.set()

    def install_signal_handlers(self) -> None:
        """Route SIGTERM/SIGINT into the graceful shutdown sequence.

        `loop.add_signal_handler` is used rather than `signal.signal` so the handler runs
        on the event loop and can schedule async work. A second signal is ignored rather
        than escalating: an impatient operator pressing Ctrl-C twice should not cause the
        abandonment of work that the first signal was in the middle of persisting.
        """
        loop = asyncio.get_running_loop()

        def _handle(sig: signal.Signals) -> None:
            if self.health.is_draining:
                log.info("worker.signal_ignored_already_draining", signal=sig.name)
                return
            log.info("worker.signal_received", signal=sig.name)
            loop.create_task(self.shutdown())  # noqa: RUF006 - fire-and-forget by design

        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, _handle, sig)
            except (NotImplementedError, RuntimeError) as exc:
                # NotImplementedError: the platform has no signal support (Windows).
                # RuntimeError: the loop is not on the main thread, which is the case
                # under TestClient and any embedded/ASGI-in-a-thread host.
                #
                # Neither is fatal, and it must not be. In the container the loop IS on
                # the main thread and handlers install normally; failing startup here
                # would make the whole app untestable in exchange for nothing. But it is
                # logged at warning, because a worker with no SIGTERM handler will be
                # SIGKILLed at the end of the termination grace period without draining,
                # and that silently abandons in-flight work.
                log.warning(
                    "worker.signal_handler_not_installed",
                    signal=sig.name,
                    error_code="SIGNAL_HANDLER_UNAVAILABLE",
                    error=str(exc),
                    note="Graceful shutdown will not be triggered by this signal.",
                )


def create_worker_app(
    *,
    settings: WorkerSettings,
    model_provider: ModelProvider,
    handler: JobHandler,
) -> FastAPI:
    """Build the FastAPI app for a worker.

    FastAPI here is an INTERNAL control/health surface only -- probes and operators. It is
    not a public API and must not be routed through the ingress. The worker's actual work
    arrives over the queue, never over HTTP.

    The lifespan hook is what makes this work as a container entrypoint: uvicorn starts
    serving the health endpoints immediately (so `/health` answers during model load, and
    the orchestrator can tell "still starting" from "dead"), while startup continues in the
    background.
    """
    configure_logging(settings)
    runtime = WorkerRuntime(settings=settings, model_provider=model_provider, handler=handler)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        runtime.install_signal_handlers()
        log.info(
            "worker.starting",
            queue=settings.app.queue_name,
            model_id=settings.model.model_id,
            service_version=settings.app.service_version,
        )
        # Startup runs as a background task so the health endpoints are live during it.
        # Without this, a slow model load would leave probes unanswered and the
        # orchestrator would conclude the process was dead and kill it mid-load.
        start_task = asyncio.create_task(runtime.start())

        def _on_start_done(task: asyncio.Task[None]) -> None:
            if task.cancelled():
                return
            exc = task.exception()
            if exc is not None:
                log.error(
                    "worker.startup_failed",
                    error_code="STARTUP_FAILED",
                    error=str(exc),
                )

        start_task.add_done_callback(_on_start_done)

        try:
            yield
        finally:
            start_task.cancel()
            # Suppress the task's own exception as well as CancelledError. A startup
            # failure has already been logged by the done-callback above and has already
            # driven the worker to FAILED_START; re-raising it here would abort the
            # shutdown sequence and leave connections open, turning a clean "this worker
            # could not start" into a messy "this worker could not stop either".
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await start_task
            await runtime.shutdown()

    app = FastAPI(
        title=f"{settings.app.service_name} (internal control surface)",
        version=settings.app.service_version,
        lifespan=lifespan,
        docs_url=None,  # no interactive docs on an internal surface
        redoc_url=None,
        openapi_url=None,
    )
    app.include_router(create_health_router(runtime.health))
    app.state.runtime = runtime
    return app


__all__ = [
    "CommandEnvelope",
    "ModelProvider",
    "WorkerRuntime",
    "create_worker_app",
]
