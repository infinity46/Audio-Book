"""Assembles the per-chapter Director context bundle: everything needed to
chunk, resolve speakers, and interpret performance for one chapter's
paragraphs, fetched ONCE (task §211 N+1 audit) rather than per-chunk.

Functionally equivalent to the existing TypeScript `getDirectorContext`
(`apps/api/src/analysis/analysis.service.ts`) L1-L6 bundle, but built in
Python because the worker never calls the API over HTTP for a DB-backed
read -- see `repo/voice.py`'s docstring for the same reasoning applied to
voice binding. `l3_chapter_summary` is likewise still absent here (Phase 3
never populates chapter-level `NarrativeSummary` rows) -- carried forward as
`degraded_layers=["L3"]` exactly as the TS endpoint already does, not
silently fixed by this phase.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from worker_ai.director.speaker_resolver import KnownSpeaker, SentinelIds
from worker_ai.repo import reads_director


@dataclass(frozen=True, slots=True)
class DirectorChapterContext:
    book_id: str
    tenant_id: str
    book_title: str
    book_author: str | None
    book_language: str
    chapter_id: str
    story_bible_version_id: str
    paragraphs: list[reads_director.DirectorParagraphRow]
    scene_semantics_by_scene: dict[str, reads_director.SceneSemanticsRow]
    known_speakers: list[KnownSpeaker]
    sentinels: SentinelIds
    pronunciation_entries: list[reads_director.PronunciationHintSource]
    initial_previous_speaker_id: str | None
    degraded: bool
    degraded_layers: list[str]
    context_bundle_hash: str

    def scene_for_paragraph(self, scene_id: str | None) -> reads_director.SceneSemanticsRow | None:
        if scene_id is None:
            return None
        return self.scene_semantics_by_scene.get(scene_id)

    def speaker_by_id(self, character_id: str) -> KnownSpeaker | None:
        for speaker in self.known_speakers:
            if speaker.character_id == character_id:
                return speaker
        return None


async def load_chapter_context(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    chapter_id: str,
    story_bible_version_id: str,
    chapter_spine_start: int,
) -> DirectorChapterContext:
    book = await reads_director.load_book(session, book_id)
    if book is None:
        raise ValueError(f"Book {book_id} not found")

    paragraphs = await reads_director.load_paragraphs_for_chapter(session, chapter_id)
    scene_semantics = await reads_director.load_scene_semantics_for_chapter(
        session, chapter_id, story_bible_version_id
    )
    known_speakers, sentinels = await reads_director.load_speaker_registry(session, book_id)
    pronunciations = await reads_director.load_pronunciation_entries(session, book_id)
    narrative_state = await reads_director.load_narrative_state_summary(
        session, book_id, story_bible_version_id, chapter_spine_start
    )

    degraded_layers: list[str] = ["L3"]  # chapter summary: still not populated by Phase 3
    scenes_present = {p.scene_id for p in paragraphs if p.scene_id is not None}
    if scenes_present - scene_semantics.keys():
        degraded_layers.append("L4")

    bundle_fingerprint = {
        "book_language": book.language,
        "story_bible_version_id": story_bible_version_id,
        "known_speaker_ids": sorted(s.character_id for s in known_speakers),
        "scene_ids": sorted(scene_semantics.keys()),
        "pronunciation_count": len(pronunciations),
        "narrative_state_present": narrative_state is not None,
    }
    context_bundle_hash = hashlib.sha256(
        json.dumps(bundle_fingerprint, sort_keys=True).encode()
    ).hexdigest()

    return DirectorChapterContext(
        book_id=book_id,
        tenant_id=tenant_id,
        book_title=book.title,
        book_author=book.author,
        book_language=book.language,
        chapter_id=chapter_id,
        story_bible_version_id=story_bible_version_id,
        paragraphs=paragraphs,
        scene_semantics_by_scene=scene_semantics,
        known_speakers=known_speakers,
        sentinels=sentinels,
        pronunciation_entries=pronunciations,
        initial_previous_speaker_id=(
            narrative_state.previous_speaker_character_id if narrative_state else None
        ),
        degraded=len(degraded_layers) > 0,
        degraded_layers=degraded_layers,
        context_bundle_hash=context_bundle_hash,
    )
