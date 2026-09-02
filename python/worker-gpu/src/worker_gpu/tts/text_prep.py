"""Provider-neutral text preparation (§76-§81 of the task brief; §31, §41.2 of the spec).

This is the pipeline's "Text Preparation" stage: it decides *which* text renders (the IR's
`spoken_text` override when present, else `text` — never a third, invented variant) and
carries pronunciation hints alongside it, unmodified. It does not touch spelling,
punctuation, or characters, and it performs no provider-specific transformation — IPA-to-
ARPAbet, SSML `<phoneme>` tags, or any engine's own lexicon syntax happen only inside an
adapter (§31.2, §82). Keeping that split explicit here is what stops a future change from
quietly promoting an adapter-specific normalization into "shared" code that then no longer
matches a second provider's needs.
"""

from __future__ import annotations

from dataclasses import dataclass

from worker_gpu.tts.schemas import PronunciationHint, SynthesisRequest


@dataclass(frozen=True, slots=True)
class PreparedText:
    """The exact text an adapter must render, plus the hints it may apply."""

    text: str
    pronunciation_hints: tuple[PronunciationHint, ...]


def prepare_text(request: SynthesisRequest) -> PreparedText:
    """Resolve the exact source text for one synthesis request.

    `request.text` is already the resolved field by the time it reaches this layer — the
    handler that builds the `SynthesisRequest` from `AudioScriptChunk` picks `spoken_text`
    over `text` when the IR set one (`audio-script-ir.md` §31.1), so this function does not
    re-decide that choice. What it does own: bundling the resolved text with its
    pronunciation hints as one immutable unit an adapter renders from, without ever
    altering a character of either.
    """
    return PreparedText(
        text=request.text,
        pronunciation_hints=request.performance.pronunciation_hints,
    )


__all__ = ["PreparedText", "prepare_text"]
