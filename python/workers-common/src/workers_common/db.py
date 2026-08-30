"""Async SQLAlchemy engine and session management.

Phase 1 provides connection plumbing and a health check only. There are no ORM models,
no queries and no migrations here -- the schema is owned by `database-schema.md` and the
migrations are a Node-side concern.

## Narrow write surface per worker role

Each worker connects as its **own** database role, not as a shared application superuser.
The intent, which a human must implement as GRANTs at migration time:

    worker-gpu  -- writes:  audio_chunk, processing_attempt, job heartbeat/lease rows
                -- reads:   ONLY what it writes, plus the rows its lease covers
                -- has NO SELECT on `book`, `character`, `paragraph`, `voice_assignment`

    worker-ai   -- writes:  audio_script, story_bible_delta, processing_attempt
                -- reads:   the narrative rows its job scope needs

The GPU worker restriction is the important one and it is not arbitrary. That worker runs
third-party model code on hardware handling every tenant's content; a credential compromise
there must not become a whole-library manuscript exfiltration. The GPU worker receives the
text it must synthesize *in its job envelope's storage pointer*, never by querying the book
tables, which is what makes the missing SELECT grant workable rather than merely aspirational.

**This module cannot enforce any of that.** Least privilege is enforced by the grants
attached to the role in `DATABASE_URL`, at migration time. What this file does is document
the intent so that nobody later "fixes" a permission error by widening the grant. A
permission error here is the design working.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from workers_common.config import WorkerSettings
from workers_common.logging import get_logger

log = get_logger(__name__)


class Database:
    """Owns the engine and session factory for the process lifetime.

    One instance per worker. Created during startup, disposed during drain.
    """

    def __init__(self, settings: WorkerSettings) -> None:
        self._settings = settings
        self._engine: AsyncEngine | None = None
        self._session_factory: async_sessionmaker[AsyncSession] | None = None

    @property
    def engine(self) -> AsyncEngine:
        if self._engine is None:
            raise RuntimeError("Database.connect() has not been called.")
        return self._engine

    async def connect(self) -> None:
        """Create the engine and verify the connection.

        The verification round-trip is the point: `create_async_engine` is lazy, so without
        it a worker would report HEALTHY with an unreachable database and only discover the
        problem on its first job.
        """
        dsn = str(self._settings.secrets.database_url)
        # pydantic's PostgresDsn normalises to `postgresql://`; asyncpg needs the driver
        # named explicitly or SQLAlchemy picks the sync psycopg2 dialect and fails.
        if dsn.startswith("postgresql://"):
            dsn = dsn.replace("postgresql://", "postgresql+asyncpg://", 1)

        self._engine = create_async_engine(
            dsn,
            # A worker's pool should be small: concurrency is bounded by the job
            # concurrency, and a large pool per replica multiplies into connection
            # exhaustion once the deployment scales horizontally.
            pool_size=max(2, self._settings.app.concurrency),
            max_overflow=2,
            pool_pre_ping=True,  # survive a Postgres failover without a poisoned pool
            pool_recycle=1800,
            echo=False,  # never True: echoed SQL could carry book text into the logs
        )
        self._session_factory = async_sessionmaker(
            self._engine, expire_on_commit=False, class_=AsyncSession
        )
        await self.ping()
        log.info("db.connected", pool_size=max(2, self._settings.app.concurrency))

    async def ping(self) -> bool:
        """Round-trip `SELECT 1`. Used by the startup check and the dependency probe."""
        try:
            async with self.engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            return True
        except Exception as exc:  # noqa: BLE001 - a probe reports, it does not raise
            log.warning("db.ping_failed", error_code="DB_UNREACHABLE", error=str(exc))
            return False

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        """A transactional session. Commits on success, rolls back on any exception."""
        if self._session_factory is None:
            raise RuntimeError("Database.connect() has not been called.")
        session = self._session_factory()
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()

    async def dispose(self) -> None:
        """Close every pooled connection. Part of the graceful-shutdown sequence."""
        if self._engine is not None:
            await self._engine.dispose()
            self._engine = None
            self._session_factory = None
            log.info("db.disposed")

    def describe(self) -> dict[str, Any]:
        """Connection facts safe to log. Never includes the DSN, which carries a password."""
        return {"connected": self._engine is not None}
