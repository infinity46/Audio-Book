"""Consumes `build_story_bible_delta` -- integrates one chapter's staged relationship
and location candidates (produced by `analyze_scene`, see that handler's module
docstring for the split of responsibility) into the cumulative `StoryBibleVersion`,
then either advances to the next chapter's `analyze_scene` or finalizes the run.

## Contradiction handling

The approved schema (`prisma/schema.prisma`) has no generic "fact" table and no
`POSSIBLE_CONTRADICTION` column or table -- `character_relationship` rows are a flat,
versioned edge list keyed by `(pair, relationship_type, valid_from_spine)`. Two
DIFFERENT relationship types proposed for the SAME character pair from the SAME
chapter's evidence (i.e., the exact same temporal context) are the one case this
schema lets us represent honestly as a genuine conflict rather than a claim of change
over time: the task instruction is "preserve both source claims... assign confidence...
allow human review" (task §55), so both rows are inserted (never one silently dropped),
their confidence is lowered, and a `contradiction.detected` structured log line records
the pair -- there is no dedicated event or table for this to write into instead
(honest limitation, not silently invented infrastructure).

A relationship claim recurring across DIFFERENT chapters is NOT a contradiction: the
schema's own versioned-edge-list design means "Alice and Bob were friends, then became
rivals" is two rows with different `valid_from_spine`, both correct simultaneously for
their respective spine ranges (task §53/§121, director-specification.md §4.4's own
reading rule: "read relationship context for the current spine position, never a
single 'current' relationship").
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from worker_ai.queue_producer import QueueProducer
from worker_ai.repo import reads, story_bible, writes_bible, writes_scene
from workers_common.events import new_id, write_outbox_message
from workers_common.logging import get_logger
from workers_common.queue import JobContext

log = get_logger(__name__)

_CONTRADICTION_CONFIDENCE_CEILING = 0.4


async def handle_build_story_bible_delta(ctx: JobContext, *, queue_producer: QueueProducer) -> None:
    payload: dict[str, Any] = ctx.envelope.payload
    job_id = str(ctx.envelope.job_id)
    tenant_id = str(ctx.envelope.tenant_id)
    book_id = str(payload["book_id"])
    book_version_id = str(payload["book_version_id"])
    story_bible_version_id = str(payload["story_bible_version_id"])
    chapter_id = str(payload["chapter_id"])
    spine_position = int(payload.get("spine_position", 0))
    remaining_chapter_ids: list[str] = list(payload.get("remaining_chapter_ids", []))
    chapters_total = int(payload.get("chapters_total", 1))

    next_job_id: str | None = None
    next_chapter_id: str | None = None
    is_last_chapter = len(remaining_chapter_ids) == 0

    async with ctx.db.session() as session:
        job = await reads.load_job(session, job_id)
        if job is None:
            log.error("job.not_found", job_id=job_id)
            return
        if job.status in ("SUCCEEDED", "FAILED"):
            log.info("job.already_terminal_skip", job_id=job_id, status=job.status)
            return
        await writes_scene.mark_job_running(session, job_id)

        version = await story_bible.get_story_bible_version(session, story_bible_version_id)
        if version is None:
            raise ValueError(f"StoryBibleVersion {story_bible_version_id} not found")
        model_version_id = version.built_by_model_version_id

        await _integrate_relationships(
            session,
            tenant_id=tenant_id,
            book_id=book_id,
            story_bible_version_id=story_bible_version_id,
            relationships=payload.get("relationships", []),
            spine_position=spine_position,
            model_version_id=model_version_id,
        )
        await _integrate_locations(
            session,
            tenant_id=tenant_id,
            book_id=book_id,
            story_bible_version_id=story_bible_version_id,
            locations=payload.get("locations", []),
            model_version_id=model_version_id,
        )

        await story_bible.record_chapter_progress(
            session,
            book_id=book_id,
            tenant_id=tenant_id,
            story_bible_version_id=story_bible_version_id,
            chapters_analyzed_delta=1,
            spine_position_analyzed=spine_position,
            chapters_covered_delta=1,
            spine_position_covered=spine_position,
        )

        if is_last_chapter:
            await story_bible.finalize_story_bible(
                session,
                book_id=book_id,
                tenant_id=tenant_id,
                story_bible_version_id=story_bible_version_id,
            )
            await writes_scene.mark_job_succeeded(
                session,
                job_id,
                result_resource_type="story_bible_version",
                result_resource_id=story_bible_version_id,
            )
            await _finalize_root_job(session, root_job_id=str(payload.get("root_job_id", job_id)))
            await _write_analysis_completed_event(
                session,
                tenant_id=tenant_id,
                book_id=book_id,
                book_version_id=book_version_id,
                story_bible_version_id=story_bible_version_id,
                job_id=job_id,
                correlation_id=job.correlation_id,
            )
        else:
            next_chapter_id = remaining_chapter_ids[0]
            next_chapter = await reads.load_chapter(session, next_chapter_id)
            if next_chapter is None:
                raise ValueError(f"Chapter {next_chapter_id} not found")
            next_job_id = str(new_id())
            root_job_id = str(payload.get("root_job_id", job_id))
            book_version = await reads.load_book_version(session, book_version_id)
            fingerprint = book_version.content_hash if book_version else story_bible_version_id
            analysis_mode = str(payload.get("analysis_mode", "INCREMENTAL"))
            await writes_scene.create_child_job(
                session,
                job_id=next_job_id,
                tenant_id=tenant_id,
                book_id=book_id,
                job_type="analyze_scene",
                parent_job_id=root_job_id,
                related_resource_id=book_version_id,
                scope={"chapter_id": next_chapter_id},
                idempotency_key=(
                    f"analyze_scene:{book_version_id}:{next_chapter_id}:{analysis_mode}"
                ),
                idempotency_fingerprint=fingerprint,
                correlation_id=job.correlation_id,
            )
            await writes_scene.mark_job_succeeded(
                session,
                job_id,
                result_resource_type="story_bible_version",
                result_resource_id=story_bible_version_id,
            )

    if next_job_id is not None and next_chapter_id is not None:
        next_chapter_row = await _reload_chapter(ctx, next_chapter_id)
        await queue_producer.enqueue(
            job_name="analyze_scene",
            job_id=next_job_id,
            correlation_id=job.correlation_id,
            causation_id=job.correlation_id,
            tenant_id=tenant_id,
            entity_id=next_job_id,
            payload={
                "book_id": book_id,
                "book_version_id": book_version_id,
                "chapter_id": next_chapter_id,
                "spine_start": next_chapter_row.spine_start if next_chapter_row else 0,
                "spine_end": next_chapter_row.spine_end if next_chapter_row else 0,
                "story_bible_version_id": story_bible_version_id,
                "analysis_mode": payload.get("analysis_mode", "INCREMENTAL"),
                "remaining_chapter_ids": remaining_chapter_ids[1:],
                "root_job_id": payload.get("root_job_id", job_id),
                "chapters_total": chapters_total,
            },
        )

    log.info(
        "build_story_bible_delta.completed",
        job_id=job_id,
        chapter_id=chapter_id,
        finalized=is_last_chapter,
    )


async def _reload_chapter(ctx: JobContext, chapter_id: str) -> reads.ChapterRow | None:
    async with ctx.db.session() as session:
        return await reads.load_chapter(session, chapter_id)


async def _integrate_relationships(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    story_bible_version_id: str,
    relationships: list[dict[str, Any]],
    spine_position: int,
    model_version_id: str,
) -> None:
    # Group this chapter's staged candidates by character pair so a same-chapter,
    # same-pair, different-type conflict can be detected before anything is written.
    by_pair: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for candidate in relationships:
        source_id = candidate.get("source_character_id")
        target_id = candidate.get("target_character_id")
        if not source_id or not target_id:
            continue
        pair_key = tuple(sorted((source_id, target_id)))
        by_pair.setdefault(pair_key, []).append(candidate)

    for pair_key, candidates in by_pair.items():
        distinct_types = {c["relationship_type"] for c in candidates}
        contradiction = len(distinct_types) > 1
        if contradiction:
            log.warning(
                "contradiction.detected",
                subject="character_relationship",
                pair=pair_key,
                claimed_types=sorted(distinct_types),
                spine_position=spine_position,
            )

        for candidate in candidates:
            source_id = candidate["source_character_id"]
            target_id = candidate["target_character_id"]
            confidence = float(candidate.get("confidence", 0.5))
            if contradiction:
                confidence = min(confidence, _CONTRADICTION_CONFIDENCE_CEILING)

            existing = await writes_bible.find_existing_relationships(
                session,
                story_bible_version_id=story_bible_version_id,
                source_id=source_id,
                target_id=target_id,
            )
            same_type_existing = next(
                (e for e in existing if e.relationship_type == candidate["relationship_type"]), None
            )
            if same_type_existing:
                await writes_bible.extend_relationship_evidence(
                    session, same_type_existing.id, candidate.get("evidence_paragraph_ids", [])
                )
                if contradiction:
                    await writes_bible.lower_relationship_confidence(
                        session, same_type_existing.id, confidence
                    )
                continue

            await writes_bible.create_relationship(
                session,
                tenant_id=tenant_id,
                book_id=book_id,
                story_bible_version_id=story_bible_version_id,
                source_character_id=source_id,
                target_character_id=target_id,
                relationship_type=candidate["relationship_type"],
                label=candidate.get("label"),
                confidence=confidence,
                valid_from_spine=spine_position,
                evidence_paragraph_ids=candidate.get("evidence_paragraph_ids", []),
                evidence_scene_id=None,
                model_version_id=model_version_id,
            )


async def _integrate_locations(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    story_bible_version_id: str,
    locations: list[dict[str, Any]],
    model_version_id: str,
) -> None:
    for candidate in locations:
        name = candidate["name"]
        existing_id = await writes_bible.find_location_by_name(
            session, story_bible_version_id=story_bible_version_id, name=name
        )
        if existing_id:
            continue
        await writes_bible.create_location(
            session,
            tenant_id=tenant_id,
            book_id=book_id,
            story_bible_version_id=story_bible_version_id,
            name=name,
            location_kind=candidate.get("location_kind"),
            confidence=float(candidate.get("confidence", 0.5)),
            evidence_paragraph_ids=candidate.get("evidence_paragraph_ids", []),
            model_version_id=model_version_id,
        )


async def _finalize_root_job(session: AsyncSession, *, root_job_id: str) -> None:
    await session.execute(
        text(
            """
            UPDATE processing_job
            SET status = 'SUCCEEDED', status_changed_at = :now, completed_at = :now,
                progress = 1, updated_at = :now
            WHERE id = :id AND status NOT IN ('SUCCEEDED', 'FAILED')
            """
        ),
        {"id": root_job_id, "now": datetime.now(UTC)},
    )


async def _write_analysis_completed_event(
    session: AsyncSession,
    *,
    tenant_id: str,
    book_id: str,
    book_version_id: str,
    story_bible_version_id: str,
    job_id: str,
    correlation_id: str,
) -> None:
    scenes_count = (
        await session.execute(
            text("SELECT COUNT(*) FROM scene WHERE book_id = :book_id"), {"book_id": book_id}
        )
    ).scalar_one()
    characters_provisional = (
        await session.execute(
            text(
                "SELECT COUNT(*) FROM character WHERE book_id = :book_id AND status = 'PROVISIONAL'"
            ),
            {"book_id": book_id},
        )
    ).scalar_one()
    characters_confirmed = (
        await session.execute(
            text(
                "SELECT COUNT(*) FROM character WHERE book_id = :book_id AND status = 'CONFIRMED'"
            ),
            {"book_id": book_id},
        )
    ).scalar_one()

    await write_outbox_message(
        session,
        event_type="book.analysis_completed",
        schema_version="1.0",
        producer="worker-ai",
        producer_version="1.0.0",
        tenant_id=uuid.UUID(tenant_id),
        correlation_id=uuid.UUID(correlation_id),
        causation_id=uuid.UUID(correlation_id),
        aggregate_type="book_version",
        aggregate_id=uuid.UUID(book_version_id),
        book_id=uuid.UUID(book_id),
        job_id=uuid.UUID(job_id),
        payload={
            "book_version_id": book_version_id,
            "story_bible_version_id": story_bible_version_id,
            "story_bible_snapshot_version": story_bible_version_id,
            "scenes": scenes_count,
            "characters_provisional": characters_provisional,
            "characters_confirmed": characters_confirmed,
            "degraded": False,
        },
    )

    await session.execute(
        text("UPDATE book SET status = 'ANALYZED', status_changed_at = :now WHERE id = :id"),
        {"id": book_id, "now": datetime.now(UTC)},
    )
