"""Envelope conformance to `event-contracts.md` §6 and §7.

These are cross-language contract tests: the JSON asserted here is the JSON the TypeScript
producer emits, so a failure means the two halves have drifted.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from workers_common.correlation import (
    bind_job_context,
    causation_id_for_downstream,
    get_context,
)
from workers_common.events import (
    CommandEnvelope,
    EventEnvelope,
    JobPriority,
    MessageType,
    QueueName,
    new_event,
    new_id,
    queue_for,
    utc_now,
)

# The §6.1 example verbatim.
COMMAND_JSON = {
    "message_id": "0199c4f0-7a31-7c02-b8e4-3f9a2d1e6b40",
    "message_type": "generate_tts_chunk",
    "schema_version": "1.0",
    "enqueued_at": "2026-08-27T15:04:03.221Z",
    "correlation_id": "0199c4ef-2b10-7a44-9c31-77e0a1b2c3d4",
    "causation_id": "0199c4ef-9f52-7d18-a002-5e1122334455",
    "tenant_id": "0199c4e0-0000-7000-8000-000000000001",
    "book_id": "0199c4e1-1111-7000-8000-000000000002",
    "book_version_id": "0199c4e2-2222-7000-8000-000000000003",
    "job_id": "0199c4ef-9f52-7d18-a002-5e1122334455",
    "attempt": 1,
    "lease_fence": 14,
    "idempotency_key": "tts:0199c4f1:4:0199c4d0:77aa31",
    "priority": "NORMAL",
    "producer": "api",
    "producer_version": "api@1.4.2",
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "payload": {},
}

# The §7.1 example verbatim.
EVENT_JSON = {
    "event_id": "0199c4f2-1a2b-7c3d-8e4f-556677889900",
    "event_type": "tts.chunk_completed",
    "schema_version": "1.0",
    "occurred_at": "2026-08-27T15:06:11.004Z",
    "correlation_id": "0199c4ef-2b10-7a44-9c31-77e0a1b2c3d4",
    "causation_id": "0199c4f0-7a31-7c02-b8e4-3f9a2d1e6b40",
    "tenant_id": "0199c4e0-0000-7000-8000-000000000001",
    "book_id": "0199c4e1-1111-7000-8000-000000000002",
    "book_version_id": "0199c4e2-2222-7000-8000-000000000003",
    "job_id": "0199c4ef-9f52-7d18-a002-5e1122334455",
    "producer": "worker-gpu",
    "producer_version": "worker-gpu@2.1.0",
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-1a2b3c4d5e6f7081-01",
    "payload": {},
}


def test_parses_the_spec_command_example() -> None:
    env = CommandEnvelope.model_validate(COMMAND_JSON)
    assert env.message_type is MessageType.GENERATE_TTS_CHUNK
    assert env.priority is JobPriority.NORMAL
    assert env.attempt == 1
    assert env.lease_fence == 14
    assert env.schema_version == "1.0"
    assert env.enqueued_at.tzinfo is not None


def test_parses_the_spec_event_example() -> None:
    env = EventEnvelope.model_validate(EVENT_JSON)
    assert env.event_type == "tts.chunk_completed"
    assert env.producer == "worker-gpu"
    assert str(env.event_id) == EVENT_JSON["event_id"]


def test_command_roundtrips_without_drift() -> None:
    """Serialising what we parsed must reproduce the producer's bytes."""
    env = CommandEnvelope.model_validate(COMMAND_JSON)
    dumped = json.loads(env.model_dump_json())
    assert dumped == COMMAND_JSON


def test_event_roundtrips_without_drift() -> None:
    env = EventEnvelope.model_validate(EVENT_JSON)
    dumped = json.loads(env.model_dump_json())
    assert dumped == EVENT_JSON


def test_timestamps_serialise_with_a_literal_z() -> None:
    """§7.3: RFC 3339 UTC with an explicit `Z`, not `+00:00`."""
    env = EventEnvelope.model_validate(EVENT_JSON)
    dumped = json.loads(env.model_dump_json())
    assert dumped["occurred_at"].endswith("Z")
    assert "+00:00" not in dumped["occurred_at"]


def test_non_utc_input_is_normalised_to_utc_z() -> None:
    from datetime import timedelta, timezone

    env = new_event(
        event_type="tts.chunk_completed",
        schema_version="1.0",
        producer="worker-gpu",
        producer_version="worker-gpu@2.1.0",
        tenant_id=new_id(),
        correlation_id=new_id(),
        causation_id=new_id(),
        occurred_at=datetime(2026, 8, 27, 17, 6, 11, tzinfo=timezone(timedelta(hours=2))),
    )
    dumped = json.loads(env.model_dump_json())
    assert dumped["occurred_at"] == "2026-08-27T15:06:11.000Z"


def test_naive_datetime_is_rejected_on_serialisation() -> None:
    env = new_event(
        event_type="x.y",
        schema_version="1.0",
        producer="p",
        producer_version="p@1",
        tenant_id=new_id(),
        correlation_id=new_id(),
        causation_id=new_id(),
        occurred_at=datetime(2026, 8, 27, 15, 6, 11),  # noqa: DTZ001 - the point of the test
    )
    with pytest.raises(ValueError, match="Naive datetime"):
        env.model_dump_json()


# --------------------------------------------------------------------------- #
# Forward compatibility (§6.3 rule 1)
# --------------------------------------------------------------------------- #
def test_unknown_envelope_fields_are_ignored_not_rejected() -> None:
    """A worker MUST ignore unknown envelope fields.

    Rejecting them would make every additive schema change a breaking deploy-ordering
    problem, since producers and consumers never update simultaneously.
    """
    env = CommandEnvelope.model_validate({**COMMAND_JSON, "some_future_field": "value"})
    assert env.message_type is MessageType.GENERATE_TTS_CHUNK
    assert not hasattr(env, "some_future_field")


@pytest.mark.parametrize(
    "missing",
    [
        "message_id",
        "message_type",
        "schema_version",
        "correlation_id",
        "causation_id",
        "tenant_id",
        "job_id",
        "attempt",
        "lease_fence",
        "idempotency_key",
        "priority",
        "producer",
        "producer_version",
        "enqueued_at",
    ],
)
def test_required_command_fields_are_required(missing: str) -> None:
    payload = {k: v for k, v in COMMAND_JSON.items() if k != missing}
    with pytest.raises(ValidationError):
        CommandEnvelope.model_validate(payload)


def test_optional_fields_may_be_absent() -> None:
    """`book_id`, `book_version_id` and `traceparent` are conditional, not required."""
    payload = {
        k: v
        for k, v in COMMAND_JSON.items()
        if k not in ("book_id", "book_version_id", "traceparent")
    }
    env = CommandEnvelope.model_validate(payload)
    assert env.book_id is None
    assert env.traceparent is None


def test_event_job_id_may_be_absent() -> None:
    """Facts produced synchronously (`voice.approved`) carry no job_id."""
    payload = {k: v for k, v in EVENT_JSON.items() if k != "job_id"}
    env = EventEnvelope.model_validate(payload)
    assert env.job_id is None


def test_envelopes_are_immutable() -> None:
    env = CommandEnvelope.model_validate(COMMAND_JSON)
    with pytest.raises(ValidationError):
        env.attempt = 2


# --------------------------------------------------------------------------- #
# schema_version
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("version", ["1.0", "2.13", "10.0", "0.1"])
def test_valid_schema_versions(version: str) -> None:
    env = CommandEnvelope.model_validate({**COMMAND_JSON, "schema_version": version})
    assert env.schema_version == version


@pytest.mark.parametrize("version", ["1", "1.0.0", "v1.0", "1.x", "", "1.0-beta"])
def test_invalid_schema_versions_rejected(version: str) -> None:
    """MAJOR.MINOR only. Notably NOT semver: there is no patch component."""
    with pytest.raises(ValidationError):
        CommandEnvelope.model_validate({**COMMAND_JSON, "schema_version": version})


def test_schema_version_components() -> None:
    env = CommandEnvelope.model_validate({**COMMAND_JSON, "schema_version": "2.13"})
    assert env.schema_major == 2
    assert env.schema_minor == 13


def test_compatibility_is_major_only() -> None:
    """A MINOR bump is additive and safe; a MAJOR bump is not (§14)."""
    v1_0 = CommandEnvelope.model_validate({**COMMAND_JSON, "schema_version": "1.0"})
    v1_9 = CommandEnvelope.model_validate({**COMMAND_JSON, "schema_version": "1.9"})
    v2_0 = CommandEnvelope.model_validate({**COMMAND_JSON, "schema_version": "2.0"})

    assert v1_0.is_compatible_with(1)
    assert v1_9.is_compatible_with(1)  # newer minor still processable
    assert not v2_0.is_compatible_with(1)


# --------------------------------------------------------------------------- #
# Identifiers
# --------------------------------------------------------------------------- #
def test_new_id_is_uuid7() -> None:
    generated = new_id()
    assert isinstance(generated, uuid.UUID)
    assert generated.version == 7


def test_uuid7_is_time_ordered() -> None:
    """The property the whole choice of v7 rests on: ids sort by creation time."""
    ids = [new_id() for _ in range(50)]
    assert [str(i) for i in ids] == sorted(str(i) for i in ids)


def test_ids_are_unique() -> None:
    assert len({new_id() for _ in range(1000)}) == 1000


def test_utc_now_is_aware() -> None:
    now = utc_now()
    assert now.tzinfo is not None
    assert now.utcoffset() == UTC.utcoffset(None)


def test_malformed_uuid_rejected() -> None:
    with pytest.raises(ValidationError):
        CommandEnvelope.model_validate({**COMMAND_JSON, "job_id": "not-a-uuid"})


@pytest.mark.parametrize("bad_attempt", [0, -1])
def test_attempt_must_be_at_least_one(bad_attempt: int) -> None:
    with pytest.raises(ValidationError):
        CommandEnvelope.model_validate({**COMMAND_JSON, "attempt": bad_attempt})


# --------------------------------------------------------------------------- #
# Routing (§5.3)
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("message_type", "expected"),
    [
        (MessageType.PARSE_BOOK, QueueName.PARSE),
        (MessageType.OCR_PAGE, QueueName.PARSE),
        (MessageType.ANALYZE_SCENE, QueueName.AI),
        (MessageType.GENERATE_DIRECTOR_IR, QueueName.AI),
        (MessageType.GENERATE_TTS_CHUNK, QueueName.GPU),
        (MessageType.GENERATE_VOICE_PREVIEW, QueueName.GPU),
        (MessageType.ASSEMBLE_CHAPTER, QueueName.AUDIO),
        (MessageType.CLEANUP_ARTIFACTS, QueueName.MAINTENANCE),
    ],
)
def test_routing_table(message_type: MessageType, expected: QueueName) -> None:
    assert queue_for(message_type) is expected


def test_verify_transcript_has_no_static_route() -> None:
    """§5.3 routes it to `gpu` OR `audio` per deployment; hard-coding one would be wrong."""
    with pytest.raises(ValueError, match="deployment configuration"):
        queue_for(MessageType.VERIFY_TRANSCRIPT)


def test_command_exposes_its_queue() -> None:
    env = CommandEnvelope.model_validate(COMMAND_JSON)
    assert env.queue is QueueName.GPU


def test_all_seventeen_job_types_exist() -> None:
    assert len(MessageType) == 17


def test_five_queues_exist() -> None:
    assert len(QueueName) == 5


def test_unknown_message_type_rejected() -> None:
    with pytest.raises(ValidationError):
        CommandEnvelope.model_validate({**COMMAND_JSON, "message_type": "do_something"})


# --------------------------------------------------------------------------- #
# Correlation propagation
# --------------------------------------------------------------------------- #
def test_new_event_generates_a_fresh_event_id() -> None:
    common = {
        "event_type": "tts.chunk_completed",
        "schema_version": "1.0",
        "producer": "worker-gpu",
        "producer_version": "worker-gpu@2.1.0",
        "tenant_id": new_id(),
        "correlation_id": new_id(),
        "causation_id": new_id(),
    }
    first, second = new_event(**common), new_event(**common)  # type: ignore[arg-type]
    assert first.event_id != second.event_id


def test_bind_job_context_binds_every_id() -> None:
    env = CommandEnvelope.model_validate(COMMAND_JSON)
    with bind_job_context(env, worker_id="worker-gpu-0"):
        ctx = get_context()
        assert ctx.correlation_id == COMMAND_JSON["correlation_id"]
        assert ctx.job_id == COMMAND_JSON["job_id"]
        assert ctx.worker_id == "worker-gpu-0"
        assert ctx.attempt == 1
        assert ctx.lease_fence == 14

    # Unbound again outside the block.
    assert get_context().correlation_id is None


def test_downstream_causation_is_this_messages_id_not_its_causation() -> None:
    """§9: causation_id is a parent pointer to the IMMEDIATELY preceding message."""
    env = CommandEnvelope.model_validate(COMMAND_JSON)
    with bind_job_context(env):
        assert causation_id_for_downstream() == COMMAND_JSON["message_id"]
        assert causation_id_for_downstream() != COMMAND_JSON["causation_id"]


def test_log_fields_omit_unset_ids() -> None:
    from workers_common.correlation import bind_context

    with bind_context(correlation_id="c-1"):
        fields = get_context().as_log_fields()
        assert fields == {"correlation_id": "c-1"}
        assert "job_id" not in fields


def test_binding_an_unknown_field_is_rejected() -> None:
    """A typo'd id must fail loudly, not silently produce logs that look correct."""
    from workers_common.correlation import bind_context

    with pytest.raises(ValueError, match="Unknown correlation field"):  # noqa: SIM117
        with bind_context(corelation_id="typo"):
            pass


def test_nested_binds_restore_the_outer_value() -> None:
    from workers_common.correlation import bind_context

    with bind_context(correlation_id="outer"):
        with bind_context(correlation_id="inner"):
            assert get_context().correlation_id == "inner"
        assert get_context().correlation_id == "outer"
