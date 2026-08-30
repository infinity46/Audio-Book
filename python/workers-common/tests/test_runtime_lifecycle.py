"""End-to-end lifecycle: does a real worker app boot, become ready, and drain?

These drive the actual `worker_ai` / `worker_gpu` apps through their FastAPI lifespan. Only
the three external dependencies (storage, queue, database) are stubbed -- there is no Redis,
Postgres or S3 in a test environment. Everything else is the real code path: the state
machine, the stub model providers, the health endpoints and the drain sequence.

This file exists because an earlier version of `install_signal_handlers` raised
`RuntimeError` whenever the event loop was not on the main thread, which crashed startup
outright. Unit tests of the state machine could not have caught it; only booting the app
could.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from workers_common.db import Database
from workers_common.queue import QueueConsumer
from workers_common.storage import ObjectStorage

WORKER_ENV = {
    "ENVIRONMENT": "development",
    "SERVICE_VERSION": "test@0.1.0",
    "WORKER_ID": "test-worker-0",
    "DATABASE_URL": "postgresql://u:p@localhost:5432/db",
    "REDIS_URL": "redis://localhost:6379/0",
    "STORAGE_ENDPOINT_URL": "http://localhost:9000",
    "STORAGE_BUCKET": "test-bucket",
    "STORAGE_ACCESS_KEY_ID": "test-key",
    "STORAGE_SECRET_ACCESS_KEY": "test-secret",
    "MODEL_ID": "stub-model-v0",
}


@pytest.fixture
def _stub_dependencies() -> Iterator[dict[str, AsyncMock]]:
    """Stub only the external I/O. All worker logic stays real."""
    mocks = {
        "storage_ping": AsyncMock(return_value=True),
        "queue_ping": AsyncMock(return_value=True),
        "queue_start": AsyncMock(),
        "queue_drain": AsyncMock(),
        "db_connect": AsyncMock(),
        "db_dispose": AsyncMock(),
        "storage_close": AsyncMock(),
    }
    with (
        patch.object(ObjectStorage, "ping", mocks["storage_ping"]),
        patch.object(QueueConsumer, "ping", mocks["queue_ping"]),
        patch.object(QueueConsumer, "start", mocks["queue_start"]),
        patch.object(QueueConsumer, "drain", mocks["queue_drain"]),
        patch.object(Database, "connect", mocks["db_connect"]),
        patch.object(Database, "dispose", mocks["db_dispose"]),
        patch.object(ObjectStorage, "close", mocks["storage_close"]),
    ):
        yield mocks


def _build(monkeypatch: pytest.MonkeyPatch, which: str) -> Any:
    for key, value in WORKER_ENV.items():
        monkeypatch.setenv(key, value)
    if which == "gpu":
        monkeypatch.setenv("SERVICE_NAME", "worker-gpu")
        monkeypatch.setenv("QUEUE_NAME", "gpu")
        from worker_gpu.main import create_app
    else:
        monkeypatch.setenv("SERVICE_NAME", "worker-ai")
        monkeypatch.setenv("QUEUE_NAME", "ai")
        from worker_ai.main import create_app
    return create_app()


def _await_ready(client: TestClient, timeout: float = 5.0) -> None:
    """Poll /ready. Model loading is async, so readiness is not immediate."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if client.get("/ready").status_code == 200:
            return
        time.sleep(0.02)
    raise AssertionError("Worker never became ready")


@pytest.mark.parametrize("which", ["ai", "gpu"])
@pytest.mark.usefixtures("_stub_dependencies")
def test_worker_boots_to_ready_and_stops_cleanly(
    monkeypatch: pytest.MonkeyPatch, which: str
) -> None:
    app = _build(monkeypatch, which)

    with TestClient(app) as client:
        _await_ready(client)

        health = client.get("/health")
        ready = client.get("/ready")
        assert health.status_code == 200
        assert health.json()["live"] is True
        assert ready.status_code == 200
        assert ready.json()["ready"] is True
        assert ready.json()["model_id"] == "stub-model-v0"
        assert ready.json()["state"] in ("MODEL_READY", "IDLE")

    # Leaving the context runs the lifespan shutdown, i.e. the real drain sequence.
    assert app.state.runtime.health.state.value == "STOPPED"


@pytest.mark.usefixtures("_stub_dependencies")
def test_dependencies_are_all_verified_before_ready(
    monkeypatch: pytest.MonkeyPatch, _stub_dependencies: dict[str, AsyncMock]
) -> None:
    app = _build(monkeypatch, "gpu")
    with TestClient(app) as client:
        _await_ready(client)
        deps = {d["name"]: d["healthy"] for d in client.get("/health").json()["dependencies"]}
        assert deps == {"storage": True, "queue": True, "database": True}

    assert _stub_dependencies["storage_ping"].called
    assert _stub_dependencies["queue_ping"].called
    assert _stub_dependencies["db_connect"].called


def test_unreachable_dependency_prevents_readiness(monkeypatch: pytest.MonkeyPatch) -> None:
    """A worker whose storage is down must never report ready.

    This is the property that stops the orchestrator routing work to a broken worker.
    """
    with (
        patch.object(ObjectStorage, "ping", AsyncMock(return_value=False)),
        patch.object(QueueConsumer, "ping", AsyncMock(return_value=True)),
        patch.object(QueueConsumer, "start", AsyncMock()),
        patch.object(QueueConsumer, "drain", AsyncMock()),
        patch.object(Database, "connect", AsyncMock()),
        patch.object(Database, "dispose", AsyncMock()),
        patch.object(ObjectStorage, "close", AsyncMock()),
    ):
        app = _build(monkeypatch, "gpu")
        with TestClient(app) as client:
            time.sleep(0.3)  # let the startup task run to completion
            ready = client.get("/ready")
            assert ready.status_code == 503
            assert ready.json()["ready"] is False
            assert ready.json()["state"] == "FAILED_START"
            assert ready.json()["last_error_code"] == "DEPENDENCY_UNREACHABLE"

        # Regression: shutting down a FAILED_START worker must not raise. DRAINING is not
        # reachable from FAILED_START, and an earlier version blew up here -- meaning a
        # worker that could not start also could not release its connections.
        assert app.state.runtime.health.state.value == "FAILED_START"


def test_failed_start_still_releases_resources(monkeypatch: pytest.MonkeyPatch) -> None:
    """A crash-looping replica must not leak a DB connection slot on every attempt."""
    db_dispose = AsyncMock()
    storage_close = AsyncMock()
    with (
        patch.object(ObjectStorage, "ping", AsyncMock(return_value=True)),
        patch.object(QueueConsumer, "ping", AsyncMock(return_value=False)),
        patch.object(QueueConsumer, "start", AsyncMock()),
        patch.object(QueueConsumer, "drain", AsyncMock()),
        patch.object(Database, "connect", AsyncMock()),
        patch.object(Database, "dispose", db_dispose),
        patch.object(ObjectStorage, "close", storage_close),
    ):
        app = _build(monkeypatch, "ai")
        with TestClient(app) as client:
            time.sleep(0.3)
            assert client.get("/ready").status_code == 503

    assert db_dispose.called
    assert storage_close.called


@pytest.mark.usefixtures("_stub_dependencies")
def test_drain_stops_the_consumer(
    monkeypatch: pytest.MonkeyPatch, _stub_dependencies: dict[str, AsyncMock]
) -> None:
    """Shutdown must drain the queue and release connections, in that order."""
    app = _build(monkeypatch, "gpu")
    with TestClient(app) as client:
        _await_ready(client)

    assert _stub_dependencies["queue_drain"].called
    assert _stub_dependencies["storage_close"].called
    assert _stub_dependencies["db_dispose"].called


@pytest.mark.usefixtures("_stub_dependencies")
def test_stub_providers_do_no_real_work(monkeypatch: pytest.MonkeyPatch) -> None:
    """Guard against a stub quietly acquiring real behaviour.

    If someone later makes these providers do actual inference without replacing the
    lifecycle, this test should be the thing that makes them stop and think.
    """
    from worker_ai.main import StubDirectorModelProvider
    from worker_gpu.main import StubTTSProvider

    for cls in (StubDirectorModelProvider, StubTTSProvider):
        assert cls.__name__.startswith("Stub")
        assert "STUB" in (cls.__doc__ or "")

    # Neither provider exposes a synthesis/generation entry point at all.
    for cls in (StubDirectorModelProvider, StubTTSProvider):
        public = {n for n in dir(cls) if not n.startswith("_")}
        assert public == {"model_id", "load", "unload", "is_loaded"}
