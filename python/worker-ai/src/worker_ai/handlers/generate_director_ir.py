"""Consumes `generate_director_ir` -- one chapter's worth of performance
interpretation, chained chapter-by-chapter exactly like `analyze_scene` ->
`build_story_bible_delta` (see that pair's docstrings): per-book Director
processing is sequential across chapters (director-specification.md §49.3's
"per-book concurrency capped... sequential context ordering"), each
invocation processes ONE chapter's paragraphs into `AudioScriptChunk` rows,
then either enqueues the next chapter or finalizes the whole run.

## Why chunk-level work stays inside this one handler, not fanned out further

`director-specification.md` §49.3 also says IR generation "is parallel
WITHIN an already-analyzed scene" -- a further fan-out phase 4 could add
later. This pass keeps within-chapter chunk processing sequential inside one
handler invocation: it keeps chunk-to-chunk emotional/pacing CONTINUITY
(task §91, §181) trivial to implement correctly (plain local state threaded
through a loop) rather than requiring a second cross-chunk reconciliation
pass, and a chapter's chunk count is bounded (tens, not thousands), so the
correctness/complexity tradeoff favors sequential-within-chapter for this
implementation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from worker_ai.director import (
    PerformanceChunkInput,
    PreviousPerformanceState,
    SceneContext,
    SpeakerContext,
)
from worker_ai.director.analyzer import DirectorModelProvider
from worker_ai.director.chunker import chunk_paragraph
from worker_ai.director.context import DirectorChapterContext, load_chapter_context
from worker_ai.director.ir_builder import IR_SCHEMA_VERSION, BuiltChunk, build_chunk
from worker_ai.director.schemas import DeliveryModeLiteral, EmotionLiteral
from worker_ai.director.speaker_resolver import ResolvedSpeaker, resolve_speaker
from worker_ai.queue_producer import QueueProducer
from worker_ai.repo import model_registry, reads, writes_director, writes_scene
from worker_ai.repo.voice import preload_voice_bindings, resolve_voice_binding_from_cache
from workers_common.events import new_id
from workers_common.logging import get_logger
from workers_common.queue import JobContext, TerminalJobError, TransientJobError

log = get_logger(__name__)


@dataclass
class _ChapterRunState:
    """Local, in-memory continuity state threaded across the chunks of ONE
    chapter -- never persisted mid-chapter, never leaked across chapters
    except via the single `previous_speaker_id`/`previous_state` values
    carried forward in the next chapter's job payload (task §92: "provide
    relevant previous context... not entire audio scripts")."""

    previous_speaker_id: str | None
    previous_emotion: EmotionLiteral | None = None
    previous_emotion_intensity: float | None = None
    previous_pacing: float | None = None
    previous_pitch: float | None = None
    previous_volume: float | None = None
    previous_delivery_mode: DeliveryModeLiteral | None = None


async def handle_generate_director_ir(
    ctx: JobContext, *, provider: DirectorModelProvider, queue_producer: QueueProducer
) -> None:
    payload: dict[str, Any] = ctx.envelope.payload
    job_id = str(ctx.envelope.job_id)
    tenant_id = str(ctx.envelope.tenant_id)
    book_id = str(payload["book_id"])
    book_version_id = str(payload["book_version_id"])
    story_bible_version_id = str(payload["story_bible_version_id"])
    chapter_id = str(payload["chapter_id"])
    director_version = str(payload["director_version"])
    all_chapter_ids: list[str] = list(payload["all_chapter_ids"])
    remaining_chapter_ids: list[str] = list(payload.get("remaining_chapter_ids", []))
    is_last_chapter = len(remaining_chapter_ids) == 0
    incoming_previous_speaker_id = payload.get("previous_speaker_id")

    async with ctx.db.session() as session:
        job = await reads.load_job(session, job_id)
        if job is None:
            raise TerminalJobError(f"ProcessingJob {job_id} not found", error_code="JOB_NOT_FOUND")
        if job.status in ("SUCCEEDED", "FAILED"):
            log.info("job.already_terminal_skip", job_id=job_id, status=job.status)
            return

        chapter = await reads.load_chapter(session, chapter_id)
        if chapter is None:
            raise TerminalJobError(
                f"Chapter {chapter_id} not found", error_code="INSUFFICIENT_CONTEXT"
            )

        model_version_id = await model_registry.resolve_model_version_id(
            session, provider.model_identity
        )
        await writes_scene.mark_job_running(session, job_id)
        await writes_director.ensure_sentinel_characters(
            session, tenant_id=tenant_id, book_id=book_id
        )

        # `audio_script_id` is created lazily by the FIRST chapter processed,
        # exactly the way `analyze_scene` creates `story_bible_version_id` on
        # its first chapter (see that handler) -- the API never resolves
        # `director_model_version_id` itself, so it cannot create this row
        # upfront without duplicating the provider-identity knowledge that
        # belongs to this worker alone.
        audio_script_id = payload.get("audio_script_id")
        if not audio_script_id:
            supersedes_id = await writes_director.find_current_audio_script(session, book_id)
            book_version = await reads.load_book_version(session, book_version_id)
            audio_script_id, _version = await writes_director.create_draft_audio_script(
                session,
                tenant_id=tenant_id,
                book_id=book_id,
                book_version_id=book_version_id,
                scope=str(payload.get("scope", "BOOK")),
                scope_chapter_id=payload.get("scope_chapter_id"),
                schema_version=IR_SCHEMA_VERSION,
                director_version=director_version,
                director_model_version_id=model_version_id,
                story_bible_version_id=story_bible_version_id,
                source_content_hash=book_version.content_hash if book_version else "",
                structure_version_label=str(payload.get("structure_version_label", "structure.v1")),
                job_id=str(payload.get("root_job_id", job_id)),
                supersedes_audio_script_id=supersedes_id,
            )
        else:
            audio_script_id = str(audio_script_id)

        chapter_context = await load_chapter_context(
            session,
            tenant_id=tenant_id,
            book_id=book_id,
            chapter_id=chapter_id,
            story_bible_version_id=story_bible_version_id,
            chapter_spine_start=chapter.spine_start,
        )
        # One bulk voice-binding query for the whole chapter's speaker roster
        # (task §211's N+1 audit) -- never one query per chunk.
        voice_bindings = await preload_voice_bindings(
            session,
            book_id=book_id,
            character_ids=[s.character_id for s in chapter_context.known_speakers],
            narrator_character_id=chapter_context.sentinels.narrator,
        )

    # ---- The risky, per-chunk computation, outside any transaction --------
    run_state = _ChapterRunState(
        previous_speaker_id=(
            incoming_previous_speaker_id or chapter_context.initial_previous_speaker_id
        ),
        previous_emotion=payload.get("previous_emotion"),
        previous_emotion_intensity=payload.get("previous_emotion_intensity"),
        previous_pacing=payload.get("previous_pacing"),
        previous_pitch=payload.get("previous_pitch"),
        previous_volume=payload.get("previous_volume"),
        previous_delivery_mode=payload.get("previous_delivery_mode"),
    )
    built_chunks: list[BuiltChunk] = []
    try:
        sequence_index = int(payload.get("sequence_index_start", 0))
        chapter_sequence_index = 0
        for paragraph in chapter_context.paragraphs:
            scene = chapter_context.scene_for_paragraph(paragraph.scene_id)
            for span in chunk_paragraph(paragraph.id, paragraph.text):
                resolved_speaker = _resolve(span, paragraph.text, chapter_context, run_state, scene)
                decision = await _decide_performance(
                    provider, span, resolved_speaker, scene, run_state, chapter_context
                )
                voice_binding, voice_fallback = resolve_voice_binding_from_cache(
                    speaker_type=resolved_speaker.speaker_type,
                    character_id=resolved_speaker.character_id,
                    narrator_character_id=chapter_context.sentinels.narrator,
                    bindings_by_character=voice_bindings,
                )

                built = build_chunk(
                    chunk_id=str(new_id()),
                    audio_script_id=audio_script_id,
                    book_id=book_id,
                    tenant_id=tenant_id,
                    chapter_id=chapter_id,
                    scene_id=paragraph.scene_id,
                    sequence_index=sequence_index,
                    chapter_sequence_index=chapter_sequence_index,
                    span=span,
                    resolved_speaker=resolved_speaker,
                    decision=decision,
                    voice_binding=voice_binding,
                    voice_fallback_applied=voice_fallback,
                    pronunciation_entries=chapter_context.pronunciation_entries,
                    language=chapter_context.book_language,
                    director_version=director_version,
                    director_model_version_id=model_version_id,
                    story_bible_version_id=story_bible_version_id,
                    context_bundle_hash=chapter_context.context_bundle_hash,
                )
                built_chunks.append(built)
                sequence_index += 1
                chapter_sequence_index += 1
                run_state = _ChapterRunState(
                    previous_speaker_id=resolved_speaker.character_id,
                    previous_emotion=decision.emotion,
                    previous_emotion_intensity=decision.emotion_intensity,
                    previous_pacing=decision.pacing,
                    previous_pitch=decision.pitch,
                    previous_volume=decision.volume,
                    previous_delivery_mode=decision.delivery_mode,
                )
    except (TerminalJobError, TransientJobError) as exc:
        if ctx.is_final_attempt:
            async with ctx.db.session() as failure_session:
                await writes_scene.mark_job_failed(
                    failure_session,
                    job_id,
                    error_code=getattr(exc, "error_code", "DIRECTOR_MODEL_FAILED"),
                    error_message=str(exc),
                    retryable=isinstance(exc, TransientJobError),
                )
                await writes_director.write_director_event(
                    failure_session,
                    event_type="director.failed",
                    tenant_id=tenant_id,
                    book_id=book_id,
                    job_id=job_id,
                    correlation_id=job.correlation_id,
                    aggregate_id=audio_script_id,
                    payload={
                        "audio_script_id": audio_script_id,
                        "error_code": getattr(exc, "error_code", "DIRECTOR_MODEL_FAILED"),
                        "error_class": type(exc).__name__,
                        "failed_scope": chapter_id,
                        "retryable": isinstance(exc, TransientJobError),
                    },
                )
        raise

    # ---- Persist this chapter's chunks, then chain or finalize ------------
    next_job_id: str | None = None
    async with ctx.db.session() as session:
        await writes_director.insert_chunks(session, built_chunks)

        for built in built_chunks:
            await writes_director.write_director_event(
                session,
                event_type="director.chunk_completed",
                tenant_id=tenant_id,
                book_id=book_id,
                job_id=job_id,
                correlation_id=job.correlation_id,
                aggregate_id=audio_script_id,
                payload={
                    "audio_script_id": audio_script_id,
                    "audio_script_chunk_id": built.fields["id"],
                    "sequence_index": built.fields["sequence_index"],
                    "chunk_version": built.fields["version"],
                    "confidence": built.fields["confidence"],
                    "fallback_applied": built.fields["fallback_applied"],
                    "review_flags": built.fields["review_flags"],
                },
            )

        if is_last_chapter:
            await _finalize_run(
                session,
                tenant_id=tenant_id,
                book_id=book_id,
                job_id=job_id,
                root_job_id=str(payload.get("root_job_id", job_id)),
                correlation_id=job.correlation_id,
                audio_script_id=audio_script_id,
                all_chapter_ids=all_chapter_ids,
            )
        else:
            next_chapter_id = remaining_chapter_ids[0]
            next_job_id = str(new_id())
            root_job_id = str(payload.get("root_job_id", job_id))
            await writes_scene.create_child_job(
                session,
                job_id=next_job_id,
                tenant_id=tenant_id,
                book_id=book_id,
                job_type="generate_director_ir",
                parent_job_id=root_job_id,
                related_resource_id=audio_script_id,
                scope={"chapter_id": next_chapter_id},
                idempotency_key=(
                    f"director:{audio_script_id}:{next_chapter_id}:"
                    f"{director_version}:{chapter_context.context_bundle_hash}"
                ),
                idempotency_fingerprint=chapter_context.context_bundle_hash,
                correlation_id=job.correlation_id,
            )
            await writes_scene.mark_job_succeeded(
                session,
                job_id,
                result_resource_type="audio_script",
                result_resource_id=audio_script_id,
            )

    if next_job_id is not None:
        await queue_producer.enqueue(
            job_name="generate_director_ir",
            job_id=next_job_id,
            correlation_id=job.correlation_id,
            causation_id=job.correlation_id,
            tenant_id=tenant_id,
            entity_id=next_job_id,
            payload={
                "book_id": book_id,
                "book_version_id": book_version_id,
                "story_bible_version_id": story_bible_version_id,
                "audio_script_id": audio_script_id,
                "director_version": director_version,
                "chapter_id": remaining_chapter_ids[0],
                "remaining_chapter_ids": remaining_chapter_ids[1:],
                "all_chapter_ids": all_chapter_ids,
                "root_job_id": payload.get("root_job_id", job_id),
                "sequence_index_start": sequence_index,
                "previous_speaker_id": run_state.previous_speaker_id,
                "previous_emotion": run_state.previous_emotion,
                "previous_emotion_intensity": run_state.previous_emotion_intensity,
                "previous_pacing": run_state.previous_pacing,
                "previous_pitch": run_state.previous_pitch,
                "previous_volume": run_state.previous_volume,
                "previous_delivery_mode": run_state.previous_delivery_mode,
            },
        )

    log.info(
        "generate_director_ir.completed",
        job_id=job_id,
        chapter_id=chapter_id,
        chunks_built=len(built_chunks),
        finalized=is_last_chapter,
    )


def _resolve(
    span: Any,
    paragraph_text: str,
    chapter_context: DirectorChapterContext,
    run_state: _ChapterRunState,
    scene: Any,
) -> ResolvedSpeaker:
    participant_ids = (
        scene.participant_character_ids if scene is not None else frozenset()
    )
    return resolve_speaker(
        span,
        paragraph_text=paragraph_text,
        known_speakers=chapter_context.known_speakers,
        scene_participant_ids=frozenset(participant_ids),
        previous_speaker_id=run_state.previous_speaker_id,
        sentinels=chapter_context.sentinels,
    )


async def _decide_performance(
    provider: DirectorModelProvider,
    span: Any,
    resolved_speaker: ResolvedSpeaker,
    scene: Any,
    run_state: _ChapterRunState,
    chapter_context: DirectorChapterContext,
) -> Any:
    speaker_meta = chapter_context.speaker_by_id(resolved_speaker.character_id)
    chunk_input = PerformanceChunkInput(
        chunk_id=f"{span.paragraph_id}:{span.char_start}:{span.char_end}",
        text=span.text,
        is_dialogue_hint=span.is_dialogue_hint,
        speaker=SpeakerContext(
            speaker_type=resolved_speaker.speaker_type,
            character_id=resolved_speaker.character_id,
            display_name=speaker_meta.display_name if speaker_meta else None,
            speech_traits=speaker_meta.speech_traits if speaker_meta else None,
        ),
        scene=(
            SceneContext(summary=scene.summary, mood=scene.mood, tension=scene.tension)
            if scene is not None
            else None
        ),
        previous_state=(
            PreviousPerformanceState(
                speaker_character_id=run_state.previous_speaker_id,
                emotion=run_state.previous_emotion,
                emotion_intensity=run_state.previous_emotion_intensity,
                pacing=run_state.previous_pacing,
                pitch=run_state.previous_pitch,
                volume=run_state.previous_volume,
                delivery_mode=run_state.previous_delivery_mode,
            )
            if run_state.previous_emotion is not None
            else None
        ),
    )
    return await provider.decide_performance(chunk_input)


async def _finalize_run(
    session: Any,
    *,
    tenant_id: str,
    book_id: str,
    job_id: str,
    root_job_id: str,
    correlation_id: str,
    audio_script_id: str,
    all_chapter_ids: list[str],
) -> None:
    """Reloads the FULL scope (all chapters, from the database, not the job
    payload) to validate coverage/consistency across the whole run --
    correctness on retry must not depend on trusting accumulated payload
    state (task §132)."""
    from worker_ai.repo import reads_director as rd

    all_paragraphs = []
    for cid in all_chapter_ids:
        all_paragraphs.extend(await rd.load_paragraphs_for_chapter(session, cid))

    from sqlalchemy import text as sql_text

    chunk_rows = (
        await session.execute(
            sql_text(
                """
                SELECT c.id, c.scene_id, c.character_id, c.voice_profile_version_id,
                       c.speaker_type, c.fallback_applied, c.review_flags,
                       c.char_length_hint
                FROM (
                    SELECT ac.id, ac.scene_id, ac.character_id, ac.voice_profile_version_id,
                           ac.speaker_type, ac.fallback_applied, ac.review_flags,
                           length(ac.text) AS char_length_hint,
                           acs.paragraph_id, acs.paragraph_char_start, acs.paragraph_char_end
                    FROM audio_script_chunk ac
                    JOIN audio_script_chunk_source acs ON acs.audio_script_chunk_id = ac.id
                    WHERE ac.audio_script_id = :audio_script_id AND ac.is_current = true
                ) c
                """
            ),
            {"audio_script_id": audio_script_id},
        )
    ).all()

    from worker_ai.director.ir_builder import BuiltChunk as _BuiltChunk
    from worker_ai.director.validation import (
        validate_coverage as _validate_coverage,
    )
    from worker_ai.director.validation import (
        validate_unknown_speaker_rate as _validate_unknown_speaker_rate,
    )
    from worker_ai.director.validation import (
        validate_voice_consistency as _validate_voice_consistency,
    )

    reconstructed = [
        _BuiltChunk(
            fields={
                "scene_id": r[1],
                "character_id": r[2],
                "voice_profile_version_id": r[3],
                "speaker_type": r[4],
                "fallback_applied": r[5],
                "review_flags": r[6],
            },
            source={
                "paragraph_id": None,
                "paragraph_char_start": 0,
                "paragraph_char_end": 0,
            },
        )
        for r in chunk_rows
    ]

    source_rows = (
        await session.execute(
            sql_text(
                """
                SELECT acs.paragraph_id, acs.paragraph_char_start, acs.paragraph_char_end
                FROM audio_script_chunk_source acs
                JOIN audio_script_chunk ac ON ac.id = acs.audio_script_chunk_id
                WHERE ac.audio_script_id = :audio_script_id AND ac.is_current = true
                """
            ),
            {"audio_script_id": audio_script_id},
        )
    ).all()
    coverage_chunks = [
        _BuiltChunk(
            fields={},
            source={
                "paragraph_id": str(r[0]),
                "paragraph_char_start": r[1],
                "paragraph_char_end": r[2],
            },
        )
        for r in source_rows
    ]

    coverage = _validate_coverage(all_paragraphs, coverage_chunks)
    _validate_unknown_speaker_rate(reconstructed)
    _validate_voice_consistency(reconstructed)

    chunk_count = len(reconstructed)
    total_characters = sum(r[7] or 0 for r in chunk_rows)
    fallback_count = sum(1 for r in chunk_rows if r[5])
    low_confidence_count = sum(1 for r in chunk_rows if "LOW_CONFIDENCE" in (r[6] or []))
    unknown_speaker_rate = (
        sum(1 for r in chunk_rows if r[4] == "UNKNOWN") / chunk_count if chunk_count else 0.0
    )

    await writes_director.finalize_audio_script(
        session,
        audio_script_id=audio_script_id,
        book_id=book_id,
        chunk_count=chunk_count,
        total_characters=total_characters,
        coverage=coverage,
        unknown_speaker_rate=unknown_speaker_rate,
        fallback_applied_count=fallback_count,
        low_confidence_chunk_count=low_confidence_count,
        degraded=False,
    )
    await writes_scene.mark_job_succeeded(
        session, job_id, result_resource_type="audio_script", result_resource_id=audio_script_id
    )
    await session.execute(
        sql_text(
            """
            UPDATE processing_job
            SET status = 'SUCCEEDED', status_changed_at = :now, completed_at = :now,
                progress = 1, updated_at = :now
            WHERE id = :id AND status NOT IN ('SUCCEEDED', 'FAILED')
            """
        ),
        {"id": root_job_id, "now": datetime.now(UTC)},
    )
    await writes_director.write_director_event(
        session,
        event_type="director.completed",
        tenant_id=tenant_id,
        book_id=book_id,
        job_id=job_id,
        correlation_id=correlation_id,
        aggregate_id=audio_script_id,
        payload={
            "audio_script_id": audio_script_id,
            "chunk_count": chunk_count,
            "ir_schema_version": "ir.v1.0",
            "coverage_verified": coverage.verified,
            "unknown_speaker_rate": round(unknown_speaker_rate, 4),
            "fallback_applied_count": fallback_count,
            "low_confidence_chunk_count": low_confidence_count,
        },
    )
