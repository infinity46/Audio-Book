"""Consumes `analyze_scene` -- one chapter's worth of narrative-understanding analysis.

Mirrors `apps/worker-cpu/src/processors/ingestion.ts`'s shape deliberately: idempotent
replay check first (§14/§107: at-least-once delivery of an already-terminal job is a
safe no-op), the risky computation (the analyzer call) happens OUTSIDE any database
transaction, and a failure is recorded in its OWN short transaction -- never inside the
same transaction as the work that failed, which would roll the failure record back too.

State transition persisted here (matches the architecture's own description of this
job, `event-contracts.md` §11.5): creates `scene`, `scene_semantics`,
`scene_participant`, one `narrative_state` checkpoint per chapter, and `PROVISIONAL`
`character`/`character_alias` rows. It does NOT create `character_relationship` or the
other Story-Bible-wide fact tables -- those are staged into the `build_story_bible_delta`
job it creates and enqueues next (see that handler's module docstring for why the two
are split this way).

Flagged deviation from `api-specification.md`'s "Book Service owns Scene boundaries":
Phase 2's ingestion pipeline never populates the `scene` table (only
`chapter`/`section`/`paragraph`) and there is no separate `analyze_structure` step in
this codebase that does either. Since Phase 2 is complete and out of scope to modify,
scene boundary detection happens here instead, as a deterministic pre-pass ahead of
scene *semantics* -- see the Phase 3 plan/report for the full reasoning.
"""

from __future__ import annotations

import hashlib
import uuid
from typing import Any

from worker_ai.queue_producer import QueueProducer
from worker_ai.repo import model_registry, reads, story_bible, writes_scene
from worker_ai.semantic import SemanticAnalyzer
from worker_ai.semantic.schemas import AnalyzeChapterInput, PriorContext
from workers_common.events import new_id, write_outbox_message
from workers_common.logging import get_logger
from workers_common.queue import JobContext, TerminalJobError, TransientJobError

log = get_logger(__name__)


async def handle_analyze_scene(
    ctx: JobContext, *, analyzer: SemanticAnalyzer, queue_producer: QueueProducer
) -> None:
    payload: dict[str, Any] = ctx.envelope.payload
    job_id = str(ctx.envelope.job_id)
    tenant_id = str(ctx.envelope.tenant_id)
    chapter_id = str(payload["chapter_id"])
    book_version_id = str(payload["book_version_id"])

    # ---- Gather inputs (reads only, plus the RUNNING status flip) -----------------
    async with ctx.db.session() as session:
        job = await reads.load_job(session, job_id)
        if job is None:
            raise TerminalJobError(f"ProcessingJob {job_id} not found", error_code="JOB_NOT_FOUND")
        if job.status in ("SUCCEEDED", "FAILED"):
            log.info("job.already_terminal_skip", job_id=job_id, status=job.status)
            return

        chapter = await reads.load_chapter(session, chapter_id)
        book_version = await reads.load_book_version(session, book_version_id)
        if chapter is None or book_version is None:
            raise TerminalJobError(
                f"Chapter {chapter_id} or BookVersion {book_version_id} not found",
                error_code="INSUFFICIENT_CONTEXT",
            )

        paragraphs = await reads.load_paragraphs(session, chapter_id)
        known_characters = await reads.load_known_characters(session, job.book_id)
        prior_state = await reads.load_latest_narrative_state(session, job.book_id)
        model_version_id = await model_registry.resolve_model_version_id(
            session, analyzer.model_identity
        )
        await writes_scene.mark_job_running(session, job_id)

    # ---- The risky computation, outside any transaction ----------------------------
    try:
        result = await analyzer.analyze_chapter(
            AnalyzeChapterInput(
                chapter_id=chapter_id,
                book_id=job.book_id,
                paragraphs=paragraphs,
                prior_context=PriorContext(
                    known_characters=known_characters,
                    previous_narrative_state=prior_state,
                ),
            )
        )
    except (TerminalJobError, TransientJobError) as exc:
        if ctx.is_final_attempt:
            async with ctx.db.session() as failure_session:
                await writes_scene.mark_job_failed(
                    failure_session,
                    job_id,
                    error_code=getattr(exc, "error_code", "SEMANTIC_ANALYSIS_FAILED"),
                    error_message=str(exc),
                    retryable=isinstance(exc, TransientJobError),
                )
        raise

    # ---- Persist everything the analysis produced, in one transaction --------------
    story_bible_version_id = payload.get("story_bible_version_id")
    chapters_total = int(payload.get("chapters_total", 1))

    async with ctx.db.session() as session:
        if not story_bible_version_id:
            version_number = await story_bible.get_next_version_number(session, job.book_id)
            story_bible_version_id = await story_bible.create_story_bible_version(
                session,
                tenant_id=tenant_id,
                book_id=job.book_id,
                book_version_id=book_version_id,
                version=version_number,
                build_mode=str(payload.get("analysis_mode", "INCREMENTAL")),
                built_by_model_version_id=model_version_id,
                source_content_hash=book_version.content_hash,
                facts_content_hash=hashlib.sha256(
                    f"{job.book_id}:{version_number}".encode()
                ).hexdigest(),
                job_id=str(payload.get("root_job_id", job_id)),
                chapters_total=chapters_total,
            )

        key_to_character_id: dict[str, str] = {}
        for mention in result.characters:
            if mention.resolved_character_id:
                key_to_character_id[mention.normalized_key] = mention.resolved_character_id
                last_evidence = (
                    mention.evidence_paragraph_ids[-1]
                    if mention.evidence_paragraph_ids
                    else paragraphs[-1].id
                )
                await writes_scene.update_character_last_appearance(
                    session,
                    mention.resolved_character_id,
                    chapter_id=chapter_id,
                    paragraph_id=last_evidence,
                )
                continue

            first_evidence = (
                mention.evidence_paragraph_ids[0]
                if mention.evidence_paragraph_ids
                else paragraphs[0].id
            )
            character_id = await writes_scene.create_character(
                session,
                tenant_id=tenant_id,
                book_id=job.book_id,
                display_name=mention.surface_form,
                speaking=mention.is_speaker,
                model_version_id=model_version_id,
                confidence=mention.confidence,
                evidence_paragraph_ids=mention.evidence_paragraph_ids,
                first_appearance_chapter_id=chapter_id,
                first_appearance_paragraph_id=first_evidence,
            )
            await writes_scene.create_alias(
                session,
                tenant_id=tenant_id,
                book_id=job.book_id,
                character_id=character_id,
                surface_form=mention.surface_form,
                alias_type=mention.alias_type,
                model_version_id=model_version_id,
                confidence=mention.confidence,
            )
            key_to_character_id[mention.normalized_key] = character_id

            await write_outbox_message(
                session,
                event_type="character.discovered",
                schema_version="1.0",
                producer="worker-ai",
                producer_version="1.0.0",
                tenant_id=uuid.UUID(tenant_id),
                correlation_id=uuid.UUID(job.correlation_id),
                causation_id=uuid.UUID(job.correlation_id),
                aggregate_type="character",
                aggregate_id=uuid.UUID(character_id),
                book_id=uuid.UUID(job.book_id),
                job_id=uuid.UUID(job_id),
                payload={
                    "character_id": character_id,
                    "display_name": mention.surface_form,
                    "status": "PROVISIONAL",
                    "detection_confidence": mention.confidence,
                    "first_appearance_chapter_id": chapter_id,
                    "evidence_paragraph_ids": mention.evidence_paragraph_ids[:20],
                },
            )

        paragraph_by_id = {p.id: p for p in paragraphs}
        last_scene_participants: list[str] = []
        last_scene_pov: str | None = None
        last_scene_max_spine = chapter.spine_end

        for scene in result.scenes:
            spine_positions = [
                paragraph_by_id[pid].spine_position
                for pid in scene.paragraph_ids
                if pid in paragraph_by_id
            ]
            scene_id = await writes_scene.create_scene(
                session,
                tenant_id=tenant_id,
                book_id=job.book_id,
                book_version_id=book_version_id,
                chapter_id=chapter_id,
                order_index=scene.order_index,
                start_paragraph_id=scene.start_paragraph_id,
                end_paragraph_id=scene.end_paragraph_id,
                paragraph_count=len(scene.paragraph_ids),
                spine_start=min(spine_positions) if spine_positions else chapter.spine_start,
                spine_end=max(spine_positions) if spine_positions else chapter.spine_end,
            )
            pov_character_id = (
                key_to_character_id.get(scene.pov_character_key)
                if scene.pov_character_key
                else None
            )
            semantics_id = await writes_scene.create_scene_semantics(
                session,
                tenant_id=tenant_id,
                book_id=job.book_id,
                scene_id=scene_id,
                story_bible_version_id=story_bible_version_id,
                summary=scene.summary,
                in_story_time=scene.in_story_time,
                mood=scene.mood,
                tension=scene.tension,
                pov_character_id=pov_character_id,
                narrative_state_id=None,
                model_version_id=model_version_id,
                confidence=scene.confidence,
            )
            participant_ids: list[str] = []
            for participant_key in scene.participant_keys:
                participant_character_id = key_to_character_id.get(participant_key)
                if not participant_character_id:
                    continue
                participant_ids.append(participant_character_id)
                await writes_scene.create_scene_participant(
                    session,
                    scene_semantics_id=semantics_id,
                    character_id=participant_character_id,
                    speaking=(participant_key == scene.pov_character_key),
                )
            last_scene_participants = participant_ids
            last_scene_pov = pov_character_id
            if spine_positions:
                last_scene_max_spine = max(spine_positions)

        if result.scenes:
            await writes_scene.create_narrative_state(
                session,
                tenant_id=tenant_id,
                book_id=job.book_id,
                book_version_id=book_version_id,
                story_bible_version_id=story_bible_version_id,
                chapter_id=chapter_id,
                scene_id=None,
                spine_position=last_scene_max_spine,
                checkpoint_kind="CHAPTER_BOUNDARY",
                pov_character_id=last_scene_pov,
                pov_type=result.pov_type,
                present_character_ids=last_scene_participants,
                unresolved_thread_ids=[],
                model_version_id=model_version_id,
            )

        staged_relationships = [
            {
                **relationship.model_dump(exclude={"source_key", "target_key"}),
                "source_character_id": key_to_character_id.get(relationship.source_key),
                "target_character_id": key_to_character_id.get(relationship.target_key),
            }
            for relationship in result.relationships
            if key_to_character_id.get(relationship.source_key)
            and key_to_character_id.get(relationship.target_key)
        ]
        staged_locations = [location.model_dump() for location in result.locations]

        next_job_id = str(new_id())
        root_job_id = str(payload.get("root_job_id", job_id))
        await writes_scene.create_child_job(
            session,
            job_id=next_job_id,
            tenant_id=tenant_id,
            book_id=job.book_id,
            job_type="build_story_bible_delta",
            parent_job_id=root_job_id,
            related_resource_id=book_version_id,
            scope={"chapter_id": chapter_id, "relationship_count": len(staged_relationships)},
            idempotency_key=f"story_bible:{story_bible_version_id}:{chapter_id}:{model_version_id}",
            idempotency_fingerprint=book_version.content_hash,
            correlation_id=job.correlation_id,
        )

        await writes_scene.mark_job_succeeded(
            session,
            job_id,
            result_resource_type="story_bible_version",
            result_resource_id=story_bible_version_id,
        )

    # ---- Enqueue only after the transaction above has committed ---------------------
    await queue_producer.enqueue(
        job_name="build_story_bible_delta",
        job_id=next_job_id,
        correlation_id=job.correlation_id,
        causation_id=job.correlation_id,
        tenant_id=tenant_id,
        entity_id=next_job_id,
        payload={
            "book_id": job.book_id,
            "book_version_id": book_version_id,
            "chapter_id": chapter_id,
            "story_bible_version_id": story_bible_version_id,
            "spine_position": last_scene_max_spine,
            "relationships": staged_relationships,
            "locations": staged_locations,
            "remaining_chapter_ids": payload.get("remaining_chapter_ids", []),
            "root_job_id": root_job_id,
            "analysis_mode": payload.get("analysis_mode", "INCREMENTAL"),
            "chapters_total": chapters_total,
        },
    )
    log.info(
        "analyze_scene.completed",
        job_id=job_id,
        chapter_id=chapter_id,
        characters_found=len(result.characters),
        scenes_found=len(result.scenes),
    )

