"""Read-only queries backing the Director (`generate_director_ir`/
`revise_director_ir`). Raw parameterized SQL, same convention as `reads.py`
(no ORM -- see that module's docstring).

Every function here is called ONCE PER CHAPTER by `director/context.py`, not
once per chunk/paragraph -- the N+1 pattern task §211 warns against
(`for every segment: query character / query voice / query relationship`) is
avoided by construction: character registry, scene semantics, and the
pronunciation lexicon are each one query for the whole chapter, held in
memory while every paragraph in that chapter is chunked and resolved.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from worker_ai.director.speaker_resolver import KnownSpeaker, SentinelIds

_SENTINEL_DISPLAY_NAMES = {
    "NARRATOR": "Narrator",
    "UNKNOWN_SPEAKER": "Unknown Speaker",
    "MULTIPLE_SPEAKERS": "Multiple Speakers",
    "SYSTEM": "System",
}


@dataclass(frozen=True, slots=True)
class BookRow:
    id: str
    tenant_id: str
    title: str
    author: str | None
    language: str


@dataclass(frozen=True, slots=True)
class DirectorParagraphRow:
    id: str
    order_index: int
    spine_position: int
    chapter_id: str
    scene_id: str | None
    text: str


@dataclass(frozen=True, slots=True)
class SceneSemanticsRow:
    scene_id: str
    summary: str | None
    mood: str | None
    tension: float | None
    participant_character_ids: frozenset[str]


@dataclass(frozen=True, slots=True)
class PronunciationHintSource:
    surface_form: str
    surface_form_normalized: str
    lexicon_key: str | None
    ipa: str | None


@dataclass(frozen=True, slots=True)
class NarrativeStateSummary:
    present_character_ids: list[str]
    previous_speaker_character_id: str | None
    pov_character_id: str | None


async def load_book(session: AsyncSession, book_id: str) -> BookRow | None:
    row = (
        await session.execute(
            text("SELECT id, tenant_id, title, author, language FROM book WHERE id = :id"),
            {"id": book_id},
        )
    ).first()
    if row is None:
        return None
    return BookRow(
        id=str(row[0]), tenant_id=str(row[1]), title=row[2], author=row[3], language=row[4]
    )


async def load_paragraphs_for_chapter(
    session: AsyncSession, chapter_id: str
) -> list[DirectorParagraphRow]:
    rows = (
        await session.execute(
            text(
                """
                SELECT id, order_index, spine_position, chapter_id, scene_id, text
                FROM paragraph WHERE chapter_id = :chapter_id ORDER BY order_index ASC
                """
            ),
            {"chapter_id": chapter_id},
        )
    ).all()
    return [
        DirectorParagraphRow(
            id=str(r[0]), order_index=r[1], spine_position=r[2],
            chapter_id=str(r[3]), scene_id=str(r[4]) if r[4] else None, text=r[5],
        )
        for r in rows
    ]


async def load_scene_semantics_for_chapter(
    session: AsyncSession, chapter_id: str, story_bible_version_id: str
) -> dict[str, SceneSemanticsRow]:
    """One `scene_semantics` row per scene in this chapter, at the pinned
    `story_bible_version_id` -- never a floating "current" read, matching
    director-specification.md §32.1's determinism-inputs requirement."""
    rows = (
        await session.execute(
            text(
                """
                SELECT ss.scene_id, ss.summary, ss.mood, ss.tension
                FROM scene_semantics ss
                JOIN scene s ON s.id = ss.scene_id
                WHERE s.chapter_id = :chapter_id AND ss.story_bible_version_id = :sbv_id
                """
            ),
            {"chapter_id": chapter_id, "sbv_id": story_bible_version_id},
        )
    ).all()
    if not rows:
        return {}
    scene_ids = [str(r[0]) for r in rows]
    participant_rows = (
        await session.execute(
            text(
                """
                SELECT sp.character_id, ss.scene_id
                FROM scene_participant sp
                JOIN scene_semantics ss ON ss.id = sp.scene_semantics_id
                WHERE ss.scene_id = ANY(:scene_ids) AND ss.story_bible_version_id = :sbv_id
                """
            ),
            {"scene_ids": scene_ids, "sbv_id": story_bible_version_id},
        )
    ).all()
    participants_by_scene: dict[str, set[str]] = {}
    for character_id, scene_id in participant_rows:
        participants_by_scene.setdefault(str(scene_id), set()).add(str(character_id))

    return {
        str(r[0]): SceneSemanticsRow(
            scene_id=str(r[0]), summary=r[1], mood=r[2], tension=r[3],
            participant_character_ids=frozenset(participants_by_scene.get(str(r[0]), set())),
        )
        for r in rows
    }


async def load_speaker_registry(
    session: AsyncSession, book_id: str
) -> tuple[list[KnownSpeaker], SentinelIds]:
    """Every non-retired, non-sentinel Character (with aliases) plus the four
    reserved sentinel identities. Callers must have already ensured the
    sentinels exist (`writes_director.ensure_sentinel_characters`) --
    reading before that has run returns fewer sentinels than expected, which
    is a caller ordering bug, not something this query papers over."""
    char_rows = (
        await session.execute(
            text(
                """
                SELECT id, display_name, is_sentinel, sentinel_kind, speech_traits FROM character
                WHERE book_id = :book_id AND status != 'MERGED_INTO'
                """
            ),
            {"book_id": book_id},
        )
    ).all()

    sentinel_by_kind: dict[str, str] = {}
    speaker_rows = []
    for char_id, display_name, is_sentinel, sentinel_kind, speech_traits in char_rows:
        if is_sentinel:
            sentinel_by_kind[sentinel_kind] = str(char_id)
        else:
            speaker_rows.append((str(char_id), display_name, speech_traits))

    required_kinds = {"NARRATOR", "UNKNOWN_SPEAKER", "MULTIPLE_SPEAKERS", "SYSTEM"}
    missing = required_kinds - sentinel_by_kind.keys()
    if missing:
        raise ValueError(
            f"Book {book_id} is missing sentinel Character rows for {sorted(missing)}; "
            "ensure_sentinel_characters must run before speaker resolution."
        )

    ids = [char_id for char_id, _, _ in speaker_rows]
    alias_rows: Sequence[Any] = []
    if ids:
        alias_rows = (
            await session.execute(
                text(
                    "SELECT character_id, surface_form FROM character_alias "
                    "WHERE character_id = ANY(:ids)"
                ),
                {"ids": ids},
            )
        ).all()
    aliases_by_character: dict[str, set[str]] = {}
    for character_id, surface_form in alias_rows:
        aliases_by_character.setdefault(str(character_id), set()).add(surface_form)

    def _normalize(name: str) -> str:
        return " ".join(name.strip().lower().split())

    known_speakers = [
        KnownSpeaker(
            character_id=char_id,
            display_name=display_name,
            normalized_names=frozenset(
                {_normalize(display_name)}
                | {_normalize(a) for a in aliases_by_character.get(char_id, set())}
            ),
            speech_traits=speech_traits,
        )
        for char_id, display_name, speech_traits in speaker_rows
    ]
    sentinels = SentinelIds(
        narrator=sentinel_by_kind["NARRATOR"],
        unknown_speaker=sentinel_by_kind["UNKNOWN_SPEAKER"],
        multiple_speakers=sentinel_by_kind["MULTIPLE_SPEAKERS"],
        system=sentinel_by_kind["SYSTEM"],
    )
    return known_speakers, sentinels


async def load_pronunciation_entries(
    session: AsyncSession, book_id: str
) -> list[PronunciationHintSource]:
    rows = (
        await session.execute(
            text(
                """
                SELECT surface_form, surface_form_normalized, lexicon_key, ipa
                FROM pronunciation_entry WHERE book_id = :book_id AND applies_to = 'GLOBAL'
                """
            ),
            {"book_id": book_id},
        )
    ).all()
    return [
        PronunciationHintSource(
            surface_form=r[0], surface_form_normalized=r[1], lexicon_key=r[2], ipa=r[3]
        )
        for r in rows
    ]


async def load_narrative_state_summary(
    session: AsyncSession, book_id: str, story_bible_version_id: str, max_spine_position: int
) -> NarrativeStateSummary | None:
    """The most recent snapshot AT OR BEFORE `max_spine_position`, pinned to
    `story_bible_version_id` -- never a later snapshot leaking backward into
    earlier narration (task §76's causal-context requirement)."""
    row = (
        await session.execute(
            text(
                """
                SELECT present_character_ids, previous_speaker_character_id, pov_character_id
                FROM narrative_state
                WHERE book_id = :book_id AND story_bible_version_id = :sbv_id
                  AND spine_position <= :spine
                ORDER BY spine_position DESC LIMIT 1
                """
            ),
            {"book_id": book_id, "sbv_id": story_bible_version_id, "spine": max_spine_position},
        )
    ).first()
    if row is None:
        return None
    return NarrativeStateSummary(
        present_character_ids=[str(x) for x in (row[0] or [])],
        previous_speaker_character_id=str(row[1]) if row[1] else None,
        pov_character_id=str(row[2]) if row[2] else None,
    )
