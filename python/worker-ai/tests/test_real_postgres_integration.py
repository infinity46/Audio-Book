"""End-to-end integration test against a REAL Postgres (see docker-compose.yml /
DATABASE_URL) -- the raw SQL in `worker_ai.repo` is otherwise only reviewed, never
executed, in this test suite (see `conftest.py`'s module docstring and the Phase 3
final report's "known limitations"). This is that verification.

Drives the real chain for a synthetic two-chapter book: `analyze_scene`(ch1) ->
`build_story_bible_delta`(ch1) -> `analyze_scene`(ch2) -> `build_story_bible_delta`(ch2,
finalizes). Only the BullMQ enqueue is faked (`FakeQueueProducer` from `conftest.py`) --
every database write is real.

Skips cleanly if DATABASE_URL is not reachable, so this file does not fail CI
environments that never bring up Postgres.
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from worker_ai.handlers.analyze_scene import handle_analyze_scene
from worker_ai.handlers.build_story_bible_delta import handle_build_story_bible_delta
from worker_ai.semantic.deterministic import DeterministicSemanticAnalyzer
from workers_common.config import (
    AppConfig,
    Environment,
    EnvironmentConfig,
    LogLevel,
    ModelConfig,
    Secrets,
    WorkerSettings,
)
from workers_common.db import Database
from workers_common.events import SimpleJobEnvelope
from workers_common.queue import JobContext

from .conftest import FakeQueueProducer

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://audiobook:audiobook_dev_password@localhost:5432/audiobook"
)
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")


def _build_settings() -> WorkerSettings:
    return WorkerSettings(
        env=EnvironmentConfig(environment=Environment.DEVELOPMENT),
        app=AppConfig(
            service_name="worker-ai-test",
            service_version="test@0.0.0",
            worker_id="test-worker",
            log_level=LogLevel.INFO,
            queue_name="ai",
        ),
        secrets=Secrets(
            database_url=DATABASE_URL,  # type: ignore[arg-type]
            redis_url=REDIS_URL,  # type: ignore[arg-type]
            storage_endpoint_url="http://localhost:9000",
            storage_bucket="test-bucket",
            storage_access_key_id="test",  # type: ignore[arg-type]
            storage_secret_access_key="test",  # type: ignore[arg-type]
        ),
        model=ModelConfig(model_id="unused"),
    )


@pytest.fixture
async def real_db() -> Any:
    db = Database(_build_settings())
    try:
        await db.connect()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Postgres not reachable at {DATABASE_URL}: {exc}")
    yield db
    await db.dispose()


def _new_id() -> str:
    return str(uuid.uuid4())


class Fixture:
    """Owns every id used by the fixture book so tests can reference them without
    re-deriving them, and cleans them all up in `teardown`."""

    def __init__(self) -> None:
        self.tenant_id = _new_id()
        self.user_id = _new_id()
        self.book_id = _new_id()
        self.book_file_id = _new_id()
        self.book_version_id = _new_id()
        self.chapter_ids = [_new_id(), _new_id()]
        self.paragraph_ids = [[_new_id(), _new_id()], [_new_id(), _new_id()]]
        self.job_id = _new_id()
        self.correlation_id = _new_id()


async def _seed_model_registry(session: AsyncSession) -> None:
    existing = (
        await session.execute(
            text(
                "SELECT id FROM model_registry WHERE role = 'LLM' "
                "AND provider_id = 'audio-book-nlp' "
                "AND model_id = 'deterministic-heuristic-analyzer'"
            )
        )
    ).first()
    if existing:
        registry_id = str(existing[0])
    else:
        registry_id = _new_id()
        now = datetime.now(UTC)
        await session.execute(
            text(
                """
                INSERT INTO model_registry (id, role, provider_id, model_id,
                                             display_name, status, created_at, updated_at)
                VALUES (:id, 'LLM', 'audio-book-nlp', 'deterministic-heuristic-analyzer',
                        'test', 'ACTIVE', :now, :now)
                """
            ),
            {"id": registry_id, "now": now},
        )

    existing_version = (
        await session.execute(
            text(
                "SELECT id FROM model_version WHERE model_registry_id = :rid AND version = '1.0.0'"
            ),
            {"rid": registry_id},
        )
    ).first()
    if not existing_version:
        now = datetime.now(UTC)
        await session.execute(
            text(
                """
                INSERT INTO model_version (id, model_registry_id, version,
                                            params_fingerprint, released_at, created_at, updated_at)
                VALUES (:id, :rid, '1.0.0', :fingerprint, :now, :now, :now)
                """
            ),
            {"id": _new_id(), "rid": registry_id, "fingerprint": "f" * 64, "now": now},
        )


async def _seed_fixture_book(session: AsyncSession, fx: Fixture) -> None:
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO tenant (id, name, status, plan_code, created_at, updated_at)
            VALUES (:id, 'worker-ai integration test tenant', 'ACTIVE', 'test', :now, :now)
            """
        ),
        {"id": fx.tenant_id, "now": now},
    )
    await session.execute(
        text(
            """
            INSERT INTO "user" (id, tenant_id, email, display_name, status, roles,
                                 preferences, created_at, updated_at)
            VALUES (:id, :tenant_id, :email, 'Fixture User', 'ACTIVE',
                    ARRAY['TENANT_OWNER']::principal_role[], '{}'::jsonb, :now, :now)
            """
        ),
        {
            "id": fx.user_id,
            "tenant_id": fx.tenant_id,
            "email": f"worker-ai-test-{fx.tenant_id}@example.invalid",
            "now": now,
        },
    )
    await session.execute(
        text(
            """
            INSERT INTO book (id, tenant_id, title, language, status, status_changed_at,
                               pipeline_version, created_by_user_id, created_at, updated_at)
            VALUES (:id, :tenant_id, 'Fixture Book', 'en', 'STRUCTURED', :now,
                    'test-pipeline', :user_id, :now, :now)
            """
        ),
        {"id": fx.book_id, "tenant_id": fx.tenant_id, "user_id": fx.user_id, "now": now},
    )
    await session.execute(
        text(
            """
            INSERT INTO book_file (id, tenant_id, book_id, source_kind, original_file_name,
                                    mime_type, size_bytes, content_hash, content_hash_algorithm,
                                    status, storage_key, storage_bucket, created_at, updated_at)
            VALUES (:id, :tenant_id, :book_id, 'PDF', 'book.pdf', 'application/pdf', 1024,
                    :hash, 'SHA256', 'ADMITTED', :key, 'test-bucket', :now, :now)
            """
        ),
        {
            "id": fx.book_file_id,
            "tenant_id": fx.tenant_id,
            "book_id": fx.book_id,
            "hash": fx.book_id.replace("-", "").ljust(64, "0"),
            "key": f"tenant/{fx.tenant_id}/book.pdf",
            "now": now,
        },
    )
    await session.execute(
        text(
            """
            INSERT INTO book_version (id, tenant_id, book_id, book_file_id, version,
                                       structure_version_label, is_current, content_hash,
                                       raw_text_content_hash, pipeline_version, storage_bucket,
                                       status, created_at, updated_at)
            VALUES (:id, :tenant_id, :book_id, :book_file_id, 1, 'structure.v1', true,
                    :hash, :raw_hash, 'test-pipeline', 'test-bucket', 'READY', :now, :now)
            """
        ),
        {
            "id": fx.book_version_id,
            "tenant_id": fx.tenant_id,
            "book_id": fx.book_id,
            "book_file_id": fx.book_file_id,
            "hash": ("b" + fx.book_id.replace("-", "")).ljust(64, "0")[:64],
            "raw_hash": ("c" + fx.book_id.replace("-", "")).ljust(64, "0")[:64],
            "now": now,
        },
    )
    await session.execute(
        text("UPDATE book SET current_book_version_id = :bv WHERE id = :id"),
        {"bv": fx.book_version_id, "id": fx.book_id},
    )

    chapter_texts = [
        [
            "Alice Carter walked into the kitchen and looked around the empty house.",
            '"Where is everyone?" said Alice. Bob Harrison was her brother, and '
            "they rarely fought.",
        ],
        [
            "* * *",
            "Bob Harrison sat by the window in the library, thinking about the letter.",
        ],
    ]
    for chapter_index, chapter_id in enumerate(fx.chapter_ids):
        await session.execute(
            text(
                """
                INSERT INTO chapter (id, tenant_id, book_id, book_version_id, order_index,
                                      spine_start, spine_end, matter_type, char_count,
                                      created_at, updated_at)
                VALUES (:id, :tenant_id, :book_id, :book_version_id, :order_index,
                        :spine_start, :spine_end, 'BODY', 100, :now, :now)
                """
            ),
            {
                "id": chapter_id,
                "tenant_id": fx.tenant_id,
                "book_id": fx.book_id,
                "book_version_id": fx.book_version_id,
                "order_index": chapter_index,
                "spine_start": chapter_index * 10,
                "spine_end": chapter_index * 10 + 9,
                "now": now,
            },
        )
        for paragraph_index, paragraph_id in enumerate(fx.paragraph_ids[chapter_index]):
            spine_position = chapter_index * 10 + paragraph_index
            await session.execute(
                text(
                    """
                    INSERT INTO paragraph (id, tenant_id, book_id, book_version_id, chapter_id,
                                            order_index, spine_position, text, content_hash,
                                            char_count, raw_text_content_hash, extraction_method,
                                            created_at, updated_at)
                    VALUES (:id, :tenant_id, :book_id, :book_version_id, :chapter_id,
                            :order_index, :spine_position, :text, :content_hash,
                            :char_count, :content_hash, 'DIGITAL_TEXT', :now, :now)
                    """
                ),
                {
                    "id": paragraph_id,
                    "tenant_id": fx.tenant_id,
                    "book_id": fx.book_id,
                    "book_version_id": fx.book_version_id,
                    "chapter_id": chapter_id,
                    "order_index": paragraph_index,
                    "spine_position": spine_position,
                    "text": chapter_texts[chapter_index][paragraph_index],
                    "content_hash": paragraph_id.replace("-", "").ljust(64, "0"),
                    "char_count": len(chapter_texts[chapter_index][paragraph_index]),
                    "now": now,
                },
            )


async def _seed_root_job(session: AsyncSession, fx: Fixture) -> None:
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO processing_job (id, tenant_id, book_id, type, queue, priority,
                                         related_resource_type, related_resource_id, status,
                                         status_changed_at, max_attempts, idempotency_key,
                                         idempotency_fingerprint, correlation_id, created_at,
                                         updated_at)
            VALUES (:id, :tenant_id, :book_id, 'analyze_scene', 'ai', 'NORMAL',
                    'book_version', :book_version_id, 'CREATED', :now, 3, :idem_key,
                    :idem_fp, :correlation_id, :now, :now)
            """
        ),
        {
            "id": fx.job_id,
            "tenant_id": fx.tenant_id,
            "book_id": fx.book_id,
            "book_version_id": fx.book_version_id,
            "idem_key": f"analyze_scene:{fx.job_id}",
            "idem_fp": "d" * 64,
            "correlation_id": fx.correlation_id,
            "now": now,
        },
    )


async def _cleanup(session: AsyncSession, fx: Fixture) -> None:
    for statement in (
        (
            "DELETE FROM scene_participant WHERE character_id IN "
            "(SELECT id FROM character WHERE tenant_id = :t)"
        ),
        "DELETE FROM narrative_state WHERE tenant_id = :t",
        "DELETE FROM narrative_location WHERE tenant_id = :t",
        "DELETE FROM scene_semantics WHERE tenant_id = :t",
        "DELETE FROM character_relationship WHERE tenant_id = :t",
        "DELETE FROM character_alias WHERE tenant_id = :t",
        "DELETE FROM character WHERE tenant_id = :t",
        "DELETE FROM story_bible_version WHERE tenant_id = :t",
        "DELETE FROM story_bible WHERE tenant_id = :t",
        "DELETE FROM scene WHERE tenant_id = :t",
        "DELETE FROM outbox_message WHERE tenant_id = :t",
        "DELETE FROM processing_job WHERE tenant_id = :t",
        "DELETE FROM paragraph WHERE tenant_id = :t",
        "DELETE FROM chapter WHERE tenant_id = :t",
        "DELETE FROM book_version WHERE tenant_id = :t",
        "DELETE FROM book_file WHERE tenant_id = :t",
        "DELETE FROM book WHERE tenant_id = :t",
        'DELETE FROM "user" WHERE tenant_id = :t',
        "DELETE FROM tenant WHERE id = :t",
    ):
        await session.execute(text(statement), {"t": fx.tenant_id})


@pytest.mark.asyncio
async def test_full_two_chapter_analysis_chain_against_real_postgres(real_db: Database) -> None:
    fx = Fixture()
    async with real_db.session() as session:
        await _seed_model_registry(session)
        await _seed_fixture_book(session, fx)
        await _seed_root_job(session, fx)

    try:
        queue = FakeQueueProducer()
        analyzer = DeterministicSemanticAnalyzer()

        # ---- Chapter 1: analyze_scene ----
        ctx1 = JobContext(
            envelope=SimpleJobEnvelope(
                job_id=uuid.UUID(fx.job_id),
                entity_id=uuid.UUID(fx.job_id),
                correlation_id=uuid.UUID(fx.correlation_id),
                causation_id=uuid.UUID(fx.correlation_id),
                tenant_id=uuid.UUID(fx.tenant_id),
                payload={
                    "book_id": fx.book_id,
                    "book_version_id": fx.book_version_id,
                    "chapter_id": fx.chapter_ids[0],
                    "spine_start": 0,
                    "spine_end": 9,
                    "story_bible_version_id": None,
                    "analysis_mode": "INCREMENTAL",
                    "remaining_chapter_ids": [fx.chapter_ids[1]],
                    "root_job_id": fx.job_id,
                    "chapters_total": 2,
                },
            ),
            message_type="analyze_scene",
            db=real_db,
            storage=None,  # type: ignore[arg-type]
            settings=_build_settings(),
            attempt=1,
            max_attempts=3,
        )
        await handle_analyze_scene(ctx1, analyzer=analyzer, queue_producer=queue)

        assert len(queue.enqueued) == 1
        assert queue.enqueued[0]["job_name"] == "build_story_bible_delta"
        delta1_job_id = queue.enqueued[0]["job_id"]
        delta1_payload = queue.enqueued[0]["payload"]

        async with real_db.session() as session:
            job_row = (
                await session.execute(
                    text("SELECT status, result_resource_id FROM processing_job WHERE id = :id"),
                    {"id": fx.job_id},
                )
            ).first()
            assert job_row is not None
            assert job_row[0] == "SUCCEEDED"
            story_bible_version_id = str(job_row[1])

            characters = (
                await session.execute(
                    text(
                        "SELECT display_name, status, is_sentinel FROM character WHERE book_id = :b"
                    ),
                    {"b": fx.book_id},
                )
            ).all()
            names = {row[0] for row in characters}
            assert "Alice Carter" in names

            # Characters *discovered* from the text are claims, and must never be
            # auto-confirmed -- that is what this assertion is protecting.
            discovered = [row for row in characters if not row[2]]
            assert discovered, "analysis found no non-sentinel characters"
            assert all(row[1] == "PROVISIONAL" for row in discovered)

            # Sentinels (NARRATOR/UNKNOWN) are a different class: infrastructure
            # rows, deliberately CONFIRMED, created during analysis so the
            # narrator is castable before the Director runs (QA finding F-22).
            # This assertion used to read "all characters are PROVISIONAL",
            # which predated sentinels being created here at all.
            sentinels = [row for row in characters if row[2]]
            assert sentinels, "analysis must create the sentinel characters (F-22)"
            assert all(row[1] == "CONFIRMED" for row in sentinels)

            scene_count = (
                await session.execute(
                    text("SELECT COUNT(*) FROM scene WHERE chapter_id = :c"),
                    {"c": fx.chapter_ids[0]},
                )
            ).scalar_one()
            assert scene_count >= 1

            narrative_state_count = (
                await session.execute(
                    text("SELECT COUNT(*) FROM narrative_state WHERE chapter_id = :c"),
                    {"c": fx.chapter_ids[0]},
                )
            ).scalar_one()
            assert narrative_state_count == 1

            child_job = (
                await session.execute(
                    text("SELECT id, type, parent_job_id FROM processing_job WHERE id = :id"),
                    {"id": delta1_job_id},
                )
            ).first()
            assert child_job is not None
            assert child_job[1] == "build_story_bible_delta"
            assert str(child_job[2]) == fx.job_id

        # ---- Chapter 1: build_story_bible_delta ----
        ctx_delta1 = JobContext(
            envelope=SimpleJobEnvelope(
                job_id=uuid.UUID(delta1_job_id),
                entity_id=uuid.UUID(delta1_job_id),
                correlation_id=uuid.UUID(fx.correlation_id),
                causation_id=uuid.UUID(fx.correlation_id),
                tenant_id=uuid.UUID(fx.tenant_id),
                payload=delta1_payload,
            ),
            message_type="build_story_bible_delta",
            db=real_db,
            storage=None,  # type: ignore[arg-type]
            settings=_build_settings(),
            attempt=1,
            max_attempts=3,
        )
        await handle_build_story_bible_delta(ctx_delta1, queue_producer=queue)

        assert len(queue.enqueued) == 2
        assert queue.enqueued[1]["job_name"] == "analyze_scene"
        assert queue.enqueued[1]["payload"]["chapter_id"] == fx.chapter_ids[1]
        analyze2_job_id = queue.enqueued[1]["job_id"]
        analyze2_payload = queue.enqueued[1]["payload"]

        async with real_db.session() as session:
            relationships = (
                await session.execute(
                    text(
                        "SELECT relationship_type FROM character_relationship "
                        "WHERE story_bible_version_id = :v"
                    ),
                    {"v": story_bible_version_id},
                )
            ).all()
            assert any(r[0] == "FAMILY" for r in relationships)

            sb_row = (
                await session.execute(
                    text("SELECT status, chapters_analyzed FROM story_bible WHERE book_id = :b"),
                    {"b": fx.book_id},
                )
            ).first()
            assert sb_row is not None
            assert sb_row[0] == "BUILDING"
            assert sb_row[1] == 1

        # ---- Chapter 2: analyze_scene ----
        ctx2 = JobContext(
            envelope=SimpleJobEnvelope(
                job_id=uuid.UUID(analyze2_job_id),
                entity_id=uuid.UUID(analyze2_job_id),
                correlation_id=uuid.UUID(fx.correlation_id),
                causation_id=uuid.UUID(fx.correlation_id),
                tenant_id=uuid.UUID(fx.tenant_id),
                payload=analyze2_payload,
            ),
            message_type="analyze_scene",
            db=real_db,
            storage=None,  # type: ignore[arg-type]
            settings=_build_settings(),
            attempt=1,
            max_attempts=3,
        )
        await handle_analyze_scene(ctx2, analyzer=analyzer, queue_producer=queue)
        assert len(queue.enqueued) == 3
        delta2_job_id = queue.enqueued[2]["job_id"]
        delta2_payload = queue.enqueued[2]["payload"]

        # A chapter-1 character (Bob Harrison) must still be resolvable by chapter 2
        # without re-sending chapter 1's raw text -- the long-form-context property.
        async with real_db.session() as session:
            bob_rows = (
                await session.execute(
                    text(
                        "SELECT COUNT(*) FROM character WHERE book_id = :b "
                        "AND display_name = 'Bob Harrison'"
                    ),
                    {"b": fx.book_id},
                )
            ).scalar_one()
            assert bob_rows == 1  # not duplicated across chapters

        # ---- Chapter 2: build_story_bible_delta (last chapter -> finalizes) ----
        ctx_delta2 = JobContext(
            envelope=SimpleJobEnvelope(
                job_id=uuid.UUID(delta2_job_id),
                entity_id=uuid.UUID(delta2_job_id),
                correlation_id=uuid.UUID(fx.correlation_id),
                causation_id=uuid.UUID(fx.correlation_id),
                tenant_id=uuid.UUID(fx.tenant_id),
                payload=delta2_payload,
            ),
            message_type="build_story_bible_delta",
            db=real_db,
            storage=None,  # type: ignore[arg-type]
            settings=_build_settings(),
            attempt=1,
            max_attempts=3,
        )
        await handle_build_story_bible_delta(ctx_delta2, queue_producer=queue)

        # No further job should be enqueued -- this was the last chapter.
        assert len(queue.enqueued) == 3

        async with real_db.session() as session:
            sb_row = (
                await session.execute(
                    text(
                        "SELECT status, chapters_analyzed, current_version_id "
                        "FROM story_bible WHERE book_id = :b"
                    ),
                    {"b": fx.book_id},
                )
            ).first()
            assert sb_row is not None
            assert sb_row[0] == "READY"
            assert sb_row[1] == 2
            assert sb_row[2] is not None

            book_status = (
                await session.execute(
                    text("SELECT status FROM book WHERE id = :b"), {"b": fx.book_id}
                )
            ).scalar_one()
            assert book_status == "ANALYZED"

            root_job_status = (
                await session.execute(
                    text("SELECT status FROM processing_job WHERE id = :id"), {"id": fx.job_id}
                )
            ).scalar_one()
            assert root_job_status == "SUCCEEDED"

            completed_event = (
                await session.execute(
                    text(
                        "SELECT event_type FROM outbox_message WHERE book_id = :b "
                        "AND event_type = 'book.analysis_completed'"
                    ),
                    {"b": fx.book_id},
                )
            ).first()
            assert completed_event is not None

            discovered_events = (
                await session.execute(
                    text(
                        "SELECT COUNT(*) FROM outbox_message WHERE book_id = :b "
                        "AND event_type = 'character.discovered'"
                    ),
                    {"b": fx.book_id},
                )
            ).scalar_one()
            assert discovered_events >= 1
    finally:
        async with real_db.session() as session:
            await _cleanup(session, fx)
