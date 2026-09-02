"""`director/chunker.py`: the partition invariant every downstream coverage
check depends on -- every span `chunk_paragraph` returns must, in order,
reconstruct the original paragraph text exactly (contiguous, non-overlapping,
covering the full range), regardless of quote/budget splitting.
"""

from __future__ import annotations

from worker_ai.director.chunker import ChunkSpan, chunk_paragraph


def _assert_partitions(paragraph_id: str, text: str, spans: list[ChunkSpan]) -> None:
    assert "".join(s.text for s in spans) == text
    cursor = 0
    for span in spans:
        assert span.paragraph_id == paragraph_id
        assert span.char_start == cursor
        assert span.char_end == cursor + len(span.text)
        assert text[span.char_start : span.char_end] == span.text
        cursor = span.char_end
    assert cursor == len(text)


def test_empty_paragraph_yields_one_empty_span() -> None:
    spans = chunk_paragraph("p1", "")
    assert len(spans) == 1
    assert spans[0].text == ""
    assert spans[0].is_dialogue_hint is False


def test_plain_narrative_is_one_span() -> None:
    text = "Alice walked into the room and looked around."
    spans = chunk_paragraph("p1", text)
    assert len(spans) == 1
    assert spans[0].text == text
    assert spans[0].is_dialogue_hint is False
    _assert_partitions("p1", text, spans)


def test_dialogue_and_narrative_spans_alternate() -> None:
    text = 'Alice said, "Hello there." Then she turned and left the room.'
    spans = chunk_paragraph("p1", text)
    _assert_partitions("p1", text, spans)
    dialogue_spans = [s for s in spans if s.is_dialogue_hint]
    assert len(dialogue_spans) == 1
    assert dialogue_spans[0].text == '"Hello there."'


def test_paragraph_starting_and_ending_with_dialogue() -> None:
    text = '"Go away." She snapped, turned, and added, "I mean it."'
    spans = chunk_paragraph("p1", text)
    _assert_partitions("p1", text, spans)
    assert spans[0].is_dialogue_hint is True
    assert spans[-1].is_dialogue_hint is True
    assert sum(1 for s in spans if s.is_dialogue_hint) == 2


def test_budget_split_never_drops_content() -> None:
    # No quotes, no sentence boundaries either -- a worst case for the
    # "last resort hard split" path.
    text = "a" * 500
    spans = chunk_paragraph("p1", text, max_chars=100)
    assert len(spans) == 5
    _assert_partitions("p1", text, spans)
    for span in spans:
        assert len(span.text) <= 100


def test_budget_split_prefers_sentence_boundaries() -> None:
    sentence = "This is a sentence that repeats. "
    text = sentence * 20  # well over a small budget
    spans = chunk_paragraph("p1", text, max_chars=120)
    _assert_partitions("p1", text, spans)
    for span in spans:
        assert len(span.text) <= 120
    # Splits should land on sentence boundaries, not mid-word, wherever the
    # budget comfortably allows it.
    assert all(span.text.strip() == "" or span.text.rstrip().endswith(".") for span in spans)
