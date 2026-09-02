"""`director/validation.py`: coverage, the unknown-speaker circuit breaker,
and mid-scene voice consistency -- the hard-failure checks that gate an
`AudioScript` reaching `VALIDATED` (director-specification.md §39-40).
"""

from __future__ import annotations

import pytest

from worker_ai.director.ir_builder import BuiltChunk
from worker_ai.director.validation import (
    UNKNOWN_SPEAKER_RATE_THRESHOLD,
    DirectorValidationError,
    compute_unknown_speaker_rate,
    validate_coverage,
    validate_unknown_speaker_rate,
    validate_voice_consistency,
)
from worker_ai.repo.reads_director import DirectorParagraphRow


def _paragraph(pid: str, text: str) -> DirectorParagraphRow:
    return DirectorParagraphRow(
        id=pid, order_index=0, spine_position=0, chapter_id="ch1", scene_id="scene1", text=text
    )


def _chunk(paragraph_id: str, start: int, end: int, **fields: object) -> BuiltChunk:
    return BuiltChunk(
        fields={"speaker_type": "NARRATOR", **fields},
        source={
            "paragraph_id": paragraph_id,
            "paragraph_char_start": start,
            "paragraph_char_end": end,
        },
    )


def test_full_coverage_no_gap_no_overlap() -> None:
    paragraphs = [_paragraph("p1", "Hello world, this is a test.")]
    chunks = [
        _chunk("p1", 0, 12),
        _chunk("p1", 12, 29),
    ]
    result = validate_coverage(paragraphs, chunks)
    assert result.verified is True
    assert result.gap_count == 0
    assert result.overlap_count == 0


def test_detects_a_gap() -> None:
    paragraphs = [_paragraph("p1", "Hello world, this is a test.")]
    chunks = [_chunk("p1", 0, 5), _chunk("p1", 10, 29)]  # chars 5-10 uncovered
    result = validate_coverage(paragraphs, chunks)
    assert result.verified is False
    assert result.gap_count >= 1


def test_detects_an_overlap() -> None:
    paragraphs = [_paragraph("p1", "Hello world, this is a test.")]
    chunks = [_chunk("p1", 0, 15), _chunk("p1", 10, 29)]  # chars 10-15 double-covered
    result = validate_coverage(paragraphs, chunks)
    assert result.verified is False
    assert result.overlap_count >= 1


def test_detects_a_missing_paragraph_entirely() -> None:
    paragraphs = [_paragraph("p1", "First."), _paragraph("p2", "Second.")]
    chunks = [_chunk("p1", 0, 6)]  # p2 never chunked at all
    result = validate_coverage(paragraphs, chunks)
    assert result.verified is False
    assert result.gap_count >= 1


def test_unknown_speaker_rate_below_threshold_passes() -> None:
    chunks = [_chunk("p1", 0, 1, speaker_type="CHARACTER") for _ in range(100)]
    chunks[0] = _chunk("p1", 0, 1, speaker_type="UNKNOWN")
    assert compute_unknown_speaker_rate(chunks) == pytest.approx(0.01)
    validate_unknown_speaker_rate(chunks)  # must not raise -- 1% < 2% threshold


def test_unknown_speaker_rate_above_threshold_raises() -> None:
    chunks = [_chunk("p1", 0, 1, speaker_type="CHARACTER") for _ in range(100)]
    for i in range(5):  # 5% > the 2% threshold
        chunks[i] = _chunk("p1", 0, 1, speaker_type="UNKNOWN")
    assert compute_unknown_speaker_rate(chunks) > UNKNOWN_SPEAKER_RATE_THRESHOLD
    with pytest.raises(DirectorValidationError) as exc_info:
        validate_unknown_speaker_rate(chunks)
    assert exc_info.value.error_code == "DIRECTOR_VALIDATION_FAILED"


def test_stable_voice_within_a_scene_passes() -> None:
    chunks = [
        _chunk("p1", 0, 1, scene_id="scene1", character_id="alice", voice_profile_version_id="v1"),
        _chunk("p1", 1, 2, scene_id="scene1", character_id="alice", voice_profile_version_id="v1"),
    ]
    validate_voice_consistency(chunks)  # must not raise


def test_voice_change_mid_scene_without_reassignment_raises() -> None:
    chunks = [
        _chunk("p1", 0, 1, scene_id="scene1", character_id="alice", voice_profile_version_id="v1"),
        _chunk("p1", 1, 2, scene_id="scene1", character_id="alice", voice_profile_version_id="v2"),
    ]
    with pytest.raises(DirectorValidationError) as exc_info:
        validate_voice_consistency(chunks)
    assert exc_info.value.error_code == "VOICE_CONSISTENCY_VIOLATION"


def test_voice_change_across_different_scenes_is_allowed() -> None:
    chunks = [
        _chunk("p1", 0, 1, scene_id="scene1", character_id="alice", voice_profile_version_id="v1"),
        _chunk("p2", 0, 1, scene_id="scene2", character_id="alice", voice_profile_version_id="v2"),
    ]
    validate_voice_consistency(chunks)  # must not raise -- different scenes
