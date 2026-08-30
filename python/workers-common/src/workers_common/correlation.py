"""Contextvars-based propagation of correlation identifiers.

Every log line emitted while a job is being processed must carry the ids that let an
operator reconstruct the causal tree (`event-contracts.md` §9). Threading those ids
through every function signature by hand is unworkable, so they are bound to
`contextvars` instead and read back by a structlog processor (see `logging.py`).

`contextvars` is the correct primitive here rather than a thread-local: asyncio tasks
each get a copy-on-write view of the context, so two jobs processed concurrently in the
same event loop cannot observe each other's ids.

Typical use, at the top of a job handler::

    with bind_job_context(envelope, worker_id=settings.worker_id):
        log.info("job.started")   # carries correlation_id, job_id, worker_id, ...
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - import cycle guard, typing only
    from workers_common.events import CommandEnvelope

# Each id is its own ContextVar so that a partial bind (e.g. a correlation id known at
# startup, before any job exists) does not have to invent placeholder values for the rest.
_correlation_id: ContextVar[str | None] = ContextVar("correlation_id", default=None)
_causation_id: ContextVar[str | None] = ContextVar("causation_id", default=None)
_message_id: ContextVar[str | None] = ContextVar("message_id", default=None)
_job_id: ContextVar[str | None] = ContextVar("job_id", default=None)
_worker_id: ContextVar[str | None] = ContextVar("worker_id", default=None)
_tenant_id: ContextVar[str | None] = ContextVar("tenant_id", default=None)
_attempt: ContextVar[int | None] = ContextVar("attempt", default=None)
_lease_fence: ContextVar[int | None] = ContextVar("lease_fence", default=None)

_ALL_VARS: dict[str, ContextVar[Any]] = {
    "correlation_id": _correlation_id,
    "causation_id": _causation_id,
    "message_id": _message_id,
    "job_id": _job_id,
    "worker_id": _worker_id,
    "tenant_id": _tenant_id,
    "attempt": _attempt,
    "lease_fence": _lease_fence,
}


@dataclass(frozen=True, slots=True)
class CorrelationContext:
    """A snapshot of the currently bound identifiers."""

    correlation_id: str | None = None
    causation_id: str | None = None
    message_id: str | None = None
    job_id: str | None = None
    worker_id: str | None = None
    tenant_id: str | None = None
    attempt: int | None = None
    lease_fence: int | None = None

    def as_log_fields(self) -> dict[str, Any]:
        """Only the ids that are actually set.

        The logging contract requires `job_id` and `worker_id` "when applicable"; emitting
        them as explicit nulls on every startup line would be noise, so unset ids are
        omitted entirely.
        """
        return {
            key: value
            for key, value in {
                "correlation_id": self.correlation_id,
                "causation_id": self.causation_id,
                "message_id": self.message_id,
                "job_id": self.job_id,
                "worker_id": self.worker_id,
                "tenant_id": self.tenant_id,
                "attempt": self.attempt,
                "lease_fence": self.lease_fence,
            }.items()
            if value is not None
        }


def get_context() -> CorrelationContext:
    """Read the identifiers bound to the current asyncio task / thread."""
    return CorrelationContext(
        correlation_id=_correlation_id.get(),
        causation_id=_causation_id.get(),
        message_id=_message_id.get(),
        job_id=_job_id.get(),
        worker_id=_worker_id.get(),
        tenant_id=_tenant_id.get(),
        attempt=_attempt.get(),
        lease_fence=_lease_fence.get(),
    )


@contextmanager
def bind_context(**fields: Any) -> Iterator[None]:
    """Bind identifiers for the duration of the block, restoring the previous values after.

    Unknown keys are rejected loudly rather than silently ignored: a typo'd
    ``corelation_id`` that quietly did nothing would produce logs that look correct and
    are not.
    """
    unknown = set(fields) - set(_ALL_VARS)
    if unknown:
        raise ValueError(
            f"Unknown correlation field(s): {sorted(unknown)}. Valid fields: {sorted(_ALL_VARS)}"
        )

    tokens: list[tuple[ContextVar[Any], Token[Any]]] = []
    try:
        for key, value in fields.items():
            if value is None:
                continue
            var = _ALL_VARS[key]
            tokens.append((var, var.set(value)))
        yield
    finally:
        # Reset in reverse order so nested binds unwind correctly.
        for var, token in reversed(tokens):
            var.reset(token)


@contextmanager
def bind_job_context(
    envelope: CommandEnvelope,
    *,
    worker_id: str | None = None,
) -> Iterator[None]:
    """Bind every identifier carried by an incoming command envelope.

    This is the propagation boundary: ids arrive over the wire in the envelope and become
    ambient log context for everything the handler does.

    Note `causation_id`: for work *this* job goes on to produce, the correct parent pointer
    is this message's own `message_id`, not the `causation_id` it arrived with
    (`event-contracts.md` §9). Use `causation_id_for_downstream()` when building outbound
    messages rather than re-reading `causation_id` from the context.
    """
    with bind_context(
        correlation_id=str(envelope.correlation_id),
        causation_id=str(envelope.causation_id),
        message_id=str(envelope.message_id),
        job_id=str(envelope.job_id),
        tenant_id=str(envelope.tenant_id),
        attempt=envelope.attempt,
        lease_fence=envelope.lease_fence,
        worker_id=worker_id,
    ):
        yield


def causation_id_for_downstream() -> str | None:
    """The `causation_id` any message produced from within this context must carry.

    That is this message's `message_id` — the id of the thing that directly caused the new
    message — and *not* the inbound `causation_id`, which points one hop further up.
    """
    return _message_id.get()
