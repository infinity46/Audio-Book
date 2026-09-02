"""Read-only queries backing `generate_tts_chunk`/`generate_voice_preview`.

Raw parameterized SQL via `sqlalchemy.text()`, matching `worker_ai.repo.reads`'s pattern
exactly -- `workers_common/db.py` ships no ORM (Prisma owns the schema). Column names are
copied verbatim from `prisma/schema.prisma`.

Everything here is scoped to exactly what `app_worker_gpu`'s DB grant permits
(`database-schema.md` §37.2): `processing_job`, `tts_job`, `audio_script_chunk`,
`voice_profile_version`, `model_version`. Nothing here ever selects from `book`,
`paragraph`, `character`, or `voice_assignment` -- the GPU worker has no permission to,
and no need to: every field it requires is already denormalized onto `audio_script_chunk`
and `voice_profile_version` by the Director and the Voice Service.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True, slots=True)
class JobRow:
    id: str
    tenant_id: str
    book_id: str
    status: str
    correlation_id: str


@dataclass(frozen=True, slots=True)
class TtsJobRow:
    id: str
    tenant_id: str
    book_id: str
    audio_script_chunk_id: str
    audio_script_chunk_version: int
    processing_job_id: str | None
    tts_provider_id: str
    tts_model_version_id: str
    voice_profile_id: str
    voice_profile_version_id: str
    generation_params: dict[str, Any]
    generation_params_hash: str
    seed: int | None
    target_sample_rate: int
    target_channels: int
    status: str
    dedupe_key: str
    forced: bool
    force_token: str | None


@dataclass(frozen=True, slots=True)
class AudioScriptChunkRow:
    id: str
    tenant_id: str
    book_id: str
    audio_script_id: str
    chapter_id: str
    scene_id: str | None
    character_id: str | None
    sequence_index: int
    version: int
    state: str
    text: str
    spoken_text: str | None
    language: str
    speaker_type: str
    is_dialogue: bool
    delivery_mode: str
    emotion: str
    emotion_intensity: float
    pacing: float
    pitch: float
    volume: float
    pauses: list[dict[str, Any]]
    emphasis: list[dict[str, Any]]
    pronunciation_hints: list[dict[str, Any]]
    non_verbal: list[dict[str, Any]] | None
    voice_profile_id: str | None
    voice_profile_version_id: str | None
    generation_params: dict[str, Any] | None
    seed: int | None
    target_sample_rate: int | None
    target_channels: int | None
    source_content_hash: str
    schema_version: str
    director_version: str
    director_model_version_id: str
    story_bible_version_id: str


@dataclass(frozen=True, slots=True)
class AudioScriptRow:
    id: str
    book_version_id: str


@dataclass(frozen=True, slots=True)
class VoiceProfileVersionRow:
    id: str
    voice_profile_id: str
    tts_provider_id: str
    tts_model_id: str
    tts_model_version_id: str
    language: str
    supported_languages: list[str]
    base_generation_params: dict[str, Any]
    base_generation_params_hash: str
    reference_audio_storage_key: str | None
    reference_audio_content_hash: str | None
    embedding_storage_key: str | None
    embedding_content_hash: str | None
    embedding_extractor_model_version_id: str | None
    emotion_capability_map: dict[str, Any] | None
    approval_state: str
    lock_state: str


async def load_job(session: AsyncSession, job_id: str) -> JobRow | None:
    row = (
        await session.execute(
            text(
                "SELECT id, tenant_id, book_id, status, correlation_id "
                "FROM processing_job WHERE id = :id"
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
        correlation_id=str(row[4]),
    )


async def load_tts_job(session: AsyncSession, tts_job_id: str) -> TtsJobRow | None:
    row = (
        await session.execute(
            text(
                """
                SELECT id, tenant_id, book_id, audio_script_chunk_id, audio_script_chunk_version,
                       processing_job_id, tts_provider_id, tts_model_version_id,
                       voice_profile_id, voice_profile_version_id, generation_params,
                       generation_params_hash, seed, target_sample_rate, target_channels,
                       status, dedupe_key, forced, force_token
                FROM tts_job WHERE id = :id
                """
            ),
            {"id": tts_job_id},
        )
    ).first()
    if row is None:
        return None
    return TtsJobRow(
        id=str(row[0]),
        tenant_id=str(row[1]),
        book_id=str(row[2]),
        audio_script_chunk_id=str(row[3]),
        audio_script_chunk_version=row[4],
        processing_job_id=str(row[5]) if row[5] else None,
        tts_provider_id=row[6],
        tts_model_version_id=str(row[7]),
        voice_profile_id=str(row[8]),
        voice_profile_version_id=str(row[9]),
        generation_params=row[10] or {},
        generation_params_hash=row[11],
        seed=int(row[12]) if row[12] is not None else None,
        target_sample_rate=row[13],
        target_channels=row[14],
        status=row[15],
        dedupe_key=row[16],
        forced=row[17],
        force_token=row[18],
    )


async def load_audio_script_chunk(session: AsyncSession, chunk_id: str) -> AudioScriptChunkRow | None:
    row = (
        await session.execute(
            text(
                """
                SELECT id, tenant_id, book_id, audio_script_id, chapter_id, scene_id, character_id,
                       sequence_index, version, state, text, spoken_text, language, speaker_type,
                       is_dialogue, delivery_mode, emotion, emotion_intensity, pacing, pitch, volume,
                       pauses, emphasis, pronunciation_hints, non_verbal,
                       voice_profile_id, voice_profile_version_id, generation_params, seed,
                       target_sample_rate, target_channels, source_content_hash, schema_version,
                       director_version, director_model_version_id, story_bible_version_id
                FROM audio_script_chunk WHERE id = :id AND is_current = true
                """
            ),
            {"id": chunk_id},
        )
    ).first()
    if row is None:
        return None
    return AudioScriptChunkRow(
        id=str(row[0]),
        tenant_id=str(row[1]),
        book_id=str(row[2]),
        audio_script_id=str(row[3]),
        chapter_id=str(row[4]),
        scene_id=str(row[5]) if row[5] else None,
        character_id=str(row[6]) if row[6] else None,
        sequence_index=row[7],
        version=row[8],
        state=row[9],
        text=row[10],
        spoken_text=row[11],
        language=row[12],
        speaker_type=row[13],
        is_dialogue=row[14],
        delivery_mode=row[15],
        emotion=row[16],
        emotion_intensity=row[17],
        pacing=row[18],
        pitch=row[19],
        volume=row[20],
        pauses=row[21] or [],
        emphasis=row[22] or [],
        pronunciation_hints=row[23] or [],
        non_verbal=row[24],
        voice_profile_id=str(row[25]) if row[25] else None,
        voice_profile_version_id=str(row[26]) if row[26] else None,
        generation_params=row[27],
        seed=int(row[28]) if row[28] is not None else None,
        target_sample_rate=row[29],
        target_channels=row[30],
        source_content_hash=row[31],
        schema_version=row[32],
        director_version=row[33],
        director_model_version_id=str(row[34]),
        story_bible_version_id=str(row[35]),
    )


async def load_audio_script(session: AsyncSession, audio_script_id: str) -> AudioScriptRow | None:
    row = (
        await session.execute(
            text("SELECT id, book_version_id FROM audio_script WHERE id = :id"),
            {"id": audio_script_id},
        )
    ).first()
    if row is None:
        return None
    return AudioScriptRow(id=str(row[0]), book_version_id=str(row[1]))


async def load_voice_profile_version(
    session: AsyncSession, voice_profile_version_id: str
) -> VoiceProfileVersionRow | None:
    row = (
        await session.execute(
            text(
                """
                SELECT id, voice_profile_id, tts_provider_id, tts_model_id, tts_model_version_id,
                       language, supported_languages, base_generation_params,
                       base_generation_params_hash, reference_audio_storage_key,
                       reference_audio_content_hash, embedding_storage_key, embedding_content_hash,
                       embedding_extractor_model_version_id, emotion_capability_map,
                       approval_state, lock_state
                FROM voice_profile_version WHERE id = :id
                """
            ),
            {"id": voice_profile_version_id},
        )
    ).first()
    if row is None:
        return None
    return VoiceProfileVersionRow(
        id=str(row[0]),
        voice_profile_id=str(row[1]),
        tts_provider_id=row[2],
        tts_model_id=row[3],
        tts_model_version_id=str(row[4]),
        language=row[5],
        supported_languages=row[6] or [],
        base_generation_params=row[7] or {},
        base_generation_params_hash=row[8],
        reference_audio_storage_key=row[9],
        reference_audio_content_hash=row[10],
        embedding_storage_key=row[11],
        embedding_content_hash=row[12],
        embedding_extractor_model_version_id=str(row[13]) if row[13] else None,
        emotion_capability_map=row[14],
        approval_state=row[15],
        lock_state=row[16],
    )


async def find_current_audio_chunk(
    session: AsyncSession,
    *,
    audio_script_chunk_id: str,
    voice_profile_version_id: str,
    generation_params_hash: str,
    source_content_hash: str,
) -> str | None:
    """The skip-existing-output query (`database-schema.md` §21.5) -- the mechanical
    implementation of idempotency (§42.2) and resumability (§82.1): a chunk whose lineage
    exactly matches an already-`GENERATED`/`VALIDATED`/`ASSEMBLED` row needs no synthesis."""
    row = (
        await session.execute(
            text(
                """
                SELECT ac.id
                FROM audio_chunk ac
                WHERE ac.audio_script_chunk_id = :chunk_id AND ac.is_current = true
                  AND ac.status IN ('GENERATED', 'VALIDATED', 'ASSEMBLED')
                  AND ac.voice_profile_version_id = :voice_profile_version_id
                  AND ac.generation_params_hash = :generation_params_hash
                  AND ac.source_content_hash = :source_content_hash
                """
            ),
            {
                "chunk_id": audio_script_chunk_id,
                "voice_profile_version_id": voice_profile_version_id,
                "generation_params_hash": generation_params_hash,
                "source_content_hash": source_content_hash,
            },
        )
    ).first()
    return str(row[0]) if row else None


@dataclass(frozen=True, slots=True)
class VoicePreviewRow:
    id: str
    tenant_id: str
    voice_profile_id: str
    voice_profile_version_id: str
    book_id: str | None
    character_id: str | None
    text_excerpt: str
    emotion: str
    status: str
    job_id: str | None


async def load_voice_preview(session: AsyncSession, preview_id: str) -> VoicePreviewRow | None:
    row = (
        await session.execute(
            text(
                """
                SELECT id, tenant_id, voice_profile_id, voice_profile_version_id, book_id,
                       character_id, text_excerpt, emotion, status, job_id
                FROM voice_preview WHERE id = :id
                """
            ),
            {"id": preview_id},
        )
    ).first()
    if row is None:
        return None
    return VoicePreviewRow(
        id=str(row[0]),
        tenant_id=str(row[1]),
        voice_profile_id=str(row[2]),
        voice_profile_version_id=str(row[3]),
        book_id=str(row[4]) if row[4] else None,
        character_id=str(row[5]) if row[5] else None,
        text_excerpt=row[6],
        emotion=row[7],
        status=row[8],
        job_id=str(row[9]) if row[9] else None,
    )


async def next_generation_version(session: AsyncSession, audio_script_chunk_id: str) -> int:
    row = (
        await session.execute(
            text(
                "SELECT COALESCE(MAX(generation_version), 0) FROM audio_chunk "
                "WHERE audio_script_chunk_id = :id"
            ),
            {"id": audio_script_chunk_id},
        )
    ).first()
    return int(row[0]) + 1 if row else 1


__all__ = [
    "AudioScriptChunkRow",
    "AudioScriptRow",
    "JobRow",
    "TtsJobRow",
    "VoicePreviewRow",
    "VoiceProfileVersionRow",
    "find_current_audio_chunk",
    "load_audio_script",
    "load_audio_script_chunk",
    "load_job",
    "load_tts_job",
    "load_voice_preview",
    "load_voice_profile_version",
    "next_generation_version",
]
