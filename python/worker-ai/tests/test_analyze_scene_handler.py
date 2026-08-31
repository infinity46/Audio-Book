"""Orchestration tests for `handle_analyze_scene` -- see `conftest.py` for why these
monkeypatch the `worker_ai.repo` layer rather than hitting a real Postgres.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock

import pytest

from worker_ai.handlers import analyze_scene as analyze_scene_module
from worker_ai.repo import model_registry, reads, story_bible, writes_scene
from worker_ai.semantic.deterministic import DeterministicSemanticAnalyzer
from workers_common.events import SimpleJobEnvelope
from workers_common.queue import JobContext

JOB_ID = str(uuid.uuid4())
CHAPTER_ID = str(uuid.uuid4())
BOOK_ID = str(uuid.uuid4())
BOOK_VERSION_ID = str(uuid.uuid4())
TENANT_ID = str(uuid.uuid4())
CORRELATION_ID = str(uuid.uuid4())


def _envelope(**payload_overrides: Any) -> SimpleJobEnvelope:
    payload = {
        "book_id": BOOK_ID,
        "book_version_id": BOOK_VERSION_ID,
        "chapter_id": CHAPTER_ID,
        "spine_start": 0,
        "spine_end": 10,
        "story_bible_version_id": None,
        "analysis_mode": "INCREMENTAL",
        "remaining_chapter_ids": [],
        "root_job_id": JOB_ID,
        "chapters_total": 1,
        **payload_overrides,
    }
    return SimpleJobEnvelope(
        job_id=uuid.UUID(JOB_ID),
        entity_id=uuid.UUID(JOB_ID),
        correlation_id=uuid.UUID(CORRELATION_ID),
        causation_id=uuid.UUID(CORRELATION_ID),
        tenant_id=uuid.UUID(TENANT_ID),
        payload=payload,
    )


def _ctx(fake_db: Any, **payload_overrides: Any) -> JobContext:
    return JobContext(
        envelope=_envelope(**payload_overrides),
        message_type="analyze_scene",
        db=fake_db,  # type: ignore[arg-type]
        storage=None,  # type: ignore[arg-type]
        settings=None,  # type: ignore[arg-type]
        attempt=1,
        max_attempts=3,
    )


def _patch_common_reads(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        reads,
        "load_job",
        AsyncMock(
            return_value=reads.JobRow(
                id=JOB_ID,
                tenant_id=TENANT_ID,
                book_id=BOOK_ID,
                status="CREATED",
                scope=None,
                correlation_id=CORRELATION_ID,
                parent_job_id=None,
            )
        ),
    )
    monkeypatch.setattr(
        reads,
        "load_chapter",
        AsyncMock(
            return_value=reads.ChapterRow(
                id=CHAPTER_ID,
                tenant_id=TENANT_ID,
                book_id=BOOK_ID,
                book_version_id=BOOK_VERSION_ID,
                order_index=0,
                spine_start=0,
                spine_end=10,
                title="Chapter One",
            )
        ),
    )
    monkeypatch.setattr(
        reads,
        "load_book_version",
        AsyncMock(
            return_value=reads.BookVersionRow(
                id=BOOK_VERSION_ID, book_id=BOOK_ID, content_hash="a" * 64
            )
        ),
    )
    monkeypatch.setattr(
        reads,
        "load_paragraphs",
        AsyncMock(
            return_value=[
                _paragraph("p1", 0, "Alice Carter walked into the kitchen."),
                _paragraph("p2", 1, '"Where is everyone?" said Alice.'),
            ]
        ),
    )
    monkeypatch.setattr(reads, "load_known_characters", AsyncMock(return_value=[]))
    monkeypatch.setattr(reads, "load_latest_narrative_state", AsyncMock(return_value=None))
    monkeypatch.setattr(
        model_registry, "resolve_model_version_id", AsyncMock(return_value="model-version-1")
    )
    monkeypatch.setattr(story_bible, "get_next_version_number", AsyncMock(return_value=1))
    monkeypatch.setattr(
        story_bible, "create_story_bible_version", AsyncMock(return_value="sbv-1")
    )
    monkeypatch.setattr(writes_scene, "mark_job_running", AsyncMock())
    monkeypatch.setattr(writes_scene, "mark_job_failed", AsyncMock())
    monkeypatch.setattr(writes_scene, "mark_job_succeeded", AsyncMock())
    monkeypatch.setattr(
        writes_scene, "create_character", AsyncMock(side_effect=_incrementing_ids("char"))
    )
    monkeypatch.setattr(writes_scene, "create_alias", AsyncMock(return_value="alias-1"))
    monkeypatch.setattr(writes_scene, "update_character_last_appearance", AsyncMock())
    monkeypatch.setattr(
        writes_scene, "create_scene", AsyncMock(side_effect=_incrementing_ids("scene"))
    )
    monkeypatch.setattr(
        writes_scene,
        "create_scene_semantics",
        AsyncMock(side_effect=_incrementing_ids("semantics")),
    )
    monkeypatch.setattr(writes_scene, "create_scene_participant", AsyncMock())
    monkeypatch.setattr(writes_scene, "create_narrative_state", AsyncMock(return_value="ns-1"))
    monkeypatch.setattr(writes_scene, "create_child_job", AsyncMock())


def _paragraph(id_: str, order: int, text: str) -> Any:
    from worker_ai.semantic.schemas import ParagraphInput

    return ParagraphInput(id=id_, order_index=order, spine_position=order, text=text)


def _incrementing_ids(prefix: str) -> Any:
    # Real repo functions always return a UUID string (`workers_common.events.new_id()`);
    # the handler relies on that to build `uuid.UUID(...)` outbox payloads, so fakes must
    # return UUID-shaped strings too rather than a human-readable "prefix-N" token.
    del prefix
    counter = iter(range(1, 1000))

    async def _fn(*_args: Any, **_kwargs: Any) -> str:
        return str(uuid.UUID(int=next(counter)))

    return _fn


@pytest.mark.asyncio
async def test_already_terminal_job_is_a_safe_no_op(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_queue: Any
) -> None:
    monkeypatch.setattr(
        reads,
        "load_job",
        AsyncMock(
            return_value=reads.JobRow(
                id=JOB_ID,
                tenant_id=TENANT_ID,
                book_id=BOOK_ID,
                status="SUCCEEDED",
                scope=None,
                correlation_id=CORRELATION_ID,
                parent_job_id=None,
            )
        ),
    )
    mark_running = AsyncMock()
    monkeypatch.setattr(writes_scene, "mark_job_running", mark_running)

    ctx = _ctx(fake_db)
    await analyze_scene_module.handle_analyze_scene(
        ctx, analyzer=DeterministicSemanticAnalyzer(), queue_producer=fake_queue
    )

    mark_running.assert_not_called()
    assert fake_queue.enqueued == []


@pytest.mark.asyncio
async def test_successful_run_creates_story_bible_version_and_enqueues_next_job(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_queue: Any
) -> None:
    _patch_common_reads(monkeypatch)

    ctx = _ctx(fake_db, remaining_chapter_ids=[])
    await analyze_scene_module.handle_analyze_scene(
        ctx, analyzer=DeterministicSemanticAnalyzer(), queue_producer=fake_queue
    )

    assert len(fake_queue.enqueued) == 1
    enqueued = fake_queue.enqueued[0]
    assert enqueued["job_name"] == "build_story_bible_delta"
    assert enqueued["payload"]["chapter_id"] == CHAPTER_ID
    assert enqueued["payload"]["story_bible_version_id"] == "sbv-1"
    assert enqueued["payload"]["remaining_chapter_ids"] == []
    assert enqueued["correlation_id"] == CORRELATION_ID


@pytest.mark.asyncio
async def test_existing_story_bible_version_is_reused_not_recreated(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_queue: Any
) -> None:
    _patch_common_reads(monkeypatch)
    create_version = AsyncMock()
    monkeypatch.setattr(story_bible, "create_story_bible_version", create_version)

    ctx = _ctx(fake_db, story_bible_version_id="existing-sbv")
    await analyze_scene_module.handle_analyze_scene(
        ctx, analyzer=DeterministicSemanticAnalyzer(), queue_producer=fake_queue
    )

    create_version.assert_not_called()
    assert fake_queue.enqueued[0]["payload"]["story_bible_version_id"] == "existing-sbv"


@pytest.mark.asyncio
async def test_analyzer_failure_on_final_attempt_marks_job_failed_and_reraises(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_queue: Any
) -> None:
    _patch_common_reads(monkeypatch)

    class ExplodingAnalyzer(DeterministicSemanticAnalyzer):
        async def analyze_chapter(self, chapter_input: Any) -> Any:
            from workers_common.queue import TerminalJobError

            raise TerminalJobError("boom", error_code="INVALID_MODEL_OUTPUT")

    mark_failed = AsyncMock()
    monkeypatch.setattr(writes_scene, "mark_job_failed", mark_failed)

    ctx = JobContext(
        envelope=_envelope(),
        message_type="analyze_scene",
        db=fake_db,
        storage=None,  # type: ignore[arg-type]
        settings=None,  # type: ignore[arg-type]
        attempt=3,
        max_attempts=3,
    )

    with pytest.raises(Exception, match="boom"):
        await analyze_scene_module.handle_analyze_scene(
            ctx, analyzer=ExplodingAnalyzer(), queue_producer=fake_queue
        )

    mark_failed.assert_called_once()
    assert fake_queue.enqueued == []


@pytest.mark.asyncio
async def test_analyzer_failure_not_on_final_attempt_does_not_mark_failed(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_queue: Any
) -> None:
    """A retryable BullMQ attempt must not flip the job to FAILED -- doing so would
    make the NEXT delivery's idempotency check treat it as terminal and skip
    reprocessing, even though BullMQ intends to retry it."""
    _patch_common_reads(monkeypatch)

    class ExplodingAnalyzer(DeterministicSemanticAnalyzer):
        async def analyze_chapter(self, chapter_input: Any) -> Any:
            from workers_common.queue import TransientJobError

            raise TransientJobError("temporary", error_code="MODEL_TIMEOUT")

    mark_failed = AsyncMock()
    monkeypatch.setattr(writes_scene, "mark_job_failed", mark_failed)

    ctx = JobContext(
        envelope=_envelope(),
        message_type="analyze_scene",
        db=fake_db,
        storage=None,  # type: ignore[arg-type]
        settings=None,  # type: ignore[arg-type]
        attempt=1,
        max_attempts=3,
    )

    with pytest.raises(Exception, match="temporary"):
        await analyze_scene_module.handle_analyze_scene(
            ctx, analyzer=ExplodingAnalyzer(), queue_producer=fake_queue
        )

    mark_failed.assert_not_called()
