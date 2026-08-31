"""Fact-table writes for `build_story_bible_delta`: relationships, locations, objects,
factions, threads, timeline events -- everything that hangs off a `StoryBibleVersion`
(`prisma/schema.prisma` §11.6). Also the (schema-honest) contradiction-flagging rule:
see the module docstring in `handlers/build_story_bible_delta.py` for the reasoning.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from workers_common.events import new_id
from workers_common.logging import get_logger

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class ExistingRelationship:
    id: str
    relationship_type: str
    valid_from_spine: int | None


async def find_existing_relationships(
    session: AsyncSession, *, story_bible_version_id: str, source_id: str, target_id: str
) -> list[ExistingRelationship]:
    rows = (
        await session.execute(
            text(
                """
                SELECT id, relationship_type, valid_from_spine FROM character_relationship
                WHERE story_bible_version_id = :version_id
                  AND ((source_character_id = :a AND target_character_id = :b)
                    OR (source_character_id = :b AND target_character_id = :a))
                """
            ),
            {"version_id": story_bible_version_id, "a": source_id, "b": target_id},
        )
    ).all()
    return [
        ExistingRelationship(id=str(r[0]), relationship_type=r[1], valid_from_spine=r[2])
        for r in rows
    ]


async def create_relationship(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    story_bible_version_id: str,
    source_character_id: str,
    target_character_id: str,
    relationship_type: str,
    label: str | None,
    confidence: float,
    valid_from_spine: int,
    evidence_paragraph_ids: list[str],
    evidence_scene_id: str | None,
    model_version_id: str,
) -> str:
    rel_id = str(new_id())
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO character_relationship (
                id, tenant_id, book_id, story_bible_version_id, source_character_id,
                target_character_id, relationship_type, label, confidence,
                valid_from_spine, evidence_paragraph_ids, evidence_scene_id,
                extracted_by_model_version_id, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :book_id, :version_id, :source_id, :target_id, :rel_type,
                :label, :confidence, :valid_from_spine, CAST(:evidence AS uuid[]),
                :evidence_scene_id, :model_version_id, :now, :now
            )
            ON CONFLICT (story_bible_version_id, source_character_id, target_character_id,
                         relationship_type, valid_from_spine) DO NOTHING
            """
        ),
        {
            "id": rel_id,
            "tenant_id": tenant_id,
            "book_id": book_id,
            "version_id": story_bible_version_id,
            "source_id": source_character_id,
            "target_id": target_character_id,
            "rel_type": relationship_type,
            "label": label,
            "confidence": confidence,
            "valid_from_spine": valid_from_spine,
            "evidence": evidence_paragraph_ids,
            "evidence_scene_id": evidence_scene_id,
            "model_version_id": model_version_id,
            "now": now,
        },
    )
    return rel_id


async def extend_relationship_evidence(
    session: AsyncSession, relationship_id: str, evidence_paragraph_ids: list[str]
) -> None:
    """Cross-window dedup (task §154-156): the SAME (pair, type) claim recurring in a
    later chapter merges its evidence into the existing row rather than creating a
    duplicate -- all evidence is kept, none discarded."""
    await session.execute(
        text(
            """
            UPDATE character_relationship
            SET evidence_paragraph_ids = (
                SELECT ARRAY(
                    SELECT DISTINCT unnest(evidence_paragraph_ids || CAST(:new_evidence AS uuid[]))
                )
            ), updated_at = :now
            WHERE id = :id
            """
        ),
        {"id": relationship_id, "new_evidence": evidence_paragraph_ids, "now": datetime.now(UTC)},
    )


async def lower_relationship_confidence(
    session: AsyncSession, relationship_id: str, confidence: float
) -> None:
    await session.execute(
        text(
            """
            UPDATE character_relationship
            SET confidence = :confidence, updated_at = :now WHERE id = :id
            """
        ),
        {"id": relationship_id, "confidence": confidence, "now": datetime.now(UTC)},
    )


async def find_location_by_name(
    session: AsyncSession, *, story_bible_version_id: str, name: str
) -> str | None:
    row = (
        await session.execute(
            text(
                "SELECT id FROM narrative_location "
                "WHERE story_bible_version_id = :version_id AND lower(name) = lower(:name)"
            ),
            {"version_id": story_bible_version_id, "name": name},
        )
    ).first()
    return str(row[0]) if row else None


async def create_location(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    story_bible_version_id: str,
    name: str,
    location_kind: str | None,
    confidence: float,
    evidence_paragraph_ids: list[str],
    model_version_id: str,
) -> str:
    location_id = str(new_id())
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO narrative_location (
                id, tenant_id, book_id, story_bible_version_id, name, location_kind,
                evidence_paragraph_ids, extracted_by_model_version_id, confidence,
                created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :book_id, :version_id, :name, :location_kind,
                CAST(:evidence AS uuid[]), :model_version_id, :confidence, :now, :now
            )
            """
        ),
        {
            "id": location_id,
            "tenant_id": tenant_id,
            "book_id": book_id,
            "version_id": story_bible_version_id,
            "name": name,
            "location_kind": location_kind,
            "evidence": evidence_paragraph_ids,
            "model_version_id": model_version_id,
            "confidence": confidence,
            "now": now,
        },
    )
    return location_id


async def get_next_timeline_ordinal(session: AsyncSession, story_bible_version_id: str) -> int:
    row = (
        await session.execute(
            text(
                """
                SELECT MAX(ordinal) FROM narrative_timeline_event
                WHERE story_bible_version_id = :id
                """
            ),
            {"id": story_bible_version_id},
        )
    ).first()
    return int(row[0]) + 1 if row and row[0] is not None else 0


async def create_timeline_event(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    story_bible_version_id: str,
    title: str,
    summary: str | None,
    ordinal: int,
    span_kind: str,
    in_story_time_marker: str | None,
    confidence: float,
    evidence_paragraph_ids: list[str],
    model_version_id: str,
) -> str:
    event_id = str(new_id())
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO narrative_timeline_event (
                id, tenant_id, book_id, story_bible_version_id, title, summary, ordinal,
                span_kind, in_story_time_marker, evidence_paragraph_ids,
                extracted_by_model_version_id, confidence, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :book_id, :version_id, :title, :summary, :ordinal,
                :span_kind, :marker, CAST(:evidence AS uuid[]), :model_version_id,
                :confidence, :now, :now
            )
            """
        ),
        {
            "id": event_id,
            "tenant_id": tenant_id,
            "book_id": book_id,
            "version_id": story_bible_version_id,
            "title": title,
            "summary": summary,
            "ordinal": ordinal,
            "span_kind": span_kind,
            "marker": in_story_time_marker,
            "evidence": evidence_paragraph_ids,
            "model_version_id": model_version_id,
            "confidence": confidence,
            "now": now,
        },
    )
    return event_id
