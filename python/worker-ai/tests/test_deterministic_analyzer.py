"""Unit tests for the deterministic heuristic `SemanticAnalyzer` (the default provider,
and the only one every automated test in this repository exercises).

These fixtures are small and hand-written specifically to exercise each heuristic --
they are not a claim that the analyzer generalizes to arbitrary prose (see the module
docstring in `deterministic.py`).
"""

from __future__ import annotations

import pytest

from worker_ai.semantic.deterministic import DeterministicSemanticAnalyzer
from worker_ai.semantic.schemas import (
    AnalyzeChapterInput,
    KnownCharacter,
    ParagraphInput,
    PriorContext,
)


def _paragraph(id_: str, order: int, text: str) -> ParagraphInput:
    return ParagraphInput(id=id_, order_index=order, spine_position=order, text=text)


@pytest.mark.asyncio
async def test_detects_recurring_characters_and_dialogue_speaker() -> None:
    paragraphs = [
        _paragraph("p1", 0, "Alice Carter walked into the kitchen and looked around."),
        _paragraph("p2", 1, '"Where is everyone?" said Alice.'),
        _paragraph("p3", 2, "Bob Harrison was waiting by the door, arms crossed."),
        _paragraph("p4", 3, "Bob said, \"I have been here the whole time.\""),
    ]
    analyzer = DeterministicSemanticAnalyzer()
    result = await analyzer.analyze_chapter(
        AnalyzeChapterInput(
            chapter_id="ch1",
            book_id="book1",
            paragraphs=paragraphs,
            prior_context=PriorContext(),
        )
    )

    names = {c.normalized_key for c in result.characters}
    assert "alice carter" in names
    assert "bob harrison" in names

    alice = next(c for c in result.characters if c.normalized_key == "alice carter")
    assert alice.is_speaker
    assert "p1" in alice.evidence_paragraph_ids
    assert "p2" in alice.evidence_paragraph_ids


@pytest.mark.asyncio
async def test_short_form_is_linked_as_alias_of_full_name() -> None:
    paragraphs = [
        _paragraph("p1", 0, "Alice Carter walked into the kitchen."),
        _paragraph("p2", 1, "Alice sat down and sighed."),
        _paragraph("p3", 2, "Alice looked out the window."),
    ]
    analyzer = DeterministicSemanticAnalyzer()
    result = await analyzer.analyze_chapter(
        AnalyzeChapterInput(
            chapter_id="ch1", book_id="book1", paragraphs=paragraphs, prior_context=PriorContext()
        )
    )
    short_form = next(c for c in result.characters if c.normalized_key == "alice")
    assert short_form.alias_type == "GIVEN_NAME"


@pytest.mark.asyncio
async def test_two_different_johns_are_not_silently_merged() -> None:
    """Two distinct multi-word candidates sharing a first token must not collapse into
    one -- the ambiguous-match guard in `_link_short_forms_as_aliases` must skip them."""
    paragraphs = [
        _paragraph("p1", 0, "John Smith arrived first, followed by John Carter."),
        _paragraph("p2", 1, "John Smith greeted John Carter warmly."),
    ]
    analyzer = DeterministicSemanticAnalyzer()
    result = await analyzer.analyze_chapter(
        AnalyzeChapterInput(
            chapter_id="ch1", book_id="book1", paragraphs=paragraphs, prior_context=PriorContext()
        )
    )
    names = {c.normalized_key for c in result.characters}
    assert "john smith" in names
    assert "john carter" in names
    # The bare "john" is ambiguous between the two full names and must not resolve to
    # either -- it should either not appear as its own candidate, or remain distinct.
    if "john" in names:
        bare = next(c for c in result.characters if c.normalized_key == "john")
        assert bare.alias_type != "GIVEN_NAME" or bare.resolved_character_id is None


@pytest.mark.asyncio
async def test_relationship_keyword_detected_between_cooccurring_characters() -> None:
    paragraphs = [
        _paragraph("p1", 0, "Alice Carter and Bob Harrison walked together."),
        _paragraph(
            "p2", 1, "Bob Harrison was Alice Carter's brother, and they rarely disagreed."
        ),
    ]
    analyzer = DeterministicSemanticAnalyzer()
    result = await analyzer.analyze_chapter(
        AnalyzeChapterInput(
            chapter_id="ch1", book_id="book1", paragraphs=paragraphs, prior_context=PriorContext()
        )
    )
    assert any(
        r.relationship_type == "FAMILY" and r.label == "brother" for r in result.relationships
    )


@pytest.mark.asyncio
async def test_scene_break_marker_splits_scenes() -> None:
    paragraphs = [
        _paragraph("p1", 0, "Alice Carter stood in the garden."),
        _paragraph("p2", 1, "* * *"),
        _paragraph("p3", 2, "Bob Harrison sat in the library."),
    ]
    analyzer = DeterministicSemanticAnalyzer()
    result = await analyzer.analyze_chapter(
        AnalyzeChapterInput(
            chapter_id="ch1", book_id="book1", paragraphs=paragraphs, prior_context=PriorContext()
        )
    )
    assert len(result.scenes) == 2
    assert result.scenes[0].paragraph_ids == ["p1"]
    assert result.scenes[1].paragraph_ids == ["p3"]


@pytest.mark.asyncio
async def test_no_scene_break_produces_single_scene() -> None:
    paragraphs = [
        _paragraph("p1", 0, "Alice Carter stood in the garden."),
        _paragraph("p2", 1, "She thought about the letter."),
    ]
    analyzer = DeterministicSemanticAnalyzer()
    result = await analyzer.analyze_chapter(
        AnalyzeChapterInput(
            chapter_id="ch1", book_id="book1", paragraphs=paragraphs, prior_context=PriorContext()
        )
    )
    assert len(result.scenes) == 1
    assert result.scenes[0].paragraph_ids == ["p1", "p2"]


@pytest.mark.asyncio
async def test_known_character_from_prior_context_resolves_instead_of_new_candidate() -> None:
    paragraphs = [_paragraph("p1", 0, "Alice Carter smiled at the news.")]
    analyzer = DeterministicSemanticAnalyzer()
    result = await analyzer.analyze_chapter(
        AnalyzeChapterInput(
            chapter_id="ch1",
            book_id="book1",
            paragraphs=paragraphs,
            prior_context=PriorContext(
                known_characters=[
                    KnownCharacter(id="char-123", display_name="Alice Carter", aliases=["Alice"])
                ]
            ),
        )
    )
    alice = next(c for c in result.characters if c.normalized_key == "alice carter")
    assert alice.resolved_character_id == "char-123"


@pytest.mark.asyncio
async def test_first_person_pov_detected() -> None:
    paragraphs = [
        _paragraph("p1", 0, "I walked into the room and looked at my hands."),
        _paragraph("p2", 1, "I could not believe what I had done to myself."),
    ]
    analyzer = DeterministicSemanticAnalyzer()
    result = await analyzer.analyze_chapter(
        AnalyzeChapterInput(
            chapter_id="ch1", book_id="book1", paragraphs=paragraphs, prior_context=PriorContext()
        )
    )
    assert result.pov_type == "FIRST"


@pytest.mark.asyncio
async def test_empty_chapter_produces_empty_result() -> None:
    analyzer = DeterministicSemanticAnalyzer()
    result = await analyzer.analyze_chapter(
        AnalyzeChapterInput(
            chapter_id="ch1", book_id="book1", paragraphs=[], prior_context=PriorContext()
        )
    )
    assert result.characters == []
    assert result.scenes == []
    assert result.pov_type is None


def test_model_identity_is_stable() -> None:
    analyzer = DeterministicSemanticAnalyzer()
    identity = analyzer.model_identity
    assert identity.provider_id == "audio-book-nlp"
    assert identity.model_id == "deterministic-heuristic-analyzer"
    assert identity.version == "1.0.0"
