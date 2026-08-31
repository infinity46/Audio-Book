"""BullMQ-compatible job consumption.

The Node services are the producers; these Python workers are consumers on the same Redis.
The queue *contract* -- key naming, payload schema, ack semantics -- is language-neutral and
owned by `event-contracts.md`.

## The compatibility approach

This wraps **the official `bullmq` PyPI package**, published by Taskforcesh, the authors of
the Node BullMQ library. It is a genuine port, not a third-party reimplementation: it ships
and executes BullMQ's own bundled Lua scripts against BullMQ's own Redis key layout. Every
state transition a job makes (`wait` -> `active` -> `completed` / `failed`, delayed-set
retry scheduling, stalled-job recovery, DLQ) is therefore performed by the same atomic
scripts the Node side uses.

**Nothing wire-level is invented here.** No hand-rolled `BRPOPLPUSH` loop, no
reimplemented key naming. That was the alternative if no maintained client existed, and it
was not needed. What this module adds is only: envelope decode, correlation binding,
error classification, and drain sequencing.

The compatibility assumptions and known gaps are enumerated in this package's README under
"Queue compatibility with the Node BullMQ producer". The two a reviewer should check first:

  1. The Python `bullmq` major version must track the Node `bullmq` major version. Pin both.
  2. `queue_prefix` must match the producer's BullMQ prefix (default `bull`).

## Ack semantics

BullMQ's model is "ack by returning". A processor that returns normally completes the job;
a processor that raises fails it, and BullMQ applies the producer-configured retry/backoff.
So `ack` and `nack` are not explicit calls here -- they are the return and the raise. The
one distinction this module must make is *retryable* versus *terminal*:

  * raise `TransientJobError`  -> job fails, BullMQ retries with backoff until attempts run out
  * raise `TerminalJobError`   -> wrapped in BullMQ's `UnrecoverableError`, no further retries

That distinction matters because retrying a genuinely malformed message just burns the
attempt budget and delays the DLQ signal an operator needs.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from bullmq import Job, UnrecoverableError, Worker
from pydantic import ValidationError

from workers_common.config import WorkerSettings
from workers_common.correlation import bind_job_context
from workers_common.events import SimpleJobEnvelope
from workers_common.health import WorkerHealth
from workers_common.logging import get_logger

if TYPE_CHECKING:  # pragma: no cover - import cycle guard, typing only
    from workers_common.db import Database
    from workers_common.storage import ObjectStorage

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class JobContext:
    """Everything a real handler needs, bundled into the single argument it receives.

    Phase 1's `JobHandler` took only the envelope -- there was no real work to do, so
    nothing needed the database or object storage. Phase 3 is the first handler that
    actually persists anything, so this widens the seam: `db`/`storage`/`settings` are
    the same long-lived, per-process instances `WorkerRuntime` already owns (see
    `runtime.py`), handed to every job rather than each handler reaching into globals.
    `message_type` is BullMQ's own `job.name` (the `jobName` the TypeScript producer set
    at enqueue time) -- see `SimpleJobEnvelope`'s docstring for why the job's type is not
    an envelope field in the real producer contract. `attempt`/`max_attempts` come from
    BullMQ's own `job.attemptsMade`/`job.opts['attempts']` -- a handler that marks its
    `processing_job` row terminally FAILED needs to know whether THIS is the last
    attempt, or whether BullMQ is about to retry (mirrors
    `apps/worker-cpu/src/processors/ingestion.ts`'s `attemptsMade`/`maxAttempts` deps).
    """

    envelope: SimpleJobEnvelope
    message_type: str
    db: Database
    storage: ObjectStorage
    settings: WorkerSettings
    attempt: int
    max_attempts: int

    @property
    def is_final_attempt(self) -> bool:
        return self.attempt >= self.max_attempts


JobHandler = Callable[[JobContext], Awaitable[None]]


class TransientJobError(RuntimeError):
    """A failure worth retrying: a timeout, a dropped connection, a busy dependency."""

    def __init__(self, message: str, *, error_code: str = "JOB_TRANSIENT_FAILURE") -> None:
        super().__init__(message)
        self.error_code = error_code


class TerminalJobError(RuntimeError):
    """A failure retrying cannot fix: a malformed envelope, an unsupported schema major."""

    def __init__(self, message: str, *, error_code: str = "JOB_TERMINAL_FAILURE") -> None:
        super().__init__(message)
        self.error_code = error_code


class QueueConsumer:
    """Consumes commands from one BullMQ queue and dispatches them to a handler.

    One consumer per worker process. The queue it binds to comes from configuration and is
    never inferred, so a GPU worker cannot silently end up draining the `ai` queue.
    """

    def __init__(
        self,
        settings: WorkerSettings,
        health: WorkerHealth,
        handler: JobHandler,
        db: Database,
        storage: ObjectStorage,
    ) -> None:
        self._settings = settings
        self._health = health
        self._handler = handler
        self._db = db
        self._storage = storage
        self._worker: Worker | None = None

    async def start(self) -> None:
        """Begin consuming.

        `autorun=True` lets the client drive its own fetch loop; this method returns once
        the worker is running rather than blocking, so the caller can also serve the health
        endpoints.
        """
        app = self._settings.app
        self._worker = Worker(
            app.queue_name,
            self._process,
            {
                "connection": str(self._settings.secrets.redis_url),
                "prefix": app.queue_prefix,
                "concurrency": app.concurrency,
                "autorun": True,
                # lockDuration is how long BullMQ considers a job's lease valid before
                # treating it as stalled. It must exceed the longest plausible processing
                # time or a slow job gets handed to a second worker while the first is
                # still running it. Phase 1 has no real work, so the default is left in
                # place -- but this is the knob a human must set per queue before real
                # TTS/LLM work lands, since those run for minutes.
            },
        )
        log.info(
            "queue.consumer_started",
            queue=app.queue_name,
            queue_prefix=app.queue_prefix,
            concurrency=app.concurrency,
        )

    async def _process(self, job: Job, token: str) -> None:
        """BullMQ processor callback. Returning acks; raising nacks."""
        # Refuse work once draining. BullMQ has already handed us the job, so raising a
        # transient error is the correct response: it releases the message back for
        # another worker rather than completing it without doing the work.
        if self._health.is_draining:
            raise TransientJobError(
                "Worker is draining; releasing job back to the queue.",
                error_code="WORKER_DRAINING",
            )

        try:
            envelope = SimpleJobEnvelope.model_validate(job.data)
        except ValidationError as exc:
            # No correlation context available -- the envelope is what carries it.
            log.error(
                "queue.envelope_invalid",
                error_code="ENVELOPE_MALFORMED",
                bullmq_job_id=job.id,
                bullmq_job_name=job.name,
                error=str(exc),
            )
            raise UnrecoverableError(f"Malformed job envelope: {exc}") from exc

        message_type = job.name
        max_attempts = job.opts.get("attempts", 1) if job.opts else 1
        context = JobContext(
            envelope=envelope,
            message_type=message_type,
            db=self._db,
            storage=self._storage,
            settings=self._settings,
            attempt=job.attemptsMade + 1,
            max_attempts=max_attempts,
        )

        with bind_job_context(envelope, worker_id=self._settings.app.worker_id):
            self._health.job_started()
            try:
                log.info("job.started", message_type=message_type, bullmq_job_id=job.id)
                await self._handler(context)
                log.info("job.completed", message_type=message_type)
            except TerminalJobError as exc:
                log.error(
                    "job.failed_terminal",
                    error_code=exc.error_code,
                    message_type=message_type,
                    error=str(exc),
                )
                raise UnrecoverableError(str(exc)) from exc
            except TransientJobError as exc:
                log.warning(
                    "job.failed_transient",
                    error_code=exc.error_code,
                    message_type=message_type,
                    error=str(exc),
                )
                raise
            except Exception as exc:
                # An unclassified exception is treated as retryable. That is the safer
                # default: retrying a genuinely terminal failure costs a few attempts and
                # then dead-letters visibly, whereas discarding a retryable failure loses
                # a chunk of somebody's audiobook silently.
                log.exception(
                    "job.failed_unexpected",
                    error_code="JOB_UNEXPECTED_ERROR",
                    message_type=message_type,
                    error=str(exc),
                )
                raise
            finally:
                self._health.job_finished()

    async def drain(self, grace_period_seconds: float) -> None:
        """Stop accepting, let in-flight work finish, then close.

        The order matters and follows `tts-provider-specification.md` §53.1:

          1. pause  -- deregister from the queue's active consumer set, stop fetching
          2. wait   -- let in-flight jobs finish within the grace period
          3. close  -- release the connection

        `close(force=False)` waits for active jobs; anything still running past the grace
        period is force-closed, which releases its lock so the message becomes visible to
        another worker again rather than being lost.
        """
        if self._worker is None:
            return

        log.info("queue.draining", grace_period_seconds=grace_period_seconds)

        # 1. Stop accepting new work. do_not_wait_active=True returns immediately; the
        #    waiting is done explicitly below so it can be bounded by the grace period.
        try:
            await self._worker.pause(do_not_wait_active=True)
        except Exception as exc:  # noqa: BLE001 - shutdown must not raise
            log.warning("queue.pause_failed", error_code="QUEUE_PAUSE_FAILED", error=str(exc))

        # 2. Give in-flight work its grace period.
        finished = await self._health.wait_for_in_flight(grace_period_seconds)
        if not finished:
            log.warning(
                "queue.drain_timeout",
                error_code="DRAIN_GRACE_PERIOD_EXCEEDED",
                in_flight=self._health.in_flight,
            )

        # 3. Close. Force only if work is still running, so unfinished work is released
        #    back to the queue rather than acknowledged.
        try:
            await asyncio.wait_for(
                self._worker.close(force=not finished),
                timeout=max(5.0, grace_period_seconds / 2),
            )
        except Exception as exc:  # noqa: BLE001 - shutdown must not raise
            log.warning("queue.close_failed", error_code="QUEUE_CLOSE_FAILED", error=str(exc))

        self._worker = None
        log.info("queue.drained")

    async def ping(self) -> bool:
        """Verify Redis is reachable. Part of the STARTING -> HEALTHY dependency check.

        Deliberately uses a plain redis client rather than instantiating a Worker: creating
        a Worker registers this process as a consumer, which must not happen until the
        worker is actually ready to consume.
        """
        import redis.asyncio as aioredis

        client: Any = None
        try:
            client = aioredis.from_url(str(self._settings.secrets.redis_url))
            await client.ping()
            return True
        except Exception as exc:  # noqa: BLE001 - a probe reports, it does not raise
            log.warning("queue.ping_failed", error_code="REDIS_UNREACHABLE", error=str(exc))
            return False
        finally:
            if client is not None:
                await client.aclose()
