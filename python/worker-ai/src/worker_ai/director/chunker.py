"""Splits one paragraph's canonical text into performance units.

Granularity chosen (task §15): a "dialogue span or narrative span" within a
paragraph -- the finest boundary Phase 2/3 actually persist is the
`Paragraph` (there is no sentence- or clause-level canonical row to chunk
against), so a paragraph is split into its alternating quoted-dialogue and
narrative spans, and each span is a candidate `AudioScriptChunk`. This gives
mandatory-boundary behavior (task §10 of audio-script-ir.md) for free:
speaker change happens exactly at a dialogue/narrative span boundary within
a paragraph, and scene/chapter boundaries are never crossed because chunking
runs one paragraph at a time in canonical order.

Every span produced PARTITIONS the paragraph's text exactly -- contiguous,
non-overlapping, covering the full `[0, len(text))` range. That invariant is
what makes coverage validation in `validation.py` a simple sum-of-lengths
check rather than a general interval-set reconciliation.

Only double quotes (straight `"` and curly `“”`) are treated as dialogue
delimiters. Single quotes are deliberately excluded -- English contractions
and possessives ("don't", "Alice's") make single-quote dialogue detection too
false-positive-prone to trust without a much more careful parser than this
phase's scope calls for; a book using single-quote dialogue convention will
have its lines classified as narration, which is a conservative, auditable
degradation (flagged via low speaker confidence downstream), not silent data
loss -- the text itself is never dropped or altered.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_QUOTE_RE = re.compile(r'["“][^"”]*["”]?')
_SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[.!?])\s+")

# A conservative default max chars per chunk absent an explicit token budget
# -- roughly 1000 tokens at ~4 chars/token, comfortably inside every
# provider's `max_input_chars` (tts-provider-specification.md) and any
# reasonable L6 allotment (director-specification.md §6.2).
DEFAULT_MAX_CHARS = 4000


@dataclass(frozen=True, slots=True)
class ChunkSpan:
    """One performance-unit candidate, still paragraph-relative.

    `char_start`/`char_end` are offsets into the OWNING paragraph's `text`
    (not the sub-split text) -- `ir_builder.py` uses these to build the
    `audio_script_chunk_source` row(s) that prove source coverage.
    """

    paragraph_id: str
    char_start: int
    char_end: int
    text: str
    is_dialogue_hint: bool


def chunk_paragraph(
    paragraph_id: str, text: str, *, max_chars: int = DEFAULT_MAX_CHARS
) -> list[ChunkSpan]:
    if text == "":
        return [ChunkSpan(paragraph_id, 0, 0, "", is_dialogue_hint=False)]

    spans: list[tuple[int, int, bool]] = []
    cursor = 0
    for match in _QUOTE_RE.finditer(text):
        if match.start() > cursor:
            spans.append((cursor, match.start(), False))
        spans.append((match.start(), match.end(), True))
        cursor = match.end()
    if cursor < len(text):
        spans.append((cursor, len(text), False))

    result: list[ChunkSpan] = []
    for start, end, is_dialogue in spans:
        result.extend(
            _split_to_budget(paragraph_id, text, start, end, is_dialogue, max_chars)
        )
    return result


def _split_to_budget(
    paragraph_id: str,
    text: str,
    start: int,
    end: int,
    is_dialogue: bool,
    max_chars: int,
) -> list[ChunkSpan]:
    segment = text[start:end]
    if len(segment) <= max_chars:
        return [ChunkSpan(paragraph_id, start, end, segment, is_dialogue)]

    # Over budget: split at sentence boundaries, never truncate (§6.4 -- the
    # bundle is split, content is never dropped). Every character between
    # `start` and `end` still ends up in exactly one resulting span.
    boundaries = [start]
    for m in _SENTENCE_BOUNDARY_RE.finditer(text, start, end):
        boundaries.append(m.end())
    boundaries.append(end)

    result: list[ChunkSpan] = []
    piece_start = start
    for boundary in boundaries[1:]:
        if boundary - piece_start >= max_chars and boundary != boundaries[-1]:
            continue  # keep accumulating sentences until the budget is hit
        if boundary - piece_start > max_chars:
            # A single "sentence" (no boundary found) still exceeds budget --
            # last-resort hard split. Every character is still retained.
            cursor = piece_start
            while cursor < boundary:
                piece_end = min(cursor + max_chars, boundary)
                result.append(
                    ChunkSpan(paragraph_id, cursor, piece_end, text[cursor:piece_end], is_dialogue)
                )
                cursor = piece_end
            piece_start = boundary
            continue
        result.append(
            ChunkSpan(paragraph_id, piece_start, boundary, text[piece_start:boundary], is_dialogue)
        )
        piece_start = boundary
    return [s for s in result if s.char_end > s.char_start]
