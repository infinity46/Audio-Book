"""Post-generation validation: coverage, the unknown-speaker circuit breaker,
and mid-scene voice consistency (`director-specification.md` §39-40).

Deliberately separate from `ir_builder.py`: that module computes PER-CHUNK
quality annotations (review flags, fallback reasons) from evidence already
available when the chunk is built; this module checks properties that only
make sense across the WHOLE run (or a whole scene) once every chunk for the
scope exists. Both are required (task §99: "schema validation" is distinct
from "continuity/semantic validation").

Two failure classes, matching `director-specification.md` §54.1's taxonomy:
  * `DirectorValidationError` -- hard failure, the run does not reach
    `VALIDATED` (`DIRECTOR_SOURCE_COVERAGE_FAILED`, `VOICE_CONSISTENCY_
    VIOLATION`, unknown-speaker-rate exceeded).
  * everything else is a review flag already attached by `ir_builder.py` --
    "review", never a hard block (§14.2, §40.2's unmotivated-emotion-jump
    row).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast

from worker_ai.director.ir_builder import BuiltChunk
from worker_ai.repo.reads_director import DirectorParagraphRow

# Illustrative, configurable threshold (director-specification.md §14.3):
# above this fraction of chunks in scope resolving to `UNKNOWN_SPEAKER`,
# the run is a hard validation failure rather than a per-chunk review flag.
UNKNOWN_SPEAKER_RATE_THRESHOLD = 0.02


class DirectorValidationError(Exception):
    def __init__(self, message: str, *, error_code: str) -> None:
        super().__init__(message)
        self.error_code = error_code


@dataclass(frozen=True, slots=True)
class CoverageResult:
    verified: bool
    gap_count: int
    overlap_count: int


def validate_coverage(
    paragraphs: list[DirectorParagraphRow], chunks: list[BuiltChunk]
) -> CoverageResult:
    """Every paragraph's `[0, len(text))` range must be covered by its
    chunks' source spans exactly once -- no gap, no duplicate (task §68-69).
    """
    spans_by_paragraph: dict[str, list[tuple[int, int]]] = {}
    for chunk in chunks:
        pid = str(chunk.source["paragraph_id"])
        char_start = cast(int, chunk.source["paragraph_char_start"])
        char_end = cast(int, chunk.source["paragraph_char_end"])
        spans_by_paragraph.setdefault(pid, []).append((char_start, char_end))

    gap_count = 0
    overlap_count = 0
    for paragraph in paragraphs:
        spans = sorted(spans_by_paragraph.get(paragraph.id, []))
        expected_length = len(paragraph.text)
        cursor = 0
        for start, end in spans:
            if start > cursor:
                gap_count += 1
            elif start < cursor:
                overlap_count += 1
            cursor = max(cursor, end)
        if cursor < expected_length:
            gap_count += 1

    return CoverageResult(
        verified=(gap_count == 0 and overlap_count == 0),
        gap_count=gap_count,
        overlap_count=overlap_count,
    )


def compute_unknown_speaker_rate(chunks: list[BuiltChunk]) -> float:
    if not chunks:
        return 0.0
    unknown = sum(1 for c in chunks if c.fields["speaker_type"] == "UNKNOWN")
    return unknown / len(chunks)


def validate_unknown_speaker_rate(chunks: list[BuiltChunk]) -> None:
    rate = compute_unknown_speaker_rate(chunks)
    if rate > UNKNOWN_SPEAKER_RATE_THRESHOLD:
        raise DirectorValidationError(
            f"unknown_speaker_rate {rate:.4f} exceeds threshold "
            f"{UNKNOWN_SPEAKER_RATE_THRESHOLD:.4f} for this scope",
            error_code="DIRECTOR_VALIDATION_FAILED",
        )


def validate_voice_consistency(chunks: list[BuiltChunk]) -> None:
    """Within one scene, the same `character_id` must map to the same
    `voice_profile_version_id` throughout -- a mid-scene change with no
    reassignment event is a hard failure (director-specification.md §40.2),
    never silently accepted."""
    seen: dict[tuple[str, str], str] = {}
    for chunk in chunks:
        scene_id = chunk.fields.get("scene_id")
        character_id = chunk.fields.get("character_id")
        voice_version_id = chunk.fields.get("voice_profile_version_id")
        if scene_id is None or character_id is None or voice_version_id is None:
            continue
        key = (str(scene_id), str(character_id))
        existing = seen.get(key)
        if existing is not None and existing != voice_version_id:
            raise DirectorValidationError(
                f"character {character_id} bound to two different voice profile "
                f"versions within scene {scene_id} with no reassignment event",
                error_code="VOICE_CONSISTENCY_VIOLATION",
            )
        seen[key] = str(voice_version_id)
