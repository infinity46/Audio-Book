"""Shared test doubles for handler-orchestration tests -- mirrors
`worker_ai/tests/conftest.py` exactly (no live Postgres/Redis/object storage is available
in this environment; these doubles let a handler's ORCHESTRATION be verified by
monkeypatching the `worker_gpu.repo` functions it calls)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest


class FakeDatabase:
    def __init__(self) -> None:
        self.session_object = MagicMock(name="fake_session")
        execute_result = MagicMock()
        execute_result.scalar_one.return_value = 0
        self.session_object.execute = AsyncMock(return_value=execute_result)
        self.sessions_opened = 0

    @asynccontextmanager
    async def session(self) -> AsyncIterator[Any]:
        self.sessions_opened += 1
        yield self.session_object


@dataclass(frozen=True, slots=True)
class FakeChecksum:
    sha256: str
    size_bytes: int
    content_type: str


class FakeStorage:
    """Records every `put()` call instead of talking to S3/MinIO."""

    def __init__(self) -> None:
        self.bucket = "audiobook-test"
        self.puts: list[tuple[str, bytes, str]] = []

    async def put(self, key: str, data: bytes, *, content_type: str = "application/octet-stream") -> FakeChecksum:
        import hashlib

        self.puts.append((key, data, content_type))
        return FakeChecksum(sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data), content_type=content_type)


@pytest.fixture
def fake_db() -> FakeDatabase:
    return FakeDatabase()


@pytest.fixture
def fake_storage() -> FakeStorage:
    return FakeStorage()
