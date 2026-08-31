"""`StoryBible`/`StoryBibleVersion` lifecycle: created once per analysis run (or once
per `REBUILD`), updated incrementally as each chapter's `build_story_bible_delta`
completes, and finalized (`status = READY`, `book.analysis_completed` emitted) after
the last chapter in scope. See `prisma/schema.prisma` §11.2-§11.3 -- `StoryBibleVersion`
is immutable except its coverage counters; a `REBUILD` always gets a new version row,
never mutates an old one.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from workers_common.events import new_id


@dataclass(frozen=True, slots=True)
class StoryBibleVersionRow:
    id: str
    book_id: str
    version: int
    built_by_model_version_id: str


async def get_next_version_number(session: AsyncSession, book_id: str) -> int:
    row = (
        await session.execute(
            text("SELECT MAX(version) FROM story_bible_version WHERE book_id = :book_id"),
            {"book_id": book_id},
        )
    ).first()
    current_max = row[0] if row and row[0] is not None else 0
    return int(current_max) + 1


async def create_story_bible_version(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    book_version_id: str,
    version: int,
    build_mode: str,
    built_by_model_version_id: str,
    source_content_hash: str,
    facts_content_hash: str,
    job_id: str,
    chapters_total: int,
) -> str:
    version_id = str(new_id())
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO story_bible_version (
                id, tenant_id, book_id, book_version_id, version, is_current,
                build_mode, built_by_model_version_id, source_content_hash,
                facts_content_hash, job_id, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :book_id, :book_version_id, :version, false,
                :build_mode, :model_version_id, :source_hash, :facts_hash, :job_id, :now, :now
            )
            """
        ),
        {
            "id": version_id,
            "tenant_id": tenant_id,
            "book_id": book_id,
            "book_version_id": book_version_id,
            "version": version,
            "build_mode": build_mode,
            "model_version_id": built_by_model_version_id,
            "source_hash": source_content_hash,
            "facts_hash": facts_content_hash,
            "job_id": job_id,
            "now": now,
        },
    )

    await session.execute(
        text(
            """
            INSERT INTO story_bible (
                book_id, tenant_id, status, chapters_total, created_at, updated_at
            )
            VALUES (:book_id, :tenant_id, 'BUILDING', :chapters_total, :now, :now)
            ON CONFLICT (book_id) DO UPDATE
                SET status = 'BUILDING', chapters_total = :chapters_total, updated_at = :now
            """
        ),
        {
            "book_id": book_id,
            "tenant_id": tenant_id,
            "chapters_total": chapters_total,
            "now": now,
        },
    )
    return version_id


async def get_story_bible_version(
    session: AsyncSession, version_id: str
) -> StoryBibleVersionRow | None:
    row = (
        await session.execute(
            text(
                "SELECT id, book_id, version, built_by_model_version_id "
                "FROM story_bible_version WHERE id = :id"
            ),
            {"id": version_id},
        )
    ).first()
    if row is None:
        return None
    return StoryBibleVersionRow(
        id=str(row[0]), book_id=str(row[1]), version=row[2], built_by_model_version_id=str(row[3])
    )


async def record_chapter_progress(
    session: AsyncSession,
    *,
    book_id: str,
    tenant_id: str,
    story_bible_version_id: str,
    chapters_analyzed_delta: int,
    spine_position_analyzed: int,
    chapters_covered_delta: int,
    spine_position_covered: int,
) -> None:
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            UPDATE story_bible
            SET chapters_analyzed = chapters_analyzed + :chapters_delta,
                spine_position_analyzed = :spine_position, updated_at = :now
            WHERE book_id = :book_id AND tenant_id = :tenant_id
            """
        ),
        {
            "book_id": book_id,
            "tenant_id": tenant_id,
            "chapters_delta": chapters_analyzed_delta,
            "spine_position": spine_position_analyzed,
            "now": now,
        },
    )
    await session.execute(
        text(
            """
            UPDATE story_bible_version
            SET chapters_covered = chapters_covered + :chapters_delta,
                spine_position_covered = :spine_position, updated_at = :now
            WHERE id = :id
            """
        ),
        {
            "id": story_bible_version_id,
            "chapters_delta": chapters_covered_delta,
            "spine_position": spine_position_covered,
            "now": now,
        },
    )


async def finalize_story_bible(
    session: AsyncSession, *, book_id: str, tenant_id: str, story_bible_version_id: str
) -> None:
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            UPDATE story_bible_version SET is_current = true, updated_at = :now WHERE id = :id
            """
        ),
        {"id": story_bible_version_id, "now": now},
    )
    await session.execute(
        text(
            """
            UPDATE story_bible_version SET is_current = false, superseded_at = :now
            WHERE book_id = :book_id AND id != :id AND is_current = true
            """
        ),
        {"book_id": book_id, "id": story_bible_version_id, "now": now},
    )
    await session.execute(
        text(
            """
            UPDATE story_bible
            SET status = 'READY', current_version_id = :version_id,
                current_version_number = (
                    SELECT version FROM story_bible_version WHERE id = :version_id
                ),
                last_updated_at = :now, updated_at = :now
            WHERE book_id = :book_id AND tenant_id = :tenant_id
            """
        ),
        {
            "book_id": book_id,
            "tenant_id": tenant_id,
            "version_id": story_bible_version_id,
            "now": now,
        },
    )
