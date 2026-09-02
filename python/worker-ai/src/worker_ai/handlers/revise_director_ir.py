"""Consumes `revise_director_ir` -- a targeted re-run of a bounded set of
already-existing `AudioScriptChunk`s after a character merge, voice
reassignment, lexicon change, or a user's own edit request
(`event-contracts.md` §11.8). Unlike `generate_director_ir`, this never
chains across a whole book: `chunk_ids` is caller-supplied and bounded, so
one job invocation processes all of them.

Re-binds `DRAFT`/`VALIDATED` chunks IN PLACE; a `LOCKED` chunk (frozen the
moment its `TTSJob` entered `RUNNING`) is never mutated -- it is superseded
by a new chunk version instead (task §124-125, §38.4).

Every `chunk_id` is resolved against THIS job's own `book_id` before
anything happens to it -- a payload chunk_id belonging to a different book
is silently skipped, never acted on (task §114: "Do not trust queue payload
IDs. Resolve against authoritative database state.").
"""

from __future__ import annotations

from typing import Any

from worker_ai.director import (
    PerformanceChunkInput,
    SceneContext,
    SpeakerContext,
)
from worker_ai.director.analyzer import DirectorModelProvider
from worker_ai.director.chunker import ChunkSpan
from worker_ai.director.context import load_chapter_context
from worker_ai.director.ir_builder import build_chunk
from worker_ai.director.speaker_resolver import resolve_speaker
from worker_ai.repo import model_registry, reads, reads_director, writes_director, writes_scene
from worker_ai.repo.voice import preload_voice_bindings, resolve_voice_binding_from_cache
from workers_common.events import new_id
from workers_common.logging import get_logger
from workers_common.queue import JobContext, TerminalJobError, TransientJobError

log = get_logger(__name__)


async def handle_revise_director_ir(
    ctx: JobContext, *, provider: DirectorModelProvider
) -> None:
    payload: dict[str, Any] = ctx.envelope.payload
    job_id = str(ctx.envelope.job_id)
    tenant_id = str(ctx.envelope.tenant_id)
    book_id = str(payload["book_id"])
    director_version = str(payload["director_version"])
    revision_reason = str(payload.get("revision_reason", "USER_EDIT"))
    requested_chunk_ids = [str(c) for c in payload.get("chunk_ids", [])]

    async with ctx.db.session() as session:
        job = await reads.load_job(session, job_id)
        if job is None:
            raise TerminalJobError(f"ProcessingJob {job_id} not found", error_code="JOB_NOT_FOUND")
        if job.status in ("SUCCEEDED", "FAILED"):
            log.info("job.already_terminal_skip", job_id=job_id, status=job.status)
            return
        await writes_scene.mark_job_running(session, job_id)

        chunk_rows: list[dict[str, Any]] = []
        for chunk_id in requested_chunk_ids:
            row = await writes_director.load_chunk_for_revision(session, chunk_id)
            if row is None or row["book_id"] != book_id:
                log.warning(
                    "revise_director_ir.chunk_id_rejected",
                    chunk_id=chunk_id,
                    reason="not_found_or_wrong_book",
                )
                continue
            chunk_rows.append(row)

        if not chunk_rows:
            await writes_scene.mark_job_succeeded(
                session, job_id, result_resource_type="audio_script", result_resource_id=book_id
            )
            return

        audio_script_id = chunk_rows[0]["audio_script_id"]
        audio_script = await writes_director.load_audio_script(session, audio_script_id)
        if audio_script is None:
            raise TerminalJobError(
                f"AudioScript {audio_script_id} not found", error_code="AUDIO_SCRIPT_NOT_FOUND"
            )
        story_bible_version_id = audio_script["story_bible_version_id"]

        model_version_id = await model_registry.resolve_model_version_id(
            session, provider.model_identity
        )

        chapters_needed = sorted({r["chapter_id"] for r in chunk_rows})
        contexts_by_chapter = {}
        for chapter_id in chapters_needed:
            chapter = await reads.load_chapter(session, chapter_id)
            if chapter is None:
                continue
            contexts_by_chapter[chapter_id] = await load_chapter_context(
                session,
                tenant_id=tenant_id,
                book_id=book_id,
                chapter_id=chapter_id,
                story_bible_version_id=story_bible_version_id,
                chapter_spine_start=chapter.spine_start,
            )

        all_speaker_ids = sorted(
            {s.character_id for ctx_ in contexts_by_chapter.values() for s in ctx_.known_speakers}
        )
        narrator_id = next(iter(contexts_by_chapter.values())).sentinels.narrator
        voice_bindings = await preload_voice_bindings(
            session,
            book_id=book_id,
            character_ids=all_speaker_ids,
            narrator_character_id=narrator_id,
        )

        # Paragraph text for each affected chunk's (unchanged) source span --
        # revision re-decides performance, it never re-chunks or rewrites text.
        paragraph_ids = sorted({r["paragraph_id"] for r in chunk_rows})
        paragraph_by_id: dict[str, reads_director.DirectorParagraphRow] = {}
        for chapter_id in chapters_needed:
            for p in contexts_by_chapter[chapter_id].paragraphs:
                if p.id in paragraph_ids:
                    paragraph_by_id[p.id] = p

    revised_count = 0
    async with ctx.db.session() as write_session:
        for row in chunk_rows:
            chapter_context = contexts_by_chapter.get(row["chapter_id"])
            paragraph = paragraph_by_id.get(row["paragraph_id"])
            if chapter_context is None or paragraph is None:
                continue

            span_text = paragraph.text[row["paragraph_char_start"] : row["paragraph_char_end"]]
            span = ChunkSpan(
                paragraph_id=row["paragraph_id"],
                char_start=row["paragraph_char_start"],
                char_end=row["paragraph_char_end"],
                text=span_text,
                is_dialogue_hint='"' in span_text or "“" in span_text,
            )
            scene = chapter_context.scene_for_paragraph(paragraph.scene_id)
            resolved_speaker = resolve_speaker(
                span,
                paragraph_text=paragraph.text,
                known_speakers=chapter_context.known_speakers,
                scene_participant_ids=frozenset(
                    scene.participant_character_ids if scene is not None else frozenset()
                ),
                previous_speaker_id=None,
                sentinels=chapter_context.sentinels,
            )

            speaker_meta = chapter_context.speaker_by_id(resolved_speaker.character_id)
            try:
                decision = await provider.decide_performance(
                    PerformanceChunkInput(
                        chunk_id=row["id"],
                        text=span.text,
                        is_dialogue_hint=span.is_dialogue_hint,
                        speaker=SpeakerContext(
                            speaker_type=resolved_speaker.speaker_type,
                            character_id=resolved_speaker.character_id,
                            display_name=speaker_meta.display_name if speaker_meta else None,
                        ),
                        scene=(
                            SceneContext(
                                summary=scene.summary, mood=scene.mood, tension=scene.tension
                            )
                            if scene is not None
                            else None
                        ),
                        previous_state=None,
                    )
                )
            except (TerminalJobError, TransientJobError) as exc:
                if ctx.is_final_attempt:
                    await writes_scene.mark_job_failed(
                        write_session,
                        job_id,
                        error_code=getattr(exc, "error_code", "DIRECTOR_MODEL_FAILED"),
                        error_message=str(exc),
                        retryable=isinstance(exc, TransientJobError),
                    )
                raise

            voice_binding, voice_fallback = resolve_voice_binding_from_cache(
                speaker_type=resolved_speaker.speaker_type,
                character_id=resolved_speaker.character_id,
                narrator_character_id=chapter_context.sentinels.narrator,
                bindings_by_character=voice_bindings,
            )

            if row["state"] == "LOCKED":
                new_chunk = build_chunk(
                    chunk_id=str(new_id()),
                    audio_script_id=row["audio_script_id"],
                    book_id=book_id,
                    tenant_id=tenant_id,
                    chapter_id=row["chapter_id"],
                    scene_id=row["scene_id"],
                    sequence_index=row["sequence_index"],
                    chapter_sequence_index=row["chapter_sequence_index"],
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
                new_chunk.fields["version"] = row["version"] + 1
                new_chunk.fields["supersedes_chunk_id"] = row["id"]
                await writes_director.supersede_locked_chunk(
                    write_session, old_chunk_id=row["id"], new_chunk=new_chunk
                )
                result_chunk_id = new_chunk.fields["id"]
                result_version = new_chunk.fields["version"]
                result_confidence = new_chunk.fields["confidence"]
                result_fallback = new_chunk.fields["fallback_applied"]
                result_flags = new_chunk.fields["review_flags"]
            else:
                built = build_chunk(
                    chunk_id=row["id"],
                    audio_script_id=row["audio_script_id"],
                    book_id=book_id,
                    tenant_id=tenant_id,
                    chapter_id=row["chapter_id"],
                    scene_id=row["scene_id"],
                    sequence_index=row["sequence_index"],
                    chapter_sequence_index=row["chapter_sequence_index"],
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
                await writes_director.update_chunk_in_place(write_session, row["id"], built)
                result_chunk_id, result_version = row["id"], row["version"]
                result_confidence = built.fields["confidence"]
                result_fallback = built.fields["fallback_applied"]
                result_flags = built.fields["review_flags"]

            await writes_director.write_director_event(
                write_session,
                event_type="director.chunk_completed",
                tenant_id=tenant_id,
                book_id=book_id,
                job_id=job_id,
                correlation_id=job.correlation_id,
                aggregate_id=audio_script_id,
                payload={
                    "audio_script_id": audio_script_id,
                    "audio_script_chunk_id": result_chunk_id,
                    "sequence_index": row["sequence_index"],
                    "chunk_version": result_version,
                    "confidence": result_confidence,
                    "fallback_applied": result_fallback,
                    "review_flags": result_flags,
                    "revision_reason": revision_reason,
                },
            )
            revised_count += 1

        await writes_scene.mark_job_succeeded(
            write_session,
            job_id,
            result_resource_type="audio_script",
            result_resource_id=audio_script_id,
        )
        await writes_director.write_director_event(
            write_session,
            event_type="director.completed",
            tenant_id=tenant_id,
            book_id=book_id,
            job_id=job_id,
            correlation_id=job.correlation_id,
            aggregate_id=audio_script_id,
            payload={
                "audio_script_id": audio_script_id,
                "chunk_count": revised_count,
                "revision_reason": revision_reason,
            },
        )

    log.info(
        "revise_director_ir.completed",
        job_id=job_id,
        chunks_requested=len(requested_chunk_ids),
        chunks_revised=revised_count,
    )
