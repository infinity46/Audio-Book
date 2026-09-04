"""Cooperative cancellation, worker side (`event-contracts.md` §29).

The API writes `processing_job.cancellation_requested` (durable) and sets a Redis flag
(fast path), then returns `200` immediately without claiming the work stopped. This module
is the half that makes those writes mean something: a worker checks the flag before it
starts, exits cleanly, and marks the job `CANCELLED` so the API's
`cancellation.effective` finally turns true.

**Cancellation is deliberately not a queued command** (E-23). A `job.cancel` message would
queue behind the very work it is trying to stop -- on a saturated GPU queue, possibly for
hours.

Two properties the implementation depends on:

  * **Redis is a cache, never the authority.** A Redis outage must not silently disable
    cancellation, so a failed flag read falls through to the database column. The cost is a
    query per job start on the degraded path; the alternative is a cancelled 20-hour render
    that keeps burning GPU time while the user is told it stopped.
  * **A cancelled job is terminal, not failed.** `FAILED` would put it back in the retry
    path, and a cancelled job that retries itself is worse than one that never stopped.

The key format is shared with the TypeScript side (`packages/queue/src/cancellation.ts`);
the two must agree exactly or the flag one writes is invisible to the other. This is the
class of cross-runtime contract drift QA finding "High-risk 9" identifies as this system's
most likely long-term defect source, so the format lives in one named function on each
side rather than being inlined at call sites.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import redis.asyncio as redis_asyncio
from sqlalchemy import text

from workers_common.events import write_outbox_message
from workers_common.logging import get_logger

if TYPE_CHECKING:  # pragma: no cover - typing only
    from workers_common.db import Database

log = get_logger(__name__)

PRODUCER = "worker-python"
PRODUCER_VERSION = "1.0.0"


def cancellation_flag_key(tenant_id: str, job_id: str) -> str:
    """Must match `cancellationFlagKey` in `packages/queue/src/cancellation.ts`."""
    return f"job:cancel:{tenant_id}:{job_id}"


class CancellationGate:
    """Checks, and acts on, a cancellation request at a job boundary.

    Where the check happens, per §29.3: before a handler starts, and therefore before every
    retry. For `generate_tts_chunk` that is the complete requirement the specification
    states ("before synthesis begins -- a single chunk is short enough that mid-synthesis
    cancellation is not worth the complexity"). For the multi-unit AI handlers
    (`analyze_scene`, `generate_director_ir`) §29.3 also asks for a check between scenes and
    before each LLM call; `is_cancelled` is public so those handlers can call it in their
    own loops, and the job-boundary check below is the floor rather than the ceiling.
    """

    def __init__(self, db: Database, redis_url: str) -> None:
        self._db = db
        self._redis_url = redis_url
        self._redis: Any = None

    async def _client(self) -> Any:
        if self._redis is None:
            self._redis = redis_asyncio.from_url(self._redis_url, decode_responses=True)
        return self._redis

    async def is_cancelled(self, tenant_id: str, job_id: str) -> bool:
        """Redis first; the database column when Redis cannot answer."""
        try:
            client = await self._client()
            return await client.get(cancellation_flag_key(tenant_id, job_id)) is not None
        except Exception:  # noqa: BLE001 - any Redis failure falls back, none is fatal
            log.warning(
                "cancellation.flag_read_failed",
                job_id=job_id,
                detail="falling back to processing_job.cancellation_requested",
            )

        async with self._db.session() as session:
            result = await session.execute(
                text(
                    "SELECT cancellation_requested FROM processing_job "
                    "WHERE id = CAST(:job_id AS uuid)"
                ),
                {"job_id": job_id},
            )
            row = result.first()
            return bool(row[0]) if row else False

    async def halt_if_cancelled(self, job_id: str) -> bool:
        """Returns True when the caller must exit without doing the work.

        Marks the job `CANCELLED` and writes a `job.cancelled` outbox row in one
        transaction -- the same transactional-outbox rule every other state change in this
        system follows (§19.2), so a crash between the two cannot leave a cancelled job
        whose cancellation nobody was told about.
        """
        async with self._db.session() as session:
            result = await session.execute(
                text(
                    "SELECT tenant_id::text, book_id::text, status::text, correlation_id, "
                    "cancellation_requested FROM processing_job WHERE id = CAST(:job_id AS uuid)"
                ),
                {"job_id": job_id},
            )
            row = result.first()

        # No row is not this gate's problem: the handler's own validation reports it, with
        # the context to say what was missing.
        if row is None:
            return False

        tenant_id, book_id, status, correlation_id, durable_flag = row

        # Already terminated by the API (the CREATED/QUEUED/BLOCKED/RETRYING rows of
        # §29.2): nothing further to write, but the work must not run.
        if status == "CANCELLED":
            return True

        cancelled = bool(durable_flag) or await self.is_cancelled(tenant_id, job_id)
        if not cancelled:
            return False

        now = datetime.now(UTC)
        async with self._db.session() as session:
            await session.execute(
                text(
                    "UPDATE processing_job SET status = 'CANCELLED', status_changed_at = :now, "
                    "completed_at = :now, cancellation_requested = TRUE, "
                    "cancellation_effective_at = :now, updated_at = :now "
                    "WHERE id = CAST(:job_id AS uuid)"
                ),
                {"now": now, "job_id": job_id},
            )
            # Same session, therefore the same transaction as the status write
            # (§19.2): a crash between the two cannot leave a cancelled job whose
            # cancellation nobody was told about.
            await write_outbox_message(
                session,
                event_type="job.cancelled",
                schema_version="events.v1",
                producer=PRODUCER,
                producer_version=PRODUCER_VERSION,
                tenant_id=uuid.UUID(tenant_id),
                book_id=uuid.UUID(book_id) if book_id else None,
                job_id=uuid.UUID(job_id),
                correlation_id=uuid.UUID(correlation_id),
                causation_id=uuid.UUID(correlation_id),
                aggregate_type="job",
                aggregate_id=uuid.UUID(job_id),
                payload={
                    "cancellation_effective_at": now.isoformat(),
                    # §29.5: already-completed work is retained. This worker exits
                    # before starting, so nothing of this attempt exists to release.
                    "partial_units_retained": True,
                    "acknowledged_by": PRODUCER,
                },
            )

        log.info(
            "cancellation.observed",
            job_id=job_id,
            book_id=book_id,
            detail="exiting before work started",
        )
        return True

    async def close(self) -> None:
        if self._redis is not None:
            await self._redis.aclose()
            self._redis = None
