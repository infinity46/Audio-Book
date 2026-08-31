"""Read-only queries backing the `analyze_scene`/`build_story_bible_delta` handlers.

Raw parameterized SQL via `sqlalchemy.text()` -- `workers_common/db.py` deliberately
ships no ORM models (the schema is owned by Prisma/`database-schema.md`, migrations are
a Node-side concern). Column names below are copied verbatim from `prisma/schema.prisma`.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from worker_ai.semantic.schemas import KnownCharacter, ParagraphInput, PriorNarrativeStateSummary


@dataclass(frozen=True, slots=True)
class JobRow:
    id: str
    tenant_id: str
    book_id: str
    status: str
    scope: dict[str, object] | None
    correlation_id: str
    parent_job_id: str | None


@dataclass(frozen=True, slots=True)
class ChapterRow:
    id: str
    tenant_id: str
    book_id: str
    book_version_id: str
    order_index: int
    spine_start: int
    spine_end: int
    title: str | None


@dataclass(frozen=True, slots=True)
class BookVersionRow:
    id: str
    book_id: str
    content_hash: str


async def load_job(session: AsyncSession, job_id: str) -> JobRow | None:
    row = (
        await session.execute(
            text(
                """
                SELECT id, tenant_id, book_id, status, scope, correlation_id, parent_job_id
                FROM processing_job WHERE id = :id
                """
            ),
            {"id": job_id},
        )
    ).first()
    if row is None:
        return None
    return JobRow(
        id=str(row[0]),
        tenant_id=str(row[1]),
        book_id=str(row[2]),
        status=row[3],
        scope=row[4],
        correlation_id=str(row[5]),
        parent_job_id=str(row[6]) if row[6] else None,
    )


async def load_chapter(session: AsyncSession, chapter_id: str) -> ChapterRow | None:
    row = (
        await session.execute(
            text(
                """
                SELECT id, tenant_id, book_id, book_version_id, order_index,
                       spine_start, spine_end, title
                FROM chapter WHERE id = :id
                """
            ),
            {"id": chapter_id},
        )
    ).first()
    if row is None:
        return None
    return ChapterRow(
        id=str(row[0]),
        tenant_id=str(row[1]),
        book_id=str(row[2]),
        book_version_id=str(row[3]),
        order_index=row[4],
        spine_start=row[5],
        spine_end=row[6],
        title=row[7],
    )


async def load_book_version(session: AsyncSession, book_version_id: str) -> BookVersionRow | None:
    row = (
        await session.execute(
            text("SELECT id, book_id, content_hash FROM book_version WHERE id = :id"),
            {"id": book_version_id},
        )
    ).first()
    if row is None:
        return None
    return BookVersionRow(id=str(row[0]), book_id=str(row[1]), content_hash=row[2])


async def load_paragraphs(session: AsyncSession, chapter_id: str) -> list[ParagraphInput]:
    rows = (
        await session.execute(
            text(
                """
                SELECT id, order_index, spine_position, text
                FROM paragraph WHERE chapter_id = :chapter_id ORDER BY order_index ASC
                """
            ),
            {"chapter_id": chapter_id},
        )
    ).all()
    return [
        ParagraphInput(id=str(r[0]), order_index=r[1], spine_position=r[2], text=r[3])
        for r in rows
    ]


async def load_known_characters(
    session: AsyncSession, book_id: str, limit: int = 500
) -> list[KnownCharacter]:
    """Every non-retired Character for the book so far, with its aliases -- the "existing
    registry" a new chapter's mentions are resolved against. Book-scoped, not
    book-version-scoped (OQ-DB-4): survives re-ingestion by construction, since this
    query is never filtered by book_version_id."""
    char_rows = (
        await session.execute(
            text(
                """
                SELECT id, display_name FROM character
                WHERE book_id = :book_id AND status != 'MERGED_INTO'
                ORDER BY line_count DESC LIMIT :limit
                """
            ),
            {"book_id": book_id, "limit": limit},
        )
    ).all()
    if not char_rows:
        return []

    ids = [str(r[0]) for r in char_rows]
    alias_rows = (
        await session.execute(
            text(
                "SELECT character_id, surface_form FROM character_alias "
                "WHERE character_id = ANY(:ids)"
            ),
            {"ids": ids},
        )
    ).all()
    aliases_by_character: dict[str, list[str]] = {}
    for character_id, surface_form in alias_rows:
        aliases_by_character.setdefault(str(character_id), []).append(surface_form)

    return [
        KnownCharacter(
            id=str(char_id),
            display_name=display_name,
            aliases=aliases_by_character.get(str(char_id), []),
        )
        for char_id, display_name in char_rows
    ]


async def load_latest_narrative_state(
    session: AsyncSession, book_id: str
) -> PriorNarrativeStateSummary | None:
    row = (
        await session.execute(
            text(
                """
                SELECT present_character_ids, pov_character_id, location_id,
                       unresolved_thread_ids
                FROM narrative_state WHERE book_id = :book_id
                ORDER BY spine_position DESC LIMIT 1
                """
            ),
            {"book_id": book_id},
        )
    ).first()
    if row is None:
        return None
    return PriorNarrativeStateSummary(
        present_character_ids=[str(x) for x in (row[0] or [])],
        pov_character_id=str(row[1]) if row[1] else None,
        location_name=None,  # resolving location_id -> name is a cheap follow-up query;
        # omitted for now since the deterministic analyzer does not yet consume it.
        unresolved_thread_summaries=[],
    )
