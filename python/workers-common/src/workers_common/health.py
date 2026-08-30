"""Worker lifecycle state machine and the internal health surface.

`tts-provider-specification.md` §52.1 fixes the states:

    STARTING --> HEALTHY --> MODEL_READY --> PROCESSING <-> IDLE --> DRAINING --> STOPPED
    STARTING -.-> FAILED_START            (model/GPU failure; never reaches HEALTHY)

The distinction that matters operationally, and the reason `/health` and `/ready` are two
different endpoints:

  * **Liveness** (`/health`) asks "is this process alive and are its dependencies
    reachable?" -- true from HEALTHY onward. A worker that fails liveness gets restarted.
  * **Readiness** (`/ready`) asks "can this worker actually do its assigned work?" -- true
    only from MODEL_READY onward. A worker that fails readiness gets no traffic routed to
    it, but is left alone to finish loading.

Conflating them is a classic and expensive mistake: if liveness returned false during model
loading, the orchestrator would kill workers mid-load and they would never start. If
readiness returned true at HEALTHY, work would be routed to a worker with no model.

DRAINING is deliberately still *live* but not *ready*: the process is finishing in-flight
work and must not be killed, but must also receive nothing new.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from datetime import datetime
from enum import StrEnum
from typing import Any, Final

from fastapi import APIRouter, Response, status
from pydantic import BaseModel

from workers_common.events import utc_now
from workers_common.logging import get_logger

log = get_logger(__name__)


class WorkerState(StrEnum):
    STARTING = "STARTING"
    """Process initializing; dependencies (storage, queue, database) NOT yet verified."""

    HEALTHY = "HEALTHY"
    """Dependencies reachable. Models NOT necessarily loaded. Alive but not ready."""

    MODEL_READY = "MODEL_READY"
    """Assigned model set loaded and verified. This is the readiness threshold."""

    PROCESSING = "PROCESSING"
    """Actively consuming and working."""

    IDLE = "IDLE"
    """Consuming, no work currently assigned."""

    DRAINING = "DRAINING"
    """Stopping acceptance, finishing in-flight work."""

    STOPPED = "STOPPED"
    """Terminated."""

    FAILED_START = "FAILED_START"
    """Model/GPU failure during startup. Terminal; never reaches HEALTHY."""


# The transition table IS the contract. Anything not listed is rejected.
_ALLOWED: Final[dict[WorkerState, frozenset[WorkerState]]] = {
    WorkerState.STARTING: frozenset({WorkerState.HEALTHY, WorkerState.FAILED_START}),
    # HEALTHY may go straight to DRAINING: a SIGTERM arriving while the model is still
    # loading must still shut down cleanly rather than being refused.
    WorkerState.HEALTHY: frozenset(
        {WorkerState.MODEL_READY, WorkerState.DRAINING, WorkerState.FAILED_START}
    ),
    WorkerState.MODEL_READY: frozenset(
        {WorkerState.PROCESSING, WorkerState.IDLE, WorkerState.DRAINING}
    ),
    WorkerState.PROCESSING: frozenset({WorkerState.IDLE, WorkerState.DRAINING}),
    WorkerState.IDLE: frozenset({WorkerState.PROCESSING, WorkerState.DRAINING}),
    WorkerState.DRAINING: frozenset({WorkerState.STOPPED}),
    WorkerState.STOPPED: frozenset(),
    WorkerState.FAILED_START: frozenset(),
}

# Liveness: the process is alive and worth keeping. DRAINING is intentionally included --
# killing a draining worker would abandon in-flight work.
_LIVE_STATES: Final[frozenset[WorkerState]] = frozenset(
    {
        WorkerState.HEALTHY,
        WorkerState.MODEL_READY,
        WorkerState.PROCESSING,
        WorkerState.IDLE,
        WorkerState.DRAINING,
    }
)

# Readiness: this worker can accept new work. Strictly MODEL_READY onward, and never
# while draining.
_READY_STATES: Final[frozenset[WorkerState]] = frozenset(
    {WorkerState.MODEL_READY, WorkerState.PROCESSING, WorkerState.IDLE}
)


class InvalidTransitionError(RuntimeError):
    """Raised on an attempt to make a transition the state machine does not permit."""

    def __init__(self, current: WorkerState, target: WorkerState) -> None:
        allowed = sorted(s.value for s in _ALLOWED[current])
        super().__init__(
            f"Illegal worker state transition {current.value} -> {target.value}. "
            f"Allowed from {current.value}: {allowed or ['<terminal>']}"
        )
        self.current = current
        self.target = target


class DependencyStatus(BaseModel):
    name: str
    healthy: bool
    detail: str | None = None
    checked_at: datetime


class HealthReport(BaseModel):
    state: WorkerState
    live: bool
    ready: bool
    service: str
    worker_id: str
    model_id: str | None = None
    started_at: datetime
    state_since: datetime
    in_flight_jobs: int
    dependencies: list[DependencyStatus] = []
    last_error_code: str | None = None


class WorkerHealth:
    """The lifecycle state machine, shared by every Python worker.

    Thread-safe via a plain lock. The lock is held only for the duration of a state
    swap - never across an await - so it cannot deadlock the event loop, and it means a
    signal handler running off the loop can transition safely.
    """

    def __init__(
        self,
        *,
        service: str,
        worker_id: str,
        model_id: str | None = None,
    ) -> None:
        self._service = service
        self._worker_id = worker_id
        self._model_id = model_id
        self._state = WorkerState.STARTING
        self._lock = threading.Lock()
        self._started_at = utc_now()
        self._state_since = self._started_at
        self._in_flight = 0
        self._dependencies: dict[str, DependencyStatus] = {}
        self._last_error_code: str | None = None
        self._listeners: list[Callable[[WorkerState, WorkerState], None]] = []
        self._drain_event = asyncio.Event()

    # ----------------------------------------------------------------- state
    @property
    def state(self) -> WorkerState:
        return self._state

    @property
    def is_live(self) -> bool:
        return self._state in _LIVE_STATES

    @property
    def is_ready(self) -> bool:
        return self._state in _READY_STATES

    @property
    def is_draining(self) -> bool:
        """True once shutdown has begun. The consumer loop polls this to stop accepting."""
        return self._state in (WorkerState.DRAINING, WorkerState.STOPPED)

    @property
    def in_flight(self) -> int:
        return self._in_flight

    def on_transition(self, listener: Callable[[WorkerState, WorkerState], None]) -> None:
        self._listeners.append(listener)

    def transition_to(self, target: WorkerState, *, error_code: str | None = None) -> None:
        """Move to `target`, or raise `InvalidTransitionError`.

        Re-entering the current state is a no-op rather than an error, so that callers may
        idempotently assert a state (`mark_idle()` when already idle) without guarding.
        """
        with self._lock:
            current = self._state
            if current is target:
                return
            if target not in _ALLOWED[current]:
                raise InvalidTransitionError(current, target)
            self._state = target
            self._state_since = utc_now()
            if error_code is not None:
                self._last_error_code = error_code

        log.info(
            "worker.state_changed",
            from_state=current.value,
            to_state=target.value,
            live=self.is_live,
            ready=self.is_ready,
            **({"error_code": error_code} if error_code else {}),
        )

        if target is WorkerState.DRAINING:
            self._drain_event.set()

        for listener in self._listeners:
            listener(current, target)

    # ------------------------------------------------------- named transitions
    def mark_dependencies_ready(self) -> None:
        """STARTING -> HEALTHY. Call once storage, queue and database are all verified."""
        self.transition_to(WorkerState.HEALTHY)

    def mark_model_ready(self) -> None:
        """HEALTHY -> MODEL_READY. Call once the assigned model set is loaded and verified."""
        self.transition_to(WorkerState.MODEL_READY)

    def mark_failed_start(self, error_code: str) -> None:
        """-> FAILED_START. Terminal. The orchestrator will not route work here."""
        self.transition_to(WorkerState.FAILED_START, error_code=error_code)

    def mark_processing(self) -> None:
        self.transition_to(WorkerState.PROCESSING)

    def mark_idle(self) -> None:
        self.transition_to(WorkerState.IDLE)

    def mark_draining(self) -> None:
        self.transition_to(WorkerState.DRAINING)

    def mark_stopped(self) -> None:
        self.transition_to(WorkerState.STOPPED)

    # ------------------------------------------------------------- in-flight
    def job_started(self) -> None:
        with self._lock:
            self._in_flight += 1
        if self._state in (WorkerState.MODEL_READY, WorkerState.IDLE):
            self.transition_to(WorkerState.PROCESSING)

    def job_finished(self) -> None:
        with self._lock:
            self._in_flight = max(0, self._in_flight - 1)
            remaining = self._in_flight
        # Falling back to IDLE while draining would be wrong -- DRAINING is terminal-ish and
        # the drain sequence owns the transition to STOPPED from here.
        if remaining == 0 and self._state is WorkerState.PROCESSING:
            self.transition_to(WorkerState.IDLE)

    async def wait_for_drain(self) -> None:
        """Block until `mark_draining()` is called. Used by the consumer loop."""
        await self._drain_event.wait()

    async def wait_for_in_flight(self, timeout_seconds: float) -> bool:
        """Wait for in-flight work to finish. Returns False if the grace period expired.

        Polling rather than an event because the in-flight count is decremented from
        arbitrary tasks, and a 50ms poll is entirely adequate for a shutdown path.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        while self._in_flight > 0:
            if loop.time() >= deadline:
                return False
            await asyncio.sleep(0.05)
        return True

    # ---------------------------------------------------------- dependencies
    def set_dependency(self, name: str, *, healthy: bool, detail: str | None = None) -> None:
        self._dependencies[name] = DependencyStatus(
            name=name, healthy=healthy, detail=detail, checked_at=utc_now()
        )

    def dependencies_healthy(self) -> bool:
        return bool(self._dependencies) and all(d.healthy for d in self._dependencies.values())

    # --------------------------------------------------------------- report
    def report(self) -> HealthReport:
        return HealthReport(
            state=self._state,
            live=self.is_live,
            ready=self.is_ready,
            service=self._service,
            worker_id=self._worker_id,
            model_id=self._model_id,
            started_at=self._started_at,
            state_since=self._state_since,
            in_flight_jobs=self._in_flight,
            dependencies=list(self._dependencies.values()),
            last_error_code=self._last_error_code,
        )


def create_health_router(health: WorkerHealth) -> APIRouter:
    """A router any worker app can mount.

    This is an INTERNAL control surface -- probes and operators only. It is not a public API
    and must not be exposed through the ingress.

    Both endpoints return the full report as the body either way, so that a failing probe
    is diagnosable from the probe's own logs without a second call.
    """
    router = APIRouter(tags=["health"])

    @router.get("/health", summary="Liveness: is the process alive?")
    async def get_health(response: Response) -> dict[str, Any]:
        report = health.report()
        if not report.live:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return report.model_dump(mode="json")

    @router.get("/ready", summary="Readiness: can this worker accept work?")
    async def get_ready(response: Response) -> dict[str, Any]:
        report = health.report()
        # False until MODEL_READY, and false again from DRAINING onward.
        if not report.ready:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return report.model_dump(mode="json")

    return router
