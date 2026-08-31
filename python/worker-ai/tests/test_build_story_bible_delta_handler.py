"""Orchestration tests for `handle_build_story_bible_delta` -- see `conftest.py` for
why these monkeypatch the `worker_ai.repo` layer rather than hitting a real Postgres.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock

import pytest

from worker_ai.handlers import build_story_bible_delta as handler_module
from worker_ai.repo import reads, story_bible, writes_bible, writes_scene
from workers_common.events import SimpleJobEnvelope
from workers_common.queue import JobContext

JOB_ID = str(uuid.uuid4())
BOOK_ID = str(uuid.uuid4())
BOOK_VERSION_ID = str(uuid.uuid4())
CHAPTER_ID = str(uuid.uuid4())
NEXT_CHAPTER_ID = str(uuid.uuid4())
STORY_BIBLE_VERSION_ID = str(uuid.uuid4())
TENANT_ID = str(uuid.uuid4())
CORRELATION_ID = str(uuid.uuid4())
SOURCE_CHAR_ID = str(uuid.uuid4())
TARGET_CHAR_ID = str(uuid.uuid4())


def _envelope(**payload_overrides: Any) -> SimpleJobEnvelope:
    payload: dict[str, Any] = {
        "book_id": BOOK_ID,
        "book_version_id": BOOK_VERSION_ID,
        "chapter_id": CHAPTER_ID,
        "story_bible_version_id": STORY_BIBLE_VERSION_ID,
        "spine_position": 10,
        "relationships": [],
        "locations": [],
        "remaining_chapter_ids": [],
        "root_job_id": JOB_ID,
        "analysis_mode": "INCREMENTAL",
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
        message_type="build_story_bible_delta",
        db=fake_db,
        storage=None,  # type: ignore[arg-type]
        settings=None,  # type: ignore[arg-type]
        attempt=1,
        max_attempts=3,
    )


def _patch_common(monkeypatch: pytest.MonkeyPatch) -> None:
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
                parent_job_id=JOB_ID,
            )
        ),
    )
    monkeypatch.setattr(
        story_bible,
        "get_story_bible_version",
        AsyncMock(
            return_value=story_bible.StoryBibleVersionRow(
                id=STORY_BIBLE_VERSION_ID,
                book_id=BOOK_ID,
                version=1,
                built_by_model_version_id="model-version-1",
            )
        ),
    )
    monkeypatch.setattr(writes_scene, "mark_job_running", AsyncMock())
    monkeypatch.setattr(writes_scene, "mark_job_succeeded", AsyncMock())
    monkeypatch.setattr(story_bible, "record_chapter_progress", AsyncMock())
    monkeypatch.setattr(writes_bible, "find_existing_relationships", AsyncMock(return_value=[]))
    monkeypatch.setattr(writes_bible, "create_relationship", AsyncMock(return_value="rel-1"))
    monkeypatch.setattr(writes_bible, "extend_relationship_evidence", AsyncMock())
    monkeypatch.setattr(writes_bible, "lower_relationship_confidence", AsyncMock())
    monkeypatch.setattr(writes_bible, "find_location_by_name", AsyncMock(return_value=None))
    monkeypatch.setattr(writes_bible, "create_location", AsyncMock(return_value="loc-1"))
    monkeypatch.setattr(story_bible, "finalize_story_bible", AsyncMock())
    monkeypatch.setattr(writes_scene, "create_child_job", AsyncMock())
    monkeypatch.setattr(
        reads,
        "load_chapter",
        AsyncMock(
            return_value=reads.ChapterRow(
                id=NEXT_CHAPTER_ID,
                tenant_id=TENANT_ID,
                book_id=BOOK_ID,
                book_version_id=BOOK_VERSION_ID,
                order_index=1,
                spine_start=11,
                spine_end=20,
                title="Chapter Two",
            )
        ),
    )
    monkeypatch.setattr(
        reads,
        "load_book_version",
        AsyncMock(
            return_value=reads.BookVersionRow(
                id=BOOK_VERSION_ID, book_id=BOOK_ID, content_hash="b" * 64
            )
        ),
    )


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
                status="FAILED",
                scope=None,
                correlation_id=CORRELATION_ID,
                parent_job_id=None,
            )
        ),
    )
    mark_running = AsyncMock()
    monkeypatch.setattr(writes_scene, "mark_job_running", mark_running)

    ctx = _ctx(fake_db)
    await handler_module.handle_build_story_bible_delta(ctx, queue_producer=fake_queue)

    mark_running.assert_not_called()
    assert fake_queue.enqueued == []


@pytest.mark.asyncio
async def test_more_chapters_remaining_enqueues_next_analyze_scene(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_queue: Any
) -> None:
    _patch_common(monkeypatch)
    finalize = AsyncMock()
    monkeypatch.setattr(story_bible, "finalize_story_bible", finalize)

    ctx = _ctx(fake_db, remaining_chapter_ids=[NEXT_CHAPTER_ID])
    await handler_module.handle_build_story_bible_delta(ctx, queue_producer=fake_queue)

    finalize.assert_not_called()
    assert len(fake_queue.enqueued) == 1
    enqueued = fake_queue.enqueued[0]
    assert enqueued["job_name"] == "analyze_scene"
    assert enqueued["payload"]["chapter_id"] == NEXT_CHAPTER_ID
    assert enqueued["payload"]["story_bible_version_id"] == STORY_BIBLE_VERSION_ID
    assert enqueued["payload"]["remaining_chapter_ids"] == []


@pytest.mark.asyncio
async def test_last_chapter_finalizes_and_emits_no_further_job(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_queue: Any
) -> None:
    _patch_common(monkeypatch)
    finalize = AsyncMock()
    monkeypatch.setattr(story_bible, "finalize_story_bible", finalize)

    ctx = _ctx(fake_db, remaining_chapter_ids=[])
    await handler_module.handle_build_story_bible_delta(ctx, queue_producer=fake_queue)

    finalize.assert_called_once()
    assert fake_queue.enqueued == []


@pytest.mark.asyncio
async def test_same_chapter_conflicting_relationship_types_lower_confidence_and_both_persist(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_queue: Any
) -> None:
    """Two DIFFERENT relationship types for the same pair, staged from the SAME
    chapter's evidence, is the one case this schema can represent as a genuine
    contradiction (see the handler module's docstring) -- both must still be
    persisted (never one silently dropped), with reduced confidence."""
    _patch_common(monkeypatch)
    created: list[dict[str, Any]] = []

    async def _fake_create_relationship(_session: Any, **kwargs: Any) -> str:
        created.append(kwargs)
        return f"rel-{len(created)}"

    monkeypatch.setattr(writes_bible, "create_relationship", _fake_create_relationship)

    relationships = [
        {
            "source_character_id": SOURCE_CHAR_ID,
            "target_character_id": TARGET_CHAR_ID,
            "relationship_type": "FRIENDSHIP",
            "label": "friend",
            "confidence": 0.6,
            "evidence_paragraph_ids": ["p1"],
        },
        {
            "source_character_id": SOURCE_CHAR_ID,
            "target_character_id": TARGET_CHAR_ID,
            "relationship_type": "ADVERSARIAL",
            "label": "enemy",
            "confidence": 0.6,
            "evidence_paragraph_ids": ["p2"],
        },
    ]
    ctx = _ctx(fake_db, relationships=relationships, remaining_chapter_ids=[])
    await handler_module.handle_build_story_bible_delta(ctx, queue_producer=fake_queue)

    assert len(created) == 2
    assert {c["relationship_type"] for c in created} == {"FRIENDSHIP", "ADVERSARIAL"}
    assert all(c["confidence"] <= handler_module._CONTRADICTION_CONFIDENCE_CEILING for c in created)


@pytest.mark.asyncio
async def test_recurring_relationship_across_chapters_merges_evidence_not_contradiction(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_queue: Any
) -> None:
    """The SAME (pair, type) claim seen again in a later chapter is cross-window
    dedup, not a contradiction: evidence merges into the existing row."""
    _patch_common(monkeypatch)
    monkeypatch.setattr(
        writes_bible,
        "find_existing_relationships",
        AsyncMock(
            return_value=[
                writes_bible.ExistingRelationship(
                    id="existing-rel", relationship_type="FRIENDSHIP", valid_from_spine=1
                )
            ]
        ),
    )
    extend = AsyncMock()
    monkeypatch.setattr(writes_bible, "extend_relationship_evidence", extend)
    create_relationship = AsyncMock()
    monkeypatch.setattr(writes_bible, "create_relationship", create_relationship)

    relationships = [
        {
            "source_character_id": SOURCE_CHAR_ID,
            "target_character_id": TARGET_CHAR_ID,
            "relationship_type": "FRIENDSHIP",
            "label": "friend",
            "confidence": 0.6,
            "evidence_paragraph_ids": ["p9"],
        }
    ]
    ctx = _ctx(fake_db, relationships=relationships, remaining_chapter_ids=[])
    await handler_module.handle_build_story_bible_delta(ctx, queue_producer=fake_queue)

    extend.assert_called_once_with(fake_db.session_object, "existing-rel", ["p9"])
    create_relationship.assert_not_called()
