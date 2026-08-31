"""Shared test doubles for handler-orchestration tests.

No live Postgres/Redis is available in this environment (see the Phase 3 final
report's "known limitations" -- raw SQL correctness is reviewed but not exercised
against a real database in this session). These tests instead verify handler
ORCHESTRATION -- call sequencing, data flowing between steps, idempotency,
transaction boundaries, next-job payload construction -- by monkeypatching the
`worker_ai.repo` functions the handlers call. The real SQL should be verified against
a live Postgres (`docker compose up -d postgres`, then the seed script, then a real
`POST /analysis`) before this code is trusted in production; see the final report.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest


class FakeDatabase:
    """Enough of `workers_common.db.Database`'s surface for a handler to run: an async
    context manager that yields an opaque session object. Since every `worker_ai.repo`
    call a handler makes is monkeypatched in these tests, the session itself is never
    actually used for real queries -- it only needs to be a stable, inspectable token."""

    def __init__(self) -> None:
        self.session_object = MagicMock(name="fake_session")
        # `write_outbox_message` (workers_common.events) and the finalization event's
        # count queries call `session.execute(...)` directly rather than through a
        # mockable `worker_ai.repo` function -- the SQL itself is exercised for real
        # (against a real Postgres) by workers-common's own tests, so here the result
        # only needs to be a JSON-serializable, arithmetic-safe stand-in (`scalar_one()`
        # -> 0) rather than blow up when handler code calls it.
        execute_result = MagicMock()
        execute_result.scalar_one.return_value = 0
        self.session_object.execute = AsyncMock(return_value=execute_result)
        self.sessions_opened = 0

    @asynccontextmanager
    async def session(self) -> AsyncIterator[Any]:
        self.sessions_opened += 1
        yield self.session_object


class FakeQueueProducer:
    """Records every `enqueue()` call instead of talking to Redis."""

    def __init__(self) -> None:
        self.enqueued: list[dict[str, Any]] = []

    async def enqueue(
        self,
        *,
        job_name: str,
        job_id: str,
        correlation_id: str,
        causation_id: str | None,
        tenant_id: str,
        entity_id: str | None,
        payload: dict[str, Any],
        max_attempts: int = 3,
    ) -> None:
        self.enqueued.append(
            {
                "job_name": job_name,
                "job_id": job_id,
                "correlation_id": correlation_id,
                "causation_id": causation_id,
                "tenant_id": tenant_id,
                "entity_id": entity_id,
                "payload": payload,
                "max_attempts": max_attempts,
            }
        )


@pytest.fixture
def fake_db() -> FakeDatabase:
    return FakeDatabase()


@pytest.fixture
def fake_queue() -> FakeQueueProducer:
    return FakeQueueProducer()
