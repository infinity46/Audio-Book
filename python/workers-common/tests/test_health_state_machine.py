"""The lifecycle state machine, including the liveness/readiness distinction."""

from __future__ import annotations

import asyncio

import pytest

from workers_common.health import (
    InvalidTransitionError,
    WorkerHealth,
    WorkerState,
    create_health_router,
)


@pytest.fixture
def health() -> WorkerHealth:
    return WorkerHealth(service="worker-test", worker_id="worker-test-0", model_id="stub-1")


def test_starts_in_starting_and_is_neither_live_nor_ready(health: WorkerHealth) -> None:
    assert health.state is WorkerState.STARTING
    assert not health.is_live
    assert not health.is_ready


def test_happy_path_transitions(health: WorkerHealth) -> None:
    # Each transition is captured into a fresh local before asserting on it —
    # asserting repeatedly on the same `health.state` member expression across
    # mutating calls trips a mypy narrowing quirk (member-expression narrowing
    # not always invalidated by an intervening method call) that has nothing
    # to do with runtime correctness.
    health.mark_dependencies_ready()
    state = health.state
    assert state is WorkerState.HEALTHY

    health.mark_model_ready()
    state = health.state
    assert state is WorkerState.MODEL_READY

    health.mark_processing()
    state = health.state
    assert state is WorkerState.PROCESSING

    health.mark_idle()
    state = health.state
    assert state is WorkerState.IDLE

    health.mark_processing()  # IDLE <-> PROCESSING both ways
    health.mark_idle()

    health.mark_draining()
    state = health.state
    assert state is WorkerState.DRAINING

    health.mark_stopped()
    state = health.state
    assert state is WorkerState.STOPPED


def test_healthy_is_live_but_not_ready(health: WorkerHealth) -> None:
    """The distinction the whole two-endpoint design exists for.

    A worker whose dependencies are reachable but whose model has not loaded is alive --
    do not restart it -- but cannot do work -- do not route to it.
    """
    health.mark_dependencies_ready()
    assert health.is_live
    assert not health.is_ready


def test_ready_only_from_model_ready_onward(health: WorkerHealth) -> None:
    health.mark_dependencies_ready()
    health.mark_model_ready()
    assert health.is_ready

    health.mark_processing()
    assert health.is_ready

    health.mark_idle()
    assert health.is_ready


def test_draining_is_live_but_not_ready(health: WorkerHealth) -> None:
    """Draining must not be killed (live) and must not be sent work (not ready)."""
    health.mark_dependencies_ready()
    health.mark_model_ready()
    health.mark_draining()
    assert health.is_live
    assert not health.is_ready


def test_stopped_is_neither(health: WorkerHealth) -> None:
    health.mark_dependencies_ready()
    health.mark_model_ready()
    health.mark_draining()
    health.mark_stopped()
    assert not health.is_live
    assert not health.is_ready


def test_failed_start_is_terminal_and_never_live(health: WorkerHealth) -> None:
    health.mark_failed_start("MODEL_LOAD_FAILED")
    assert health.state is WorkerState.FAILED_START
    assert not health.is_live
    assert not health.is_ready
    assert health.report().last_error_code == "MODEL_LOAD_FAILED"

    # Terminal: no transition out of it, including back to the happy path.
    with pytest.raises(InvalidTransitionError):
        health.mark_dependencies_ready()


def test_cannot_skip_model_ready(health: WorkerHealth) -> None:
    """STARTING must not jump straight to PROCESSING."""
    with pytest.raises(InvalidTransitionError):
        health.mark_processing()


def test_cannot_reach_model_ready_without_healthy(health: WorkerHealth) -> None:
    with pytest.raises(InvalidTransitionError):
        health.mark_model_ready()


def test_cannot_resurrect_a_stopped_worker(health: WorkerHealth) -> None:
    health.mark_dependencies_ready()
    health.mark_model_ready()
    health.mark_draining()
    health.mark_stopped()
    with pytest.raises(InvalidTransitionError):
        health.mark_processing()


def test_healthy_may_drain_directly() -> None:
    """SIGTERM during model load must still shut down cleanly."""
    health = WorkerHealth(service="s", worker_id="w")
    health.mark_dependencies_ready()
    health.mark_draining()
    assert health.state is WorkerState.DRAINING


def test_reentering_current_state_is_a_noop(health: WorkerHealth) -> None:
    health.mark_dependencies_ready()
    health.mark_dependencies_ready()
    assert health.state is WorkerState.HEALTHY


def test_invalid_transition_message_lists_what_is_allowed(health: WorkerHealth) -> None:
    with pytest.raises(InvalidTransitionError) as exc_info:
        health.mark_stopped()
    message = str(exc_info.value)
    assert "STARTING -> STOPPED" in message
    assert "HEALTHY" in message  # tells the operator what WAS allowed


def test_in_flight_tracking_drives_processing_and_idle(health: WorkerHealth) -> None:
    health.mark_dependencies_ready()
    health.mark_model_ready()

    health.job_started()
    state = health.state
    assert state is WorkerState.PROCESSING
    assert health.in_flight == 1

    health.job_started()
    assert health.in_flight == 2

    health.job_finished()
    # Still processing: one job remains.
    state = health.state
    assert state is WorkerState.PROCESSING

    health.job_finished()
    assert health.in_flight == 0
    state = health.state
    assert state is WorkerState.IDLE


def test_job_finished_while_draining_does_not_flip_back_to_idle(health: WorkerHealth) -> None:
    """Draining is one-way; a finishing job must not undo it."""
    health.mark_dependencies_ready()
    health.mark_model_ready()
    health.job_started()
    health.mark_draining()
    health.job_finished()
    assert health.state is WorkerState.DRAINING


def test_is_draining_flag(health: WorkerHealth) -> None:
    health.mark_dependencies_ready()
    health.mark_model_ready()
    assert not health.is_draining
    health.mark_draining()
    assert health.is_draining


def test_transition_listeners_fire(health: WorkerHealth) -> None:
    seen: list[tuple[WorkerState, WorkerState]] = []
    health.on_transition(lambda old, new: seen.append((old, new)))
    health.mark_dependencies_ready()
    health.mark_model_ready()
    assert seen == [
        (WorkerState.STARTING, WorkerState.HEALTHY),
        (WorkerState.HEALTHY, WorkerState.MODEL_READY),
    ]


def test_dependency_tracking(health: WorkerHealth) -> None:
    assert not health.dependencies_healthy()  # empty is not healthy
    health.set_dependency("storage", healthy=True)
    health.set_dependency("queue", healthy=True)
    health.set_dependency("database", healthy=False, detail="connection refused")
    assert not health.dependencies_healthy()

    health.set_dependency("database", healthy=True)
    assert health.dependencies_healthy()

    report = health.report()
    assert {d.name for d in report.dependencies} == {"storage", "queue", "database"}


async def test_wait_for_drain_unblocks(health: WorkerHealth) -> None:
    health.mark_dependencies_ready()
    health.mark_model_ready()

    waiter = asyncio.create_task(health.wait_for_drain())
    await asyncio.sleep(0)
    assert not waiter.done()

    health.mark_draining()
    await asyncio.wait_for(waiter, timeout=1.0)


async def test_wait_for_in_flight_returns_false_on_timeout(health: WorkerHealth) -> None:
    health.mark_dependencies_ready()
    health.mark_model_ready()
    health.job_started()
    assert await health.wait_for_in_flight(timeout_seconds=0.15) is False


async def test_wait_for_in_flight_returns_true_when_work_finishes(
    health: WorkerHealth,
) -> None:
    health.mark_dependencies_ready()
    health.mark_model_ready()
    health.job_started()

    async def finish_soon() -> None:
        await asyncio.sleep(0.05)
        health.job_finished()

    asyncio.create_task(finish_soon())  # noqa: RUF006
    assert await health.wait_for_in_flight(timeout_seconds=2.0) is True


# --------------------------------------------------------------------------- #
# HTTP surface
# --------------------------------------------------------------------------- #
def _client(health: WorkerHealth):  # type: ignore[no-untyped-def]
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(create_health_router(health))
    return TestClient(app)


def test_health_endpoint_503_while_starting(health: WorkerHealth) -> None:
    response = _client(health).get("/health")
    assert response.status_code == 503
    assert response.json()["state"] == "STARTING"


def test_health_endpoint_200_once_dependencies_verified(health: WorkerHealth) -> None:
    health.mark_dependencies_ready()
    response = _client(health).get("/health")
    assert response.status_code == 200
    assert response.json()["live"] is True


def test_ready_endpoint_is_503_until_model_ready(health: WorkerHealth) -> None:
    client = _client(health)

    health.mark_dependencies_ready()
    # Liveness passes...
    assert client.get("/health").status_code == 200
    # ...readiness does not.
    ready = client.get("/ready")
    assert ready.status_code == 503
    assert ready.json()["ready"] is False

    health.mark_model_ready()
    ready = client.get("/ready")
    assert ready.status_code == 200
    assert ready.json()["ready"] is True


def test_ready_endpoint_goes_503_again_on_drain(health: WorkerHealth) -> None:
    client = _client(health)
    health.mark_dependencies_ready()
    health.mark_model_ready()
    assert client.get("/ready").status_code == 200

    health.mark_draining()
    assert client.get("/ready").status_code == 503
    # ...but liveness stays 200, so the orchestrator does not kill it mid-drain.
    assert client.get("/health").status_code == 200


def test_report_body_carries_diagnostics(health: WorkerHealth) -> None:
    health.mark_dependencies_ready()
    body = _client(health).get("/health").json()
    assert body["service"] == "worker-test"
    assert body["worker_id"] == "worker-test-0"
    assert body["model_id"] == "stub-1"
    assert body["in_flight_jobs"] == 0
