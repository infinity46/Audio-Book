"""Consumes `generate_tts_chunk` (`event-contracts.md` §16, `tts-provider-specification.md`
§17.1's ten-step model). One chunk per invocation, fully independent of every other chunk
(§20 — chunks are parallel by design, never chained the way Director's chapters are).

## The three phases, and why they are separated

1. **Read + freeze** (one transaction): load the chunk and its bound voice, check
   idempotency, then perform the freeze rule — `tts_job -> RUNNING`, `audio_script_chunk ->
   LOCKED`, `voice_profile_version -> LOCKED` — atomically, per `database-schema.md` §13.2.
2. **Synthesize** (no transaction open): the actual model call, upload, and the worker's
   own technical checks. This is the risky, slow, external-call part, and it must not hold
   a database transaction open while it runs — the same discipline
   `worker_ai.handlers.generate_director_ir` already follows for its LLM call.
3. **Persist result** (a second transaction): insert the `AudioChunk`, mark `TtsJob`/
   `ProcessingJob` succeeded, emit `tts.chunk_completed` via the Outbox — all three in one
   commit, so a crash between "audio uploaded" and "row written" leaves no half-published
   state (§53.3, `event-contracts.md` §19.2).

`validate_audio` is specified as its own downstream CPU job (§28.3) — no such worker
exists yet anywhere in this codebase, so this handler runs the full technical check chain
(`worker_gpu.tts.audio.run_worker_checks`) itself rather than leaving the chunk unvalidated
forever. When a `validate_audio` worker is built, this becomes the cheap pre-success subset
only, and the fuller chain moves there — the check functions and their `AudioValidation`
result shape are already the ones that job would use.
"""

from __future__ import annotations

from typing import Any

from worker_gpu.repo import model_registry, reads_tts, writes_tts
from worker_gpu.repo.reads_tts import JobRow, TtsJobRow, VoiceProfileVersionRow
from worker_gpu.tts import (
    PerformanceIntent,
    SpeakerReference,
    SynthesisRequest,
    TTSProvider,
    TtsError,
    TtsErrorCode,
    VoiceCache,
    VoiceReferenceKind,
    classify_provider_error,
    to_job_error,
)
from worker_gpu.tts.synth import synthesize_and_check
from workers_common.events import new_id
from workers_common.logging import get_logger
from workers_common.queue import JobContext, TerminalJobError

log = get_logger(__name__)


async def handle_generate_tts_chunk(
    ctx: JobContext, *, provider: TTSProvider, voice_cache: VoiceCache
) -> None:
    payload: dict[str, Any] = ctx.envelope.payload
    job_id = str(ctx.envelope.job_id)
    tts_job_id = str(payload["tts_job_id"])

    async with ctx.db.session() as session:
        job = await reads_tts.load_job(session, job_id)
        if job is None:
            raise TerminalJobError(f"ProcessingJob {job_id} not found", error_code="JOB_NOT_FOUND")
        if job.status in ("SUCCEEDED", "FAILED"):
            log.info("job.already_terminal_skip", job_id=job_id, status=job.status)
            return

        tts_job = await reads_tts.load_tts_job(session, tts_job_id)
        if tts_job is None:
            raise TerminalJobError(f"TtsJob {tts_job_id} not found", error_code="TTS_JOB_NOT_FOUND")
        if tts_job.status in ("SUCCEEDED", "CANCELLED"):
            log.info("tts_job.already_terminal_skip", tts_job_id=tts_job_id, status=tts_job.status)
            await writes_tts.mark_job_succeeded(
                session, job_id, result_resource_type="tts_job", result_resource_id=tts_job_id
            )
            return

        chunk = await reads_tts.load_audio_script_chunk(session, tts_job.audio_script_chunk_id)
        if chunk is None:
            raise TerminalJobError(
                f"AudioScriptChunk {tts_job.audio_script_chunk_id} not found",
                error_code=TtsErrorCode.INVALID_AUDIO_SCRIPT.value,
            )

        # §42.2 — idempotency under at-least-once delivery: a current AudioChunk already
        # matching this exact lineage means no synthesis is needed at all.
        existing = await reads_tts.find_current_audio_chunk(
            session,
            audio_script_chunk_id=chunk.id,
            voice_profile_version_id=tts_job.voice_profile_version_id,
            generation_params_hash=tts_job.generation_params_hash,
            source_content_hash=chunk.source_content_hash,
        )
        if existing is not None:
            log.info("tts_job.idempotent_skip", tts_job_id=tts_job_id, audio_chunk_id=existing)
            await writes_tts.mark_job_running(session, job_id)
            await writes_tts.mark_job_succeeded(
                session, job_id, result_resource_type="audio_chunk", result_resource_id=existing
            )
            return

        voice_version = await reads_tts.load_voice_profile_version(
            session, tts_job.voice_profile_version_id
        )
        if voice_version is None:
            raise TerminalJobError(
                "Bound VoiceProfileVersion not found",
                error_code=TtsErrorCode.MISSING_VOICE_PROFILE.value,
            )
        # §48.1 — production synthesis targets only APPROVED or LOCKED. Enforced upstream
        # at job admission; re-checked here because the worker never trusts a queue
        # message's claims about database state (§88 rule 6-7, task §141).
        if voice_version.approval_state not in ("APPROVED", "LOCKED"):
            raise TerminalJobError(
                f"VoiceProfileVersion {voice_version.id} is {voice_version.approval_state}, "
                "not APPROVED or LOCKED.",
                error_code=TtsErrorCode.VOICE_VERSION_INVALID.value,
            )

        # §13.3/§15.6 — this worker only renders the exact model it has loaded. A mismatch
        # means capability-based routing sent this job to the wrong worker; the correct
        # response is to fail the ATTEMPT so another (correctly-advertising) worker can
        # claim the retry, never to substitute a "close enough" model.
        loaded_model_version_id = await model_registry.resolve_model_version_id(
            session, provider.model_identity
        )
        if loaded_model_version_id != tts_job.tts_model_version_id:
            raise TerminalJobError(
                f"This worker has {provider.model_identity.model_id}/"
                f"{provider.model_identity.version} loaded ({loaded_model_version_id}), "
                f"but the job pins tts_model_version_id={tts_job.tts_model_version_id}.",
                error_code=TtsErrorCode.MODEL_NOT_FOUND.value,
            )

        audio_script = await reads_tts.load_audio_script(session, chunk.audio_script_id)
        if audio_script is None:
            raise TerminalJobError(
                f"AudioScript {chunk.audio_script_id} not found",
                error_code=TtsErrorCode.INVALID_AUDIO_SCRIPT.value,
            )

        generation_version = await reads_tts.next_generation_version(session, chunk.id)
        await writes_tts.mark_job_running(session, job_id)
        await writes_tts.begin_tts_job(
            session,
            tts_job_id=tts_job_id,
            audio_script_chunk_id=chunk.id,
            voice_profile_version_id=voice_version.id,
        )

    # ---- The risky, external work: outside any open transaction -----------------------
    request = _build_request(job, tts_job, chunk, voice_version, ctx.is_final_attempt, ctx.attempt)

    try:
        outcome = await synthesize_and_check(provider, request, voice_cache)
        result = outcome.result.model_copy(update={"generation_version": generation_version})
        technical = outcome.technical
    except Exception as exc:  # noqa: BLE001 - §79.2 translation boundary
        tts_error = classify_provider_error(exc)
        await _record_failure(ctx, job_id, tts_job_id, tts_error)
        raise to_job_error(tts_error) from exc

    storage_key = (
        f"{job.tenant_id}/books/{job.book_id}/audio/chunks/{chunk.id}/v{generation_version}.wav"
    )
    try:
        checksum = await ctx.storage.put(storage_key, result.audio_wav, content_type="audio/wav")
    except Exception as exc:  # noqa: BLE001
        tts_error = TtsError(TtsErrorCode.OUTPUT_STORAGE_FAILED, f"Upload failed: {exc}")
        await _record_failure(ctx, job_id, tts_job_id, tts_error)
        raise to_job_error(tts_error) from exc

    # ---- Persist: a second, short transaction ------------------------------------------
    gaps_json = [g.model_dump(mode="json") for g in result.capability_gaps]
    async with ctx.db.session() as session:
        audio_chunk_id = str(new_id())
        await writes_tts.insert_audio_chunk(
            session,
            audio_chunk_id=audio_chunk_id,
            tenant_id=job.tenant_id,
            book_id=job.book_id,
            audio_script_chunk_id=chunk.id,
            tts_job_id=tts_job.id,
            chapter_id=chunk.chapter_id,
            scene_id=chunk.scene_id,
            character_id=chunk.character_id,
            sequence_index=chunk.sequence_index,
            generation_version=generation_version,
            source_content_hash=chunk.source_content_hash,
            audio_script_ir_schema_version=chunk.schema_version,
            director_version=chunk.director_version,
            director_model_version_id=chunk.director_model_version_id,
            voice_profile_id=voice_version.voice_profile_id,
            voice_profile_version_id=voice_version.id,
            tts_provider_id=result.provider_id,
            tts_model_version_id=result.tts_model_version_id,
            generation_params_hash=tts_job.generation_params_hash,
            seed=result.seed_used,
            book_version_id=audio_script.book_version_id,
            story_bible_version_id=chunk.story_bible_version_id,
            format=result.format,
            duration_ms=result.duration_ms,
            sample_rate=result.sample_rate,
            channels=result.channels,
            peak_dbfs=technical.measurements.peak_dbfs,
            rms_dbfs=technical.measurements.rms_dbfs,
            validation_status=technical.status,
            validation=technical.as_json(),
            capability_gaps=gaps_json,
            storage_key=storage_key,
            storage_bucket=ctx.storage.bucket,
            content_hash=checksum.sha256,
            size_bytes=checksum.size_bytes,
        )
        await writes_tts.mark_job_succeeded(
            session, job_id, result_resource_type="audio_chunk", result_resource_id=audio_chunk_id
        )
        await writes_tts.write_tts_event(
            session,
            event_type="tts.chunk_completed",
            tenant_id=job.tenant_id,
            book_id=job.book_id,
            job_id=job_id,
            correlation_id=job.correlation_id,
            aggregate_id=audio_chunk_id,
            payload={
                "audio_script_chunk_id": chunk.id,
                "audio_chunk_id": audio_chunk_id,
                "generation_version": generation_version,
                "duration_ms": result.duration_ms,
                "sample_rate": result.sample_rate,
                "content_hash": checksum.sha256,
                "validation_status": technical.status,
                "capability_gaps": gaps_json,
            },
        )

    log.info(
        "generate_tts_chunk.completed",
        job_id=job_id,
        tts_job_id=tts_job_id,
        audio_script_chunk_id=chunk.id,
        generation_version=generation_version,
        validation_status=technical.status,
        capability_gap_count=len(gaps_json),
    )


def _speaker_reference(voice_version: VoiceProfileVersionRow) -> SpeakerReference:
    """§7.1-§7.3 — resolve which of the five voice representations this version uses.
    A predefined library voice needs neither reference audio nor an embedding."""
    if voice_version.embedding_storage_key:
        return SpeakerReference(
            kind=VoiceReferenceKind.EMBEDDING,
            object_key=voice_version.embedding_storage_key,
            content_hash=voice_version.embedding_content_hash,
            extractor_model_version_id=voice_version.embedding_extractor_model_version_id,
        )
    if voice_version.reference_audio_storage_key:
        return SpeakerReference(
            kind=VoiceReferenceKind.REFERENCE_AUDIO,
            object_key=voice_version.reference_audio_storage_key,
            content_hash=voice_version.reference_audio_content_hash,
        )
    return SpeakerReference(kind=VoiceReferenceKind.LIBRARY)


def _build_request(
    job: JobRow,
    tts_job: TtsJobRow,
    chunk: Any,
    voice_version: VoiceProfileVersionRow,
    is_final_attempt: bool,
    attempt: int,
) -> SynthesisRequest:
    # §56.2's OOM ladder ends in "a new seed on the final attempt" — a deterministic
    # function of (original seed, attempt number), never a random draw, so the exact seed
    # actually used stays reproducible from `tts_job.seed` + `attempt` alone.
    seed = tts_job.seed
    if seed is not None and is_final_attempt and attempt > 1:
        seed = seed + attempt

    return SynthesisRequest(
        audio_script_chunk_id=chunk.id,
        audio_script_chunk_version=chunk.version,
        audio_script_id=chunk.audio_script_id,
        tts_job_id=tts_job.id,
        correlation_id=job.correlation_id,
        job_id=job.id,
        text=chunk.spoken_text or chunk.text,
        language=chunk.language,
        voice_profile_id=voice_version.voice_profile_id,
        voice_profile_version_id=voice_version.id,
        speaker_reference=_speaker_reference(voice_version),
        tts_provider_id=voice_version.tts_provider_id,
        tts_model_version_id=voice_version.tts_model_version_id,
        performance=PerformanceIntent(
            speaker_type=chunk.speaker_type,
            character_id=chunk.character_id,
            is_dialogue=chunk.is_dialogue,
            delivery_mode=chunk.delivery_mode,
            emotion=chunk.emotion,
            emotion_intensity=chunk.emotion_intensity,
            pacing=chunk.pacing,
            pitch=chunk.pitch,
            volume=chunk.volume,
            pauses=tuple(chunk.pauses),
            emphasis=tuple(chunk.emphasis),
            pronunciation_hints=tuple(chunk.pronunciation_hints),
            non_verbal=tuple(chunk.non_verbal or []),
        ),
        generation_params={**voice_version.base_generation_params, **(tts_job.generation_params or {})},
        generation_params_hash=tts_job.generation_params_hash,
        seed=seed,
        target_sample_rate=tts_job.target_sample_rate,
        target_channels=tts_job.target_channels,
    )


async def _record_failure(
    ctx: JobContext, job_id: str, tts_job_id: str, error: TtsError
) -> None:
    """§45.1 — a failed `TtsJob` is preserved, never silently dropped, and the failure
    never touches `AudioScriptChunk` (§88 rule 24). Only written on the final attempt:
    an attempt BullMQ is about to retry should not yet report the job (or its `TtsJob`) as
    terminally failed — `tts_job.status` stays `RUNNING` across intermediate retries, the
    same way `processing_job.status` does in `generate_director_ir`."""
    if not ctx.is_final_attempt:
        return
    async with ctx.db.session() as session:
        tts_job = await reads_tts.load_tts_job(session, tts_job_id)
        parent_job = await reads_tts.load_job(session, job_id)
        await writes_tts.mark_tts_job_failed(session, tts_job_id, error_code=error.code.value)
        await writes_tts.mark_job_failed(
            session,
            job_id,
            error_code=error.code.value,
            error_message=str(error),
            retryable=error.retryable,
        )
        if tts_job is not None and parent_job is not None:
            await writes_tts.write_tts_event(
                session,
                event_type="tts.chunk_failed",
                tenant_id=tts_job.tenant_id,
                book_id=tts_job.book_id,
                job_id=job_id,
                correlation_id=parent_job.correlation_id,
                aggregate_id=tts_job.audio_script_chunk_id,
                payload={
                    "audio_script_chunk_id": tts_job.audio_script_chunk_id,
                    "error_code": error.code.value,
                    "error_class": error.classification.value,
                    "attempt": ctx.attempt,
                    "retryable": error.retryable,
                    "terminal": not error.retryable,
                },
            )


__all__ = ["handle_generate_tts_chunk"]
