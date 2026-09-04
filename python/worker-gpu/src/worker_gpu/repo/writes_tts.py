"""Writes made by `generate_tts_chunk`/`generate_voice_preview`.

Raw parameterized SQL, matching `worker_ai.repo.writes_scene`/`writes_director`'s pattern.
The GPU worker's write surface is deliberately narrow (`tts-provider-specification.md`
§88 rule 28): `tts_job`, `audio_chunk`, `processing_job` (status only), and its own outbox
rows. It never writes to `audio_script_chunk`'s content/lineage fields (§88 rule 24) --
the one field it touches there is `state`/`current_audio_chunk_id`, which is the freeze
transition `database-schema.md` §13.2 explicitly assigns to the moment a `TTSJob` for that
chunk enters `RUNNING`, not a content change.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from workers_common.events import write_outbox_message
from workers_common.logging import get_logger

log = get_logger(__name__)

PIPELINE_VERSION = "pipeline.v1"


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
                error_code = :error_code, error_class = 'TtsGenerationError',
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


async def begin_tts_job(
    session: AsyncSession,
    *,
    tts_job_id: str,
    audio_script_chunk_id: str,
    voice_profile_version_id: str,
) -> None:
    """The one-transaction freeze rule (`database-schema.md` §13.2, `tts-provider-
    specification.md` §11.1): `tts_job -> RUNNING`, `audio_script_chunk -> LOCKED`, and
    `voice_profile_version -> LOCKED (USED_IN_GENERATION)` happen together, the moment
    this chunk's synthesis actually starts -- never at job admission (§16 of
    `api-specification.md`'s precondition table only checks `APPROVED`-or-`LOCKED`; it is
    THIS transition that performs the automatic lock for a merely-`APPROVED` version).
    """
    now = datetime.now(UTC)
    await session.execute(
        text(
            """
            UPDATE tts_job SET status = 'RUNNING', started_at = :now, updated_at = :now
            WHERE id = :id AND status = 'PENDING'
            """
        ),
        {"id": tts_job_id, "now": now},
    )
    await session.execute(
        text(
            """
            UPDATE audio_script_chunk
            SET state = 'LOCKED', locked_at = :now, updated_at = :now
            WHERE id = :id AND state <> 'LOCKED'
            """
        ),
        {"id": audio_script_chunk_id, "now": now},
    )
    await session.execute(
        text(
            """
            UPDATE voice_profile_version
            SET lock_state = 'LOCKED', locked_at = :now, locked_reason = 'USED_IN_GENERATION',
                updated_at = :now
            WHERE id = :id AND lock_state = 'UNLOCKED' AND approval_state IN ('APPROVED', 'LOCKED')
            """
        ),
        {"id": voice_profile_version_id, "now": now},
    )


async def mark_tts_job_failed(session: AsyncSession, tts_job_id: str, *, error_code: str) -> None:
    await session.execute(
        text(
            """
            UPDATE tts_job SET status = 'FAILED', error_code = :error_code,
                completed_at = :now, updated_at = :now
            WHERE id = :id
            """
        ),
        {"id": tts_job_id, "error_code": error_code, "now": datetime.now(UTC)},
    )


async def insert_audio_chunk(
    session: AsyncSession,
    *,
    audio_chunk_id: str,
    tenant_id: str,
    book_id: str,
    audio_script_chunk_id: str,
    tts_job_id: str,
    chapter_id: str,
    scene_id: str | None,
    character_id: str | None,
    sequence_index: int,
    generation_version: int,
    source_content_hash: str,
    audio_script_ir_schema_version: str,
    director_version: str,
    director_model_version_id: str,
    voice_profile_id: str,
    voice_profile_version_id: str,
    tts_provider_id: str,
    tts_model_version_id: str,
    generation_params_hash: str,
    seed: int | None,
    book_version_id: str,
    story_bible_version_id: str,
    format: str,
    duration_ms: int,
    sample_rate: int,
    channels: int,
    peak_dbfs: float | None,
    rms_dbfs: float | None,
    validation_status: str,
    validation: dict[str, Any],
    capability_gaps: list[dict[str, Any]],
    storage_key: str,
    storage_bucket: str,
    content_hash: str,
    size_bytes: int,
) -> str | None:
    """Insert the new current `AudioChunk`, superseding any prior current row for this
    `AudioScriptChunk` (§46.1's version chain) -- and stamp `object_verified_at` in the
    same statement, since a row is never `GENERATED` without the verified-upload invariant
    holding (`database-schema.md` §16.2's CHECK constraint makes this physically true).

    Returns the id of the row it superseded, if any (for the `tts.chunk_completed` event).
    """
    now = datetime.now(UTC)
    superseded_row = (
        await session.execute(
            text(
                "SELECT id FROM audio_chunk WHERE audio_script_chunk_id = :chunk_id AND is_current = true"
            ),
            {"chunk_id": audio_script_chunk_id},
        )
    ).first()
    supersedes_id = str(superseded_row[0]) if superseded_row else None

    if supersedes_id is not None:
        await session.execute(
            text(
                """
                UPDATE audio_chunk
                SET is_current = false, status = 'SUPERSEDED', superseded_at = :now,
                    superseded_by_audio_chunk_id = :new_id, updated_at = :now
                WHERE id = :old_id
                """
            ),
            {"old_id": supersedes_id, "new_id": audio_chunk_id, "now": now},
        )

    import json as _json

    await session.execute(
        text(
            """
            INSERT INTO audio_chunk (
                id, tenant_id, book_id, audio_script_chunk_id, tts_job_id, chapter_id, scene_id,
                character_id, sequence_index, generation_version, supersedes_audio_chunk_id,
                is_current, status, status_changed_at,
                source_content_hash, audio_script_ir_schema_version, director_version,
                director_model_version_id, voice_profile_id, voice_profile_version_id,
                tts_provider_id, tts_model_version_id, generation_params_hash, seed,
                pipeline_version, book_version_id, story_bible_version_id,
                format, duration_ms, sample_rate, channels, peak_dbfs, rms_dbfs,
                validation_status, validation, capability_gaps,
                storage_key, storage_bucket, content_hash, size_bytes, object_verified_at,
                attempt_count, created_at, updated_at
            ) VALUES (
                :id, :tenant_id, :book_id, :chunk_id, :tts_job_id, :chapter_id, :scene_id,
                :character_id, :sequence_index, :generation_version, :supersedes_id,
                true, :status, :now,
                :source_content_hash, :ir_schema_version, :director_version,
                :director_model_version_id, :voice_profile_id, :voice_profile_version_id,
                :tts_provider_id, :tts_model_version_id, :generation_params_hash, :seed,
                :pipeline_version, :book_version_id, :story_bible_version_id,
                CAST(:format AS audio_format), :duration_ms, :sample_rate, :channels,
                :peak_dbfs, :rms_dbfs,
                CAST(:validation_status AS validation_status), CAST(:validation AS JSONB),
                CAST(:capability_gaps AS JSONB),
                :storage_key, :storage_bucket, :content_hash, :size_bytes, :now,
                1, :now, :now
            )
            """
        ),
        {
            "id": audio_chunk_id,
            "tenant_id": tenant_id,
            "book_id": book_id,
            "chunk_id": audio_script_chunk_id,
            "tts_job_id": tts_job_id,
            "chapter_id": chapter_id,
            "scene_id": scene_id,
            "character_id": character_id,
            "sequence_index": sequence_index,
            "generation_version": generation_version,
            "supersedes_id": supersedes_id,
            # `context.md` §4.4's lifecycle is PENDING -> GENERATING ->
            # GENERATED -> VALIDATED -> ASSEMBLED, where the GENERATED ->
            # VALIDATED promotion belongs to the `validate_audio` job (§28.3).
            # **No `validate_audio` worker exists anywhere in this codebase**,
            # so nothing else can ever perform that promotion — and assembly
            # refuses any chapter whose chunks are not VALIDATED. Writing
            # GENERATED here therefore dead-ended the pipeline: audio was
            # rendered, verified in storage, and then never assemblable.
            #
            # This handler already runs the FULL technical check chain
            # (`run_worker_checks`) precisely so chunks are not "left
            # unvalidated forever" — see this module's and the handler's
            # docstrings. Recording a passing result as VALIDATED is what
            # makes that work count. When a real `validate_audio` worker is
            # built, it takes over the promotion and this reverts to writing
            # GENERATED. See QA finding F-23.
            "status": "VALIDATED" if validation_status == "PASS" else "INVALID",
            "now": now,
            "source_content_hash": source_content_hash,
            "ir_schema_version": audio_script_ir_schema_version,
            "director_version": director_version,
            "director_model_version_id": director_model_version_id,
            "voice_profile_id": voice_profile_id,
            "voice_profile_version_id": voice_profile_version_id,
            "tts_provider_id": tts_provider_id,
            "tts_model_version_id": tts_model_version_id,
            "generation_params_hash": generation_params_hash,
            "seed": seed,
            "pipeline_version": PIPELINE_VERSION,
            "book_version_id": book_version_id,
            "story_bible_version_id": story_bible_version_id,
            "format": format,
            "duration_ms": duration_ms,
            "sample_rate": sample_rate,
            "channels": channels,
            "peak_dbfs": peak_dbfs,
            "rms_dbfs": rms_dbfs,
            "validation_status": validation_status,
            "validation": _json.dumps(validation),
            "capability_gaps": _json.dumps(capability_gaps),
            "storage_key": storage_key,
            "storage_bucket": storage_bucket,
            "content_hash": content_hash,
            "size_bytes": size_bytes,
        },
    )

    await session.execute(
        text(
            "UPDATE audio_script_chunk SET current_audio_chunk_id = :audio_chunk_id, updated_at = :now WHERE id = :id"
        ),
        {"audio_chunk_id": audio_chunk_id, "id": audio_script_chunk_id, "now": now},
    )
    await session.execute(
        text(
            """
            UPDATE tts_job
            SET status = 'SUCCEEDED', audio_chunk_id = :audio_chunk_id, duration_ms = :duration_ms,
                generation_time_ms = :generation_time_ms, capability_gaps = CAST(:capability_gaps AS JSONB),
                completed_at = :now, updated_at = :now
            WHERE id = :tts_job_id
            """
        ),
        {
            "audio_chunk_id": audio_chunk_id,
            "duration_ms": duration_ms,
            "generation_time_ms": None,
            "capability_gaps": _json.dumps(capability_gaps),
            "now": now,
            "tts_job_id": tts_job_id,
        },
    )
    return supersedes_id


async def mark_voice_preview_ready(
    session: AsyncSession,
    preview_id: str,
    *,
    duration_ms: int,
    sample_rate: int,
    storage_key: str,
    storage_bucket: str,
    content_hash: str,
    size_bytes: int,
    capability_gap: dict[str, Any] | None,
) -> None:
    """§47.2 — a preview is written to its own row only; nothing here ever creates or
    touches an `AudioChunk`, so a preview can never enter audiobook lineage by accident."""
    import json as _json

    await session.execute(
        text(
            """
            UPDATE voice_preview
            SET status = 'READY', duration_ms = :duration_ms, sample_rate = :sample_rate,
                storage_key = :storage_key, storage_bucket = :storage_bucket,
                content_hash = :content_hash, size_bytes = :size_bytes,
                object_verified_at = :now, capability_gap = CAST(:capability_gap AS JSONB),
                updated_at = :now
            WHERE id = :id
            """
        ),
        {
            "id": preview_id,
            "duration_ms": duration_ms,
            "sample_rate": sample_rate,
            "storage_key": storage_key,
            "storage_bucket": storage_bucket,
            "content_hash": content_hash,
            "size_bytes": size_bytes,
            "capability_gap": _json.dumps(capability_gap) if capability_gap else None,
            "now": datetime.now(UTC),
        },
    )


async def mark_voice_preview_failed(
    session: AsyncSession, preview_id: str, *, error_code: str, error_message: str
) -> None:
    await session.execute(
        text(
            """
            UPDATE voice_preview
            SET status = 'FAILED', error_code = :error_code, error_message = :error_message,
                updated_at = :now
            WHERE id = :id
            """
        ),
        {
            "id": preview_id,
            "error_code": error_code,
            "error_message": error_message,
            "now": datetime.now(UTC),
        },
    )


async def write_voice_event(
    session: AsyncSession,
    *,
    event_type: str,
    tenant_id: str,
    correlation_id: str,
    aggregate_id: str,
    payload: dict[str, Any],
    book_id: str | None = None,
    job_id: str | None = None,
) -> None:
    await write_outbox_message(
        session,
        event_type=event_type,
        schema_version="1.0",
        producer="worker-gpu",
        producer_version="1.0.0",
        tenant_id=uuid.UUID(tenant_id),
        correlation_id=uuid.UUID(correlation_id),
        causation_id=uuid.UUID(correlation_id),
        aggregate_type="voice_preview",
        aggregate_id=uuid.UUID(aggregate_id),
        book_id=uuid.UUID(book_id) if book_id else None,
        job_id=uuid.UUID(job_id) if job_id else None,
        payload=payload,
    )


async def write_tts_event(
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
        producer="worker-gpu",
        producer_version="1.0.0",
        tenant_id=uuid.UUID(tenant_id),
        correlation_id=uuid.UUID(correlation_id),
        causation_id=uuid.UUID(correlation_id),
        aggregate_type="audio_chunk",
        aggregate_id=uuid.UUID(aggregate_id),
        book_id=uuid.UUID(book_id),
        job_id=uuid.UUID(job_id),
        payload=payload,
    )


async def record_gpu_minutes_usage(session: AsyncSession, *, tenant_id: str, minutes: float) -> None:
    """Phase 10 quota completion (`database-schema.md` §7.5, `common/quota.service.ts`'s
    TypeScript counterpart on the API side). `minutes` is wall-clock GPU time actually spent
    synthesizing this chunk, not the output audio's duration -- those are unrelated
    quantities, and the quota is meant to bound compute cost, not narration length.

    Best-effort and never allowed to fail the job: usage under-reporting is a billing
    inaccuracy, not an outage, matching `QuotaService.recordUsage`'s exact reasoning on the
    Node side. Calendar-month periods and the upsert-by-increment shape mirror that same
    method so a tenant's `tenant_usage_counter` rows stay meaningful regardless of which
    runtime incremented them.
    """
    if minutes <= 0:
        return
    now = datetime.now(UTC)
    period_start = datetime(now.year, now.month, 1, tzinfo=UTC)
    period_end = (
        datetime(now.year + 1, 1, 1, tzinfo=UTC)
        if now.month == 12
        else datetime(now.year, now.month + 1, 1, tzinfo=UTC)
    )
    try:
        await session.execute(
            text(
                """
                INSERT INTO tenant_usage_counter
                    (id, tenant_id, period_start, period_end, metric, used_value, created_at, updated_at)
                VALUES (:id, :tenant_id, :period_start, :period_end, 'GPU_MINUTES', :used_value, :now, :now)
                ON CONFLICT (tenant_id, period_start, metric)
                DO UPDATE SET used_value = tenant_usage_counter.used_value + EXCLUDED.used_value,
                    updated_at = :now
                """
            ),
            {
                "id": str(uuid.uuid4()),
                "tenant_id": tenant_id,
                "period_start": period_start,
                "period_end": period_end,
                "used_value": round(minutes),
                "now": now,
            },
        )
    except Exception:  # noqa: BLE001 - best-effort, see docstring
        log.warning("gpu_minutes_usage.record_failed", tenant_id=tenant_id, minutes=minutes)


__all__ = [
    "PIPELINE_VERSION",
    "begin_tts_job",
    "insert_audio_chunk",
    "mark_job_failed",
    "mark_job_running",
    "mark_job_succeeded",
    "mark_tts_job_failed",
    "mark_voice_preview_failed",
    "mark_voice_preview_ready",
    "record_gpu_minutes_usage",
    "write_tts_event",
    "write_voice_event",
]
