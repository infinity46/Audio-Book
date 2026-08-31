"""Command and event envelopes.

These mirror `docs/architecture/event-contracts.md` §6 (command) and §7 (event) exactly.
They are the Python half of a two-language contract: the TypeScript services produce and
consume the same JSON, so any drift here is a production incident rather than a style
disagreement. `context.md` §23 row 26 designates JSON Schema as the neutral source from
which both the TypeScript types and these Pydantic models are ultimately generated; until
that generator exists, these are maintained by hand against the spec.

Serialisation rules that must hold on the wire (§7.3):
  * UTF-8 JSON, `snake_case` field names, `SCREAMING_SNAKE_CASE` enum values
  * timestamps RFC 3339 UTC with an explicit `Z`
  * durations integer milliseconds with an `_ms` suffix; sizes `_bytes`

## UUIDv7

Identifiers are UUIDv7 (RFC 9562), generated application-side so that a producer can know
an id before the row is written. This module uses the **`uuid6` PyPI package**, which
implements draft/RFC 9562 v6, v7 and v8. It was chosen over hand-rolling because the
timestamp-ordering and monotonic-counter details are easy to get subtly wrong, and over the
`uuid7` package because `uuid6` is the more actively maintained of the two and returns a
standard `uuid.UUID`.

`uuid6.uuid7()` returns `uuid.UUID` with `.version == 7`, so it drops straight into
Pydantic's `UUID` handling and into asyncpg's UUID codec with no adapter.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_serializer
from uuid6 import uuid7

__all__ = [
    "CommandEnvelope",
    "EventEnvelope",
    "JobPriority",
    "MessageType",
    "QueueName",
    "SimpleJobEnvelope",
    "new_event",
    "new_id",
    "utc_now",
    "write_outbox_message",
]


def new_id() -> uuid.UUID:
    """A fresh UUIDv7. Time-ordered, so it indexes well as a primary key."""
    return uuid7()


def utc_now() -> datetime:
    """Timezone-aware UTC now. Naive datetimes are never valid on the wire."""
    return datetime.now(UTC)


# `MAJOR.MINOR` -- §6.2. Not semver: there is no patch component, because a payload schema
# change that is invisible to consumers is not a schema change at all.
SchemaVersion = Annotated[
    str,
    StringConstraints(pattern=r"^\d+\.\d+$"),
]

_SCHEMA_VERSION_RE: Final = re.compile(r"^(\d+)\.(\d+)$")


class QueueName(StrEnum):
    """The five queues (`event-contracts.md` §5.1). There are no others."""

    PARSE = "parse"
    AI = "ai"
    GPU = "gpu"
    AUDIO = "audio"
    MAINTENANCE = "maintenance"


class MessageType(StrEnum):
    """The 17 job types (§5.3)."""

    PARSE_BOOK = "parse_book"
    OCR_PAGE = "ocr_page"
    NORMALIZE_TEXT = "normalize_text"
    ANALYZE_STRUCTURE = "analyze_structure"
    ANALYZE_SCENE = "analyze_scene"
    BUILD_STORY_BIBLE_DELTA = "build_story_bible_delta"
    GENERATE_DIRECTOR_IR = "generate_director_ir"
    REVISE_DIRECTOR_IR = "revise_director_ir"
    GENERATE_VOICE_PREVIEW = "generate_voice_preview"
    GENERATE_TTS_CHUNK = "generate_tts_chunk"
    VERIFY_TRANSCRIPT = "verify_transcript"
    VALIDATE_AUDIO = "validate_audio"
    PROCESS_AUDIO = "process_audio"
    ASSEMBLE_CHAPTER = "assemble_chapter"
    ASSEMBLE_AUDIOBOOK = "assemble_audiobook"
    ENCODE_DELIVERY_FORMAT = "encode_delivery_format"
    CLEANUP_ARTIFACTS = "cleanup_artifacts"


class JobPriority(StrEnum):
    """§26. `INTERACTIVE` work must never starve behind a 20-hour render."""

    INTERACTIVE = "INTERACTIVE"
    NORMAL = "NORMAL"
    BULK = "BULK"


# Static routing, resolvable from `message_type` alone. The queue is never a payload field
# (§4.3 rule 2), so it is derived rather than transmitted.
#
# `verify_transcript` is deliberately absent: §5.3 routes it to `gpu` OR `audio` by
# deployment configuration, and a job MUST NOT be published to both. Resolving it from a
# static table here would hard-code one deployment's choice.
_ROUTING: Final[dict[MessageType, QueueName]] = {
    MessageType.PARSE_BOOK: QueueName.PARSE,
    MessageType.OCR_PAGE: QueueName.PARSE,
    MessageType.NORMALIZE_TEXT: QueueName.PARSE,
    MessageType.ANALYZE_STRUCTURE: QueueName.PARSE,
    MessageType.ANALYZE_SCENE: QueueName.AI,
    MessageType.BUILD_STORY_BIBLE_DELTA: QueueName.AI,
    MessageType.GENERATE_DIRECTOR_IR: QueueName.AI,
    MessageType.REVISE_DIRECTOR_IR: QueueName.AI,
    MessageType.GENERATE_VOICE_PREVIEW: QueueName.GPU,
    MessageType.GENERATE_TTS_CHUNK: QueueName.GPU,
    MessageType.VALIDATE_AUDIO: QueueName.AUDIO,
    MessageType.PROCESS_AUDIO: QueueName.AUDIO,
    MessageType.ASSEMBLE_CHAPTER: QueueName.AUDIO,
    MessageType.ASSEMBLE_AUDIOBOOK: QueueName.AUDIO,
    MessageType.ENCODE_DELIVERY_FORMAT: QueueName.AUDIO,
    MessageType.CLEANUP_ARTIFACTS: QueueName.MAINTENANCE,
}


def queue_for(message_type: MessageType) -> QueueName:
    """The queue a job type is routed to.

    Raises for `verify_transcript`, which is deployment-routed; read it from configuration.
    """
    try:
        return _ROUTING[message_type]
    except KeyError as exc:
        raise ValueError(
            f"{message_type.value!r} has no static queue. It is routed by deployment "
            "configuration to exactly one of `gpu` or `audio` (event-contracts.md §5.3)."
        ) from exc


class _Envelope(BaseModel):
    """Fields common to both envelopes."""

    # `extra="ignore"` implements §6.3 rule 1 verbatim: a worker encountering an unknown
    # envelope field MUST ignore it (forward compatibility) but MUST NOT depend on it.
    # Rejecting unknown fields instead would make every additive schema change a breaking
    # deployment-ordering problem.
    model_config = ConfigDict(extra="ignore", frozen=True)

    schema_version: SchemaVersion
    correlation_id: uuid.UUID
    causation_id: uuid.UUID
    tenant_id: uuid.UUID
    book_id: uuid.UUID | None = None
    book_version_id: uuid.UUID | None = None
    producer: str
    producer_version: str
    traceparent: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)

    @property
    def schema_major(self) -> int:
        match = _SCHEMA_VERSION_RE.match(self.schema_version)
        assert match is not None
        return int(match.group(1))

    @property
    def schema_minor(self) -> int:
        match = _SCHEMA_VERSION_RE.match(self.schema_version)
        assert match is not None
        return int(match.group(2))

    def is_compatible_with(self, supported_major: int) -> bool:
        """Whether a consumer built for `supported_major` may process this message.

        A MINOR bump is additive and safe to ignore; a MAJOR bump is not (§14).
        """
        return self.schema_major == supported_major


class CommandEnvelope(_Envelope):
    """§6.1. Every command on every queue carries this.

    `payload` is the only type-specific part; where every input is already in the envelope
    it is legitimately `{}`.
    """

    message_id: uuid.UUID = Field(
        description="Identity of THIS delivery attempt. New on every enqueue, including a "
        "retry re-enqueue. Never reused. Not a business identifier."
    )
    message_type: MessageType
    enqueued_at: datetime
    job_id: uuid.UUID = Field(
        description="The `processing_job.id`. The durable business identity of the work; "
        "survives every retry."
    )
    attempt: Annotated[int, Field(ge=1)]
    lease_fence: int = Field(
        description="Fencing token issued with the lease. MUST be presented on every "
        "transition, heartbeat and result write; a stale token is refused."
    )
    idempotency_key: str = Field(
        description="Server-derived semantic identity of the work. NEVER client-supplied."
    )
    priority: JobPriority

    @field_serializer("enqueued_at")
    def _ser_enqueued_at(self, value: datetime) -> str:
        return _rfc3339(value)

    @property
    def queue(self) -> QueueName:
        return queue_for(self.message_type)


class SimpleJobEnvelope(BaseModel):
    """The envelope the TypeScript `QueueManager` actually produces.

    `event-contracts.md` §6.1 specifies a much richer `CommandEnvelope` (message_id,
    message_type, schema_version, enqueued_at, attempt, lease_fence, idempotency_key,
    priority, producer, producer_version, ...) as the aspirational command wire format.
    But the real TypeScript producer -- `packages/queue/src/job-payload.ts`'s
    `QueueJobEnvelope`, used by every `QueueManager.enqueue()` call in `apps/api` and
    `apps/worker-cpu` -- only ever writes `{job_id, entity_id?, version_id?,
    correlation_id, causation_id?, tenant_id, payload}` onto the BullMQ job. No producer
    in this codebase builds the fuller `CommandEnvelope` shape.

    Rather than have every real handler fail `CommandEnvelope.model_validate(job.data)`
    against fields that were never sent, this model matches what is actually on the
    wire today. The job's *type* is not a payload field at all in that producer -- it is
    BullMQ's own `job.name` (the `jobName` enqueue option) -- so `QueueConsumer` reads
    that separately and attaches it to `JobContext.message_type` (see `queue.py`).

    This is a deliberate, documented adaptation to the real Phase 1/2 producer contract,
    not a silent narrowing of `event-contracts.md` -- `CommandEnvelope` stays available
    for a future producer that emits the fuller envelope.
    """

    model_config = ConfigDict(extra="ignore", frozen=True)

    job_id: uuid.UUID
    entity_id: uuid.UUID | None = None
    version_id: uuid.UUID | None = None
    correlation_id: uuid.UUID
    causation_id: uuid.UUID | None = None
    tenant_id: uuid.UUID
    payload: dict[str, Any] = Field(default_factory=dict)


class EventEnvelope(_Envelope):
    """§7.1. A fact that has already happened.

    Note the asymmetry with `CommandEnvelope`: `event_id` identifies the *fact*, so
    redelivering the same event carries the SAME `event_id` -- which is exactly what makes
    consumer deduplication possible (§20). `message_id` is the opposite: new every time.
    """

    event_id: uuid.UUID
    event_type: str = Field(
        description="One of the 36 names of `context.md` §11.3. Left as `str` rather than "
        "an enum because the full list is owned by the TS contracts package and "
        "duplicating all 36 here would create a second source of truth that can drift."
    )
    occurred_at: datetime = Field(
        description="When the fact became true -- the DATABASE COMMIT TIME, not the publish "
        "time. An outbox message published minutes later still reports when it happened."
    )
    job_id: uuid.UUID | None = Field(
        default=None,
        description="Present when the fact was produced by a job. Absent on facts produced "
        "synchronously (`voice.approved`, `character.confirmed`).",
    )

    @field_serializer("occurred_at")
    def _ser_occurred_at(self, value: datetime) -> str:
        return _rfc3339(value)


async def write_outbox_message(
    session: Any,
    *,
    event_type: str,
    schema_version: str,
    producer: str,
    producer_version: str,
    tenant_id: uuid.UUID,
    correlation_id: uuid.UUID,
    causation_id: uuid.UUID,
    aggregate_type: str,
    aggregate_id: uuid.UUID,
    payload: dict[str, Any],
    book_id: uuid.UUID | None = None,
    job_id: uuid.UUID | None = None,
    traceparent: str | None = None,
) -> uuid.UUID:
    """The Python half of `writeOutboxMessage` (`packages/events/src/outbox.ts`).

    Inserts one `outbox_message` row via the SAME `AsyncSession` (and therefore the same
    transaction) as the domain writes the caller just made -- `db.py`'s `Database.session()`
    only commits once, at the end of the `async with` block, so this row becomes visible
    exactly when the domain state it describes does (event-contracts.md §19.2). Raw SQL,
    not an ORM model: `workers_common/db.py` deliberately has none (the schema is owned by
    Prisma/`database-schema.md`).

    Returns the freshly-minted `event_id` -- the identity of the fact, stable across every
    redelivery the (TypeScript, cross-language) `OutboxPublisher` relay ever attempts for
    this row.
    """
    import json as _json

    from sqlalchemy import text

    event_id = new_id()
    row_id = new_id()
    await session.execute(
        text(
            """
            INSERT INTO outbox_message (
                id, event_id, event_type, schema_version, occurred_at,
                tenant_id, book_id, job_id, correlation_id, causation_id, traceparent,
                producer, producer_version, payload, aggregate_type, aggregate_id,
                status, publish_attempts, created_at
            ) VALUES (
                :id, :event_id, :event_type, :schema_version, :occurred_at,
                :tenant_id, :book_id, :job_id, :correlation_id, :causation_id, :traceparent,
                :producer, :producer_version, CAST(:payload AS JSONB),
                :aggregate_type, :aggregate_id, 'PENDING', 0, :occurred_at
            )
            """
        ),
        {
            "id": str(row_id),
            "event_id": str(event_id),
            "event_type": event_type,
            "schema_version": schema_version,
            "occurred_at": utc_now(),
            "tenant_id": str(tenant_id),
            "book_id": str(book_id) if book_id else None,
            "job_id": str(job_id) if job_id else None,
            "correlation_id": str(correlation_id),
            "causation_id": str(causation_id),
            "traceparent": traceparent,
            "producer": producer,
            "producer_version": producer_version,
            "payload": _json.dumps(payload),
            "aggregate_type": aggregate_type,
            "aggregate_id": str(aggregate_id),
        },
    )
    return event_id


def _rfc3339(value: datetime) -> str:
    """RFC 3339 UTC with an explicit `Z`, per §7.3.

    Python's `isoformat()` renders UTC as `+00:00`; the contract requires `Z`, and the
    TypeScript side produces `Z`, so this normalises rather than letting the two languages
    emit different bytes for the same instant.
    """
    if value.tzinfo is None:
        raise ValueError("Naive datetime is never valid on the wire; use utc_now().")
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_event(
    *,
    event_type: str,
    schema_version: str,
    producer: str,
    producer_version: str,
    tenant_id: uuid.UUID,
    correlation_id: uuid.UUID,
    causation_id: uuid.UUID,
    payload: dict[str, Any] | None = None,
    book_id: uuid.UUID | None = None,
    book_version_id: uuid.UUID | None = None,
    job_id: uuid.UUID | None = None,
    traceparent: str | None = None,
    occurred_at: datetime | None = None,
) -> EventEnvelope:
    """Build a well-formed event envelope with a fresh `event_id`.

    Phase 1 provides the constructor only. Nothing here publishes: an event is published
    through the transactional outbox after its transaction commits, and that machinery is
    not part of this phase.
    """
    return EventEnvelope(
        event_id=new_id(),
        event_type=event_type,
        schema_version=schema_version,
        occurred_at=occurred_at or utc_now(),
        correlation_id=correlation_id,
        causation_id=causation_id,
        tenant_id=tenant_id,
        book_id=book_id,
        book_version_id=book_version_id,
        job_id=job_id,
        producer=producer,
        producer_version=producer_version,
        traceparent=traceparent,
        payload=payload or {},
    )


# Re-exported for callers that want to be explicit about literal schema versions.
SchemaVersionLiteral = Literal["1.0"]
