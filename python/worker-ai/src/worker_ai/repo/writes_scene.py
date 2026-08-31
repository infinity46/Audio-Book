"""Writes made by the `analyze_scene` handler: job status, new provisional characters
and their aliases, scene boundaries + semantics + participants, and one
`NarrativeState` checkpoint per chapter.

Raw parameterized SQL (see `reads.py`'s module docstring for why). Every array-typed
column is bound with an explicit Postgres cast (`::uuid[]`, `::text[]`) -- asyncpg
needs the parameter's target type resolvable at prepare time to encode a Python list
correctly.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from workers_common.events import new_id


async def mark_job_running(session: AsyncSession, job_id: str) -> None:
    await session.execute(
        text(
            """
            UPDATE processing_job
            SET status = 'RUNNING', status_changed_at = :now,
                started_at = COALESCE(started_at, :now),
                attempt_count = attempt_count + 1, updated_at = :now
            WHERE id = :id
            """
        ),
        {"id": job_id, "now": datetime.now(UTC)},
    )


async def mark_job_succeeded(
    session: AsyncSession, job_id: str, *, result_resource_type: str, result_resource_id: str
) -> None:
    await session.execute(
        text(
            """
            UPDATE processing_job
            SET status = 'SUCCEEDED', status_changed_at = :now, completed_at = :now,
                progress = 1, result_resource_type = :result_type,
                result_resource_id = :result_id, updated_at = :now
            WHERE id = :id
            """
        ),
        {
            "id": job_id,
            "now": datetime.now(UTC),
            "result_type": result_resource_type,
            "result_id": result_resource_id,
        },
    )


async def mark_job_failed(
    session: AsyncSession, job_id: str, *, error_code: str, error_message: str, retryable: bool
) -> None:
    await session.execute(
        text(
            """
            UPDATE processing_job
            SET status = 'FAILED', status_changed_at = :now, completed_at = :now,
                error_code = :error_code, error_class = 'SemanticAnalysisError',
                error_message = :error_message, error_retryable = :retryable,
                error_terminal = :terminal, updated_at = :now
            WHERE id = :id
            """
        ),
        {
            "id": job_id,
            "now": datetime.now(UTC),
            "error_code": error_code,
            "error_message": error_message,
            "retryable": retryable,
            "terminal": not retryable,
        },
    )


async def create_child_job(
    session: AsyncSession,
    *,
    job_id: str,
    tenant_id: str,
    book_id: str,
    job_type: str,
    parent_job_id: str,
    related_resource_id: str,
    scope: dict[str, Any],
    idempotency_key: str,
    idempotency_fingerprint: str,
    correlation_id: str,
    priority: str = "NORMAL",
) -> None:
    """Inserts the next `processing_job` in the chain -- `parent_job_id`/
    `child_job_count` bookkeeping is what `GET .../analysis` aggregates over
    (`prisma/schema.prisma`'s `ProcessingJob.parentJobId`/`childJobCount`,
    already in the schema, unused by Phase 1/2)."""
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO processing_job (
                id, tenant_id, book_id, type, queue, priority,
                related_resource_type, related_resource_id, scope,
                parent_job_id, status, status_changed_at,
                max_attempts, idempotency_key, idempotency_fingerprint, correlation_id,
                created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :book_id, :type, 'ai', :priority,
                'book_version', :related_resource_id, CAST(:scope AS JSONB),
                :parent_job_id, 'CREATED', :now,
                3, :idempotency_key, :idempotency_fingerprint, :correlation_id,
                :now, :now
            )
            """
        ),
        {
            "id": job_id,
            "tenant_id": tenant_id,
            "book_id": book_id,
            "type": job_type,
            "priority": priority,
            "related_resource_id": related_resource_id,
            "scope": _json(scope),
            "parent_job_id": parent_job_id,
            "idempotency_key": idempotency_key,
            "idempotency_fingerprint": idempotency_fingerprint,
            "correlation_id": correlation_id,
            "now": now,
        },
    )
    await session.execute(
        text(
            "UPDATE processing_job SET child_job_count = child_job_count + 1, "
            "updated_at = :now WHERE id = :parent_id"
        ),
        {"parent_id": parent_job_id, "now": now},
    )


async def create_character(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    display_name: str,
    speaking: bool,
    model_version_id: str,
    confidence: float,
    evidence_paragraph_ids: list[str],
    first_appearance_chapter_id: str,
    first_appearance_paragraph_id: str,
) -> str:
    character_id = str(new_id())
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO character (
                id, tenant_id, book_id, display_name, status, speaking,
                detection_source, detected_by_model_version_id, detection_confidence,
                evidence_paragraph_ids, first_appearance_chapter_id,
                first_appearance_paragraph_id, last_appearance_chapter_id,
                last_appearance_paragraph_id, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :book_id, :display_name, 'PROVISIONAL', :speaking,
                'NARRATIVE_UNDERSTANDING', :model_version_id, :confidence,
                CAST(:evidence AS uuid[]), :first_chapter_id, :first_paragraph_id,
                :first_chapter_id, :first_paragraph_id, :now, :now
            )
            """
        ),
        {
            "id": character_id,
            "tenant_id": tenant_id,
            "book_id": book_id,
            "display_name": display_name,
            "speaking": speaking,
            "model_version_id": model_version_id,
            "confidence": confidence,
            "evidence": evidence_paragraph_ids[:50],
            "first_chapter_id": first_appearance_chapter_id,
            "first_paragraph_id": first_appearance_paragraph_id,
            "now": now,
        },
    )
    return character_id


async def update_character_last_appearance(
    session: AsyncSession, character_id: str, *, chapter_id: str, paragraph_id: str
) -> None:
    await session.execute(
        text(
            """
            UPDATE character
            SET last_appearance_chapter_id = :chapter_id,
                last_appearance_paragraph_id = :paragraph_id,
                line_count = line_count + 1, updated_at = :now
            WHERE id = :id
            """
        ),
        {
            "id": character_id,
            "chapter_id": chapter_id,
            "paragraph_id": paragraph_id,
            "now": datetime.now(UTC),
        },
    )


async def create_alias(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    character_id: str,
    surface_form: str,
    alias_type: str,
    model_version_id: str,
    confidence: float,
) -> str:
    alias_id = str(new_id())
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO character_alias (
                id, tenant_id, book_id, character_id, surface_form, surface_form_normalized,
                alias_type, scope_kind, source, detected_by_model_version_id, confidence,
                created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :book_id, :character_id, :surface_form, :normalized,
                :alias_type, 'GLOBAL', 'EXTRACTED', :model_version_id, :confidence, :now, :now
            )
            """
        ),
        {
            "id": alias_id,
            "tenant_id": tenant_id,
            "book_id": book_id,
            "character_id": character_id,
            "surface_form": surface_form,
            "normalized": surface_form.strip().lower(),
            "alias_type": alias_type,
            "model_version_id": model_version_id,
            "confidence": confidence,
            "now": now,
        },
    )
    return alias_id


async def create_scene(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    book_version_id: str,
    chapter_id: str,
    order_index: int,
    start_paragraph_id: str,
    end_paragraph_id: str,
    paragraph_count: int,
    spine_start: int,
    spine_end: int,
) -> str:
    scene_id = str(new_id())
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO scene (
                id, tenant_id, book_id, book_version_id, chapter_id, order_index,
                start_paragraph_id, end_paragraph_id, paragraph_count,
                spine_start, spine_end, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :book_id, :book_version_id, :chapter_id, :order_index,
                :start_paragraph_id, :end_paragraph_id, :paragraph_count,
                :spine_start, :spine_end, :now, :now
            )
            """
        ),
        {
            "id": scene_id,
            "tenant_id": tenant_id,
            "book_id": book_id,
            "book_version_id": book_version_id,
            "chapter_id": chapter_id,
            "order_index": order_index,
            "start_paragraph_id": start_paragraph_id,
            "end_paragraph_id": end_paragraph_id,
            "paragraph_count": paragraph_count,
            "spine_start": spine_start,
            "spine_end": spine_end,
            "now": now,
        },
    )
    return scene_id


async def create_scene_semantics(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    scene_id: str,
    story_bible_version_id: str,
    summary: str | None,
    in_story_time: str | None,
    mood: str | None,
    tension: float | None,
    pov_character_id: str | None,
    narrative_state_id: str | None,
    model_version_id: str,
    confidence: float,
) -> str:
    semantics_id = str(new_id())
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO scene_semantics (
                id, tenant_id, book_id, scene_id, story_bible_version_id, summary,
                in_story_time, mood, tension, pov_character_id, narrative_state_id,
                extracted_by_model_version_id, confidence, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :book_id, :scene_id, :story_bible_version_id, :summary,
                :in_story_time, :mood, :tension, :pov_character_id, :narrative_state_id,
                :model_version_id, :confidence, :now, :now
            )
            """
        ),
        {
            "id": semantics_id,
            "tenant_id": tenant_id,
            "book_id": book_id,
            "scene_id": scene_id,
            "story_bible_version_id": story_bible_version_id,
            "summary": summary,
            "in_story_time": in_story_time,
            "mood": mood,
            "tension": tension,
            "pov_character_id": pov_character_id,
            "narrative_state_id": narrative_state_id,
            "model_version_id": model_version_id,
            "confidence": confidence,
            "now": now,
        },
    )
    return semantics_id


async def create_scene_participant(
    session: AsyncSession, *, scene_semantics_id: str, character_id: str, speaking: bool
) -> None:
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO scene_participant (
                scene_semantics_id, character_id, speaking_line_count, created_at, updated_at
            ) VALUES (:scene_semantics_id, :character_id, :speaking_count, :now, :now)
            ON CONFLICT (scene_semantics_id, character_id) DO NOTHING
            """
        ),
        {
            "scene_semantics_id": scene_semantics_id,
            "character_id": character_id,
            "speaking_count": 1 if speaking else 0,
            "now": now,
        },
    )


async def create_narrative_state(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    book_version_id: str,
    story_bible_version_id: str,
    chapter_id: str,
    scene_id: str | None,
    spine_position: int,
    checkpoint_kind: str,
    pov_character_id: str | None,
    pov_type: str | None,
    present_character_ids: list[str],
    unresolved_thread_ids: list[str],
    model_version_id: str,
) -> str:
    state_id = str(new_id())
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO narrative_state (
                id, tenant_id, book_id, book_version_id, story_bible_version_id,
                chapter_id, scene_id, spine_position, checkpoint_kind,
                pov_character_id, pov_type, present_character_ids, unresolved_thread_ids,
                extracted_by_model_version_id, created_at
            ) VALUES (
                :id, :tenant_id, :book_id, :book_version_id, :story_bible_version_id,
                :chapter_id, :scene_id, :spine_position, :checkpoint_kind,
                :pov_character_id, :pov_type, CAST(:present AS uuid[]), CAST(:threads AS uuid[]),
                :model_version_id, :now
            )
            """
        ),
        {
            "id": state_id,
            "tenant_id": tenant_id,
            "book_id": book_id,
            "book_version_id": book_version_id,
            "story_bible_version_id": story_bible_version_id,
            "chapter_id": chapter_id,
            "scene_id": scene_id,
            "spine_position": spine_position,
            "checkpoint_kind": checkpoint_kind,
            "pov_character_id": pov_character_id,
            "pov_type": pov_type,
            "present": present_character_ids,
            "threads": unresolved_thread_ids,
            "model_version_id": model_version_id,
            "now": now,
        },
    )
    return state_id


def _json(value: dict[str, Any]) -> str:
    import json

    return json.dumps(value)
