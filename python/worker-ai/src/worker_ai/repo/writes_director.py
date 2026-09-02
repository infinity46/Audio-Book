"""Persistence for the Director: sentinel-character bootstrapping,
`AudioScript` version lifecycle, and `AudioScriptChunk` /
`AudioScriptChunkSource` writes. Mirrors `repo/writes_bible.py`'s
transactional, raw-parameterized-SQL style (see that module's neighbors for
why no ORM is used here).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from worker_ai.director.ir_builder import BuiltChunk
from worker_ai.director.validation import CoverageResult
from workers_common.events import new_id, write_outbox_message

_SENTINEL_DISPLAY_NAMES = {
    "NARRATOR": "Narrator",
    "UNKNOWN_SPEAKER": "Unknown Speaker",
    "MULTIPLE_SPEAKERS": "Multiple Speakers",
    "SYSTEM": "System",
}


async def ensure_sentinel_characters(
    session: AsyncSession, *, tenant_id: str, book_id: str
) -> None:
    """Idempotently creates the four reserved sentinel `Character` rows a
    book needs before any narration/unknown/system speaker can be bound to a
    stable `character_id`. Nothing in Phase 1-3 creates these (`is_sentinel`
    is never set anywhere in the existing codebase) -- a genuine structural
    gap the Director depends on, closed here the same idempotent way
    `story_bible.create_story_bible_version`'s `ON CONFLICT DO UPDATE`
    ensures its own prerequisite row: never a new speaker/character
    invention (task §160), just the four fixed identities the schema
    already reserves a `CharacterSentinel` slot for.
    """
    existing = (
        await session.execute(
            text(
                "SELECT sentinel_kind FROM character "
                "WHERE book_id = :book_id AND is_sentinel = true"
            ),
            {"book_id": book_id},
        )
    ).all()
    have = {row[0] for row in existing}
    now = datetime.now(UTC)
    for kind, display_name in _SENTINEL_DISPLAY_NAMES.items():
        if kind in have:
            continue
        await session.execute(
            text(
                """
                INSERT INTO character (
                    id, tenant_id, book_id, display_name, status, is_sentinel, sentinel_kind,
                    speaking, narrator_capable, evidence_paragraph_ids, created_at, updated_at
                ) VALUES (
                    :id, :tenant_id, :book_id, :display_name, 'CONFIRMED', true, :kind,
                    false, :narrator_capable, CAST(:evidence AS uuid[]), :now, :now
                )
                """
            ),
            {
                "id": str(new_id()),
                "tenant_id": tenant_id,
                "book_id": book_id,
                "display_name": display_name,
                "kind": kind,
                "narrator_capable": kind == "NARRATOR",
                "evidence": [],
                "now": now,
            },
        )


async def load_audio_script(session: AsyncSession, audio_script_id: str) -> dict[str, Any] | None:
    row = (
        await session.execute(
            text(
                "SELECT id, book_id, story_bible_version_id FROM audio_script WHERE id = :id"
            ),
            {"id": audio_script_id},
        )
    ).first()
    if row is None:
        return None
    return {"id": str(row[0]), "book_id": str(row[1]), "story_bible_version_id": str(row[2])}


async def find_current_audio_script(session: AsyncSession, book_id: str) -> str | None:
    row = (
        await session.execute(
            text("SELECT id FROM audio_script WHERE book_id = :book_id AND is_current = true"),
            {"book_id": book_id},
        )
    ).first()
    return str(row[0]) if row else None


async def create_draft_audio_script(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    book_version_id: str,
    scope: str,
    scope_chapter_id: str | None,
    schema_version: str,
    director_version: str,
    director_model_version_id: str,
    story_bible_version_id: str,
    source_content_hash: str,
    structure_version_label: str,
    job_id: str,
    supersedes_audio_script_id: str | None,
) -> tuple[str, int]:
    version_row = (
        await session.execute(
            text("SELECT COALESCE(MAX(version), 0) FROM audio_script WHERE book_id = :book_id"),
            {"book_id": book_id},
        )
    ).first()
    version = int(version_row[0]) + 1 if version_row else 1
    audio_script_id = str(new_id())
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            INSERT INTO audio_script (
                id, tenant_id, book_id, book_version_id, scope, scope_chapter_id,
                version, supersedes_audio_script_id, is_current,
                schema_version, director_version, director_model_version_id,
                story_bible_version_id, source_content_hash, structure_version_label,
                chunk_count, total_characters, estimated_audio_ms,
                state, coverage_verified, coverage_gap_count, coverage_overlap_count,
                job_id, degraded, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :book_id, :book_version_id, :scope, :scope_chapter_id,
                :version, :supersedes_id, false,
                :schema_version, :director_version, :director_model_version_id,
                :story_bible_version_id, :source_content_hash, :structure_version_label,
                0, 0, 0,
                'DRAFT', false, 0, 0,
                :job_id, false, :now, :now
            )
            """
        ),
        {
            "id": audio_script_id,
            "tenant_id": tenant_id,
            "book_id": book_id,
            "book_version_id": book_version_id,
            "scope": scope,
            "scope_chapter_id": scope_chapter_id,
            "version": version,
            "supersedes_id": supersedes_audio_script_id,
            "schema_version": schema_version,
            "director_version": director_version,
            "director_model_version_id": director_model_version_id,
            "story_bible_version_id": story_bible_version_id,
            "source_content_hash": source_content_hash,
            "structure_version_label": structure_version_label,
            "job_id": job_id,
            "now": now,
        },
    )
    return audio_script_id, version


async def insert_chunks(session: AsyncSession, chunks: list[BuiltChunk]) -> None:
    now = datetime.now(UTC)
    for chunk in chunks:
        f = chunk.fields
        await session.execute(
            text(
                """
                INSERT INTO audio_script_chunk (
                    id, tenant_id, book_id, audio_script_id, chapter_id, section_id, scene_id,
                    sequence_index, chapter_sequence_index, version, supersedes_chunk_id,
                    is_current,
                    source_content_hash, schema_version, director_version,
                    director_model_version_id,
                    context_bundle_hash, story_bible_version_id,
                    text, spoken_text, language, script,
                    speaker_type, character_id, is_dialogue, delivery_mode,
                    emotion, emotion_intensity, pacing, pitch, volume,
                    pauses, emphasis, pronunciation_hints, non_verbal,
                    voice_profile_id, voice_profile_version_id,
                    tts_provider_id, generation_params, generation_params_hash,
                    seed, target_sample_rate, target_channels,
                    confidence, decision_confidence, review_flags,
                    fallback_applied, fallback_reason, capability_gaps, continuity,
                    origin, director_original, override,
                    state, created_at, updated_at
                ) VALUES (
                    :id, :tenant_id, :book_id, :audio_script_id, :chapter_id, :section_id,
                    :scene_id,
                    :sequence_index, :chapter_sequence_index, :version, :supersedes_chunk_id,
                    true,
                    :source_content_hash, :schema_version, :director_version,
                    :director_model_version_id,
                    :context_bundle_hash, :story_bible_version_id,
                    :text, :spoken_text, :language, :script,
                    :speaker_type, :character_id, :is_dialogue, :delivery_mode,
                    :emotion, :emotion_intensity, :pacing, :pitch, :volume,
                    CAST(:pauses AS JSONB), CAST(:emphasis AS JSONB),
                    CAST(:pronunciation_hints AS JSONB), CAST(:non_verbal AS JSONB),
                    :voice_profile_id, :voice_profile_version_id,
                    :tts_provider_id, CAST(:generation_params AS JSONB), :generation_params_hash,
                    :seed, :target_sample_rate, :target_channels,
                    :confidence, CAST(:decision_confidence AS JSONB),
                    CAST(:review_flags AS review_flag[]),
                    :fallback_applied, :fallback_reason,
                    CAST(:capability_gaps AS JSONB), CAST(:continuity AS JSONB),
                    :origin, CAST(:director_original AS JSONB), CAST(:override AS JSONB),
                    :state, :now, :now
                )
                """
            ),
            {**f, "now": now, **{k: _json(f[k]) for k in (
                "pauses", "emphasis", "pronunciation_hints", "non_verbal",
                "generation_params", "decision_confidence", "capability_gaps",
                "continuity", "director_original", "override",
            )}},
        )
        source = chunk.source
        await session.execute(
            text(
                """
                INSERT INTO audio_script_chunk_source (
                    audio_script_chunk_id, order_index, paragraph_id, book_id,
                    paragraph_char_start, paragraph_char_end,
                    created_at, updated_at
                ) VALUES (
                    :audio_script_chunk_id, :order_index, :paragraph_id, :book_id,
                    :paragraph_char_start, :paragraph_char_end,
                    :now, :now
                )
                """
            ),
            # `updated_at` is NOT NULL with no database default: Prisma's
            # `@updatedAt` is maintained by the Prisma client, so the DDL
            # carries no `DEFAULT`, and every writer outside Prisma has to
            # supply it explicitly. Omitting it here made every Director run
            # fail with a NotNullViolationError. The sibling INSERT into
            # `audio_script_chunk` above already passes `:now, :now`; this one
            # was the sole exception.
            {**source, "now": now},
        )
        await session.execute(
            text("UPDATE paragraph SET scripted_at = COALESCE(scripted_at, :now) WHERE id = :id"),
            {"id": source["paragraph_id"], "now": now},
        )


async def finalize_audio_script(
    session: AsyncSession,
    *,
    audio_script_id: str,
    book_id: str,
    chunk_count: int,
    total_characters: int,
    coverage: CoverageResult,
    unknown_speaker_rate: float,
    fallback_applied_count: int,
    low_confidence_chunk_count: int,
    degraded: bool,
) -> None:
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            UPDATE audio_script
            SET state = 'VALIDATED', is_current = true,
                chunk_count = :chunk_count, total_characters = :total_characters,
                coverage_verified = :coverage_verified,
                coverage_gap_count = :gap_count, coverage_overlap_count = :overlap_count,
                unknown_speaker_rate = :unknown_speaker_rate,
                fallback_applied_count = :fallback_applied_count,
                low_confidence_chunk_count = :low_confidence_chunk_count,
                degraded = :degraded, updated_at = :now
            WHERE id = :id
            """
        ),
        {
            "id": audio_script_id,
            "chunk_count": chunk_count,
            "total_characters": total_characters,
            "coverage_verified": coverage.verified,
            "gap_count": coverage.gap_count,
            "overlap_count": coverage.overlap_count,
            "unknown_speaker_rate": unknown_speaker_rate,
            "fallback_applied_count": fallback_applied_count,
            "low_confidence_chunk_count": low_confidence_chunk_count,
            "degraded": degraded,
            "now": now,
        },
    )
    await session.execute(
        text(
            """
            UPDATE audio_script
            SET is_current = false, state = 'SUPERSEDED',
                superseded_at = :now, superseded_by_audio_script_id = :id
            WHERE book_id = :book_id AND id != :id AND is_current = true
            """
        ),
        {"id": audio_script_id, "book_id": book_id, "now": now},
    )
    # `current_audio_script_id` is the Book's pointer at its live script, and
    # it is what `apps/api`'s TtsService gates on -- `startTts` refuses with
    # AUDIO_SCRIPT_NOT_VALIDATED when it is NULL. Setting it here, in the same
    # transaction that makes the script current, mirrors what ingestion does
    # for `current_book_version_id` (worker-cpu's ingestion processor sets the
    # pointer alongside the book status). Leaving it unset made TTS
    # unreachable for every book, however valid the script was.
    await session.execute(
        text(
            "UPDATE book SET status = 'SCRIPTED', status_changed_at = :now, "
            "current_audio_script_id = :audio_script_id WHERE id = :id"
        ),
        {"id": book_id, "audio_script_id": audio_script_id, "now": now},
    )


async def load_chunk_for_revision(session: AsyncSession, chunk_id: str) -> dict[str, Any] | None:
    row = (
        await session.execute(
            text(
                """
                SELECT ac.id, ac.audio_script_id, ac.book_id, ac.tenant_id, ac.chapter_id,
                       ac.scene_id, ac.sequence_index, ac.chapter_sequence_index, ac.version,
                       ac.state, acs.paragraph_id, acs.paragraph_char_start, acs.paragraph_char_end
                FROM audio_script_chunk ac
                JOIN audio_script_chunk_source acs ON acs.audio_script_chunk_id = ac.id
                WHERE ac.id = :id AND ac.is_current = true
                """
            ),
            {"id": chunk_id},
        )
    ).first()
    if row is None:
        return None
    return {
        "id": str(row[0]),
        "audio_script_id": str(row[1]),
        "book_id": str(row[2]),
        "tenant_id": str(row[3]),
        "chapter_id": str(row[4]),
        "scene_id": str(row[5]) if row[5] else None,
        "sequence_index": row[6],
        "chapter_sequence_index": row[7],
        "version": row[8],
        "state": row[9],
        "paragraph_id": str(row[10]),
        "paragraph_char_start": row[11],
        "paragraph_char_end": row[12],
    }


async def update_chunk_in_place(session: AsyncSession, chunk_id: str, built: BuiltChunk) -> None:
    """Re-binds a `DRAFT`/`VALIDATED` chunk's decision fields in place --
    never LOCKED chunks (task §124/§38.4: an override on a frozen chunk
    creates a new chunk version instead, see `supersede_locked_chunk`)."""
    f = built.fields
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            UPDATE audio_script_chunk
            SET speaker_type = :speaker_type, character_id = :character_id,
                is_dialogue = :is_dialogue, delivery_mode = :delivery_mode,
                emotion = :emotion, emotion_intensity = :emotion_intensity,
                pacing = :pacing, pitch = :pitch, volume = :volume,
                pauses = CAST(:pauses AS JSONB), emphasis = CAST(:emphasis AS JSONB),
                pronunciation_hints = CAST(:pronunciation_hints AS JSONB),
                non_verbal = CAST(:non_verbal AS JSONB),
                voice_profile_id = :voice_profile_id,
                voice_profile_version_id = :voice_profile_version_id,
                tts_provider_id = :tts_provider_id,
                generation_params = CAST(:generation_params AS JSONB),
                generation_params_hash = :generation_params_hash,
                confidence = :confidence,
                decision_confidence = CAST(:decision_confidence AS JSONB),
                review_flags = CAST(:review_flags AS review_flag[]),
                fallback_applied = :fallback_applied, fallback_reason = :fallback_reason,
                director_version = :director_version,
                director_model_version_id = :director_model_version_id,
                context_bundle_hash = :context_bundle_hash,
                state = 'DRAFT', row_version = row_version + 1, updated_at = :now
            WHERE id = :chunk_id
            """
        ),
        {
            **{k: f[k] for k in (
                "speaker_type", "character_id", "is_dialogue", "delivery_mode", "emotion",
                "emotion_intensity", "pacing", "pitch", "volume", "voice_profile_id",
                "voice_profile_version_id", "tts_provider_id", "generation_params_hash",
                "confidence", "fallback_applied", "fallback_reason", "director_version",
                "director_model_version_id", "context_bundle_hash",
            )},
            **{
                k: _json(f[k])
                for k in (
                    "pauses", "emphasis", "pronunciation_hints", "non_verbal",
                    "generation_params", "decision_confidence",
                )
            },
            "review_flags": f["review_flags"],
            "chunk_id": chunk_id,
            "now": now,
        },
    )


async def supersede_locked_chunk(
    session: AsyncSession, *, old_chunk_id: str, new_chunk: BuiltChunk
) -> None:
    """Creates a new chunk VERSION superseding a `LOCKED` one, never mutating
    the frozen row (task §124, §38.4)."""
    now = datetime.now(UTC)
    await insert_chunks(session, [new_chunk])
    await session.execute(
        text(
            """
            UPDATE audio_script_chunk
            SET is_current = false, superseded_at = :now, superseded_by_chunk_id = :new_id
            WHERE id = :old_id
            """
        ),
        {"old_id": old_chunk_id, "new_id": new_chunk.fields["id"], "now": now},
    )


async def write_director_event(
    session: AsyncSession,
    *,
    event_type: str,
    tenant_id: str,
    book_id: str,
    job_id: str,
    correlation_id: str,
    aggregate_id: str,
    payload: dict[str, Any],
) -> None:
    await write_outbox_message(
        session,
        event_type=event_type,
        schema_version="1.0",
        producer="worker-ai",
        producer_version="1.0.0",
        tenant_id=uuid.UUID(tenant_id),
        correlation_id=uuid.UUID(correlation_id),
        causation_id=uuid.UUID(correlation_id),
        aggregate_type="audio_script",
        aggregate_id=uuid.UUID(aggregate_id),
        book_id=uuid.UUID(book_id),
        job_id=uuid.UUID(job_id),
        payload=payload,
    )


def _json(value: Any) -> str | None:
    import json as _json_module

    if value is None:
        return None
    return _json_module.dumps(value)
