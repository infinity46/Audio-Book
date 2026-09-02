"""Deterministic-first speaker resolution: `director-specification.md` §11.3's
seven-strategy ordered algorithm, verbatim in spirit.

Strategies 1-5 are pure text/registry evidence, no model call. Strategy 6
("LLM adjudication") is deliberately implemented here as a deterministic
sole-remaining-candidate inference rather than an actual model call: the
spec restricts even the LLM step to "candidates FROM the existing registry
only -- never inventing a name" (§11.3), and when exactly one scene
participant remains plausible, a deterministic pick satisfies that
constraint at least as strictly as a model call would, without spending a
request on a already-determined answer. When more than one candidate remains
plausible and no stronger evidence resolved it, strategy 7 (`UNKNOWN_SPEAKER`
fallback) fires -- "a legitimate, expected outcome, not a failure state"
(§11.5), never a random pick among the candidates (task §21).

Resolution never mutates the Character Registry (§11.6) -- this module only
reads `KnownSpeaker` rows the context builder already prepared.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from worker_ai.director.chunker import ChunkSpan
from worker_ai.director.schemas import SpeakerTypeLiteral

_SPEAKER_AFTER_RE = re.compile(
    r"[,\"'”’]\s*(?:said|asked|replied|shouted|whispered|muttered|cried|answered|"  # noqa: RUF001 - matching curly closing quotes in source prose, not a typo
    r"called|murmured|snapped|breathed|laughed|sobbed)\s+([A-Z][a-zA-Z']+(?:\s+[A-Z][a-zA-Z']+)?)",
)
_SPEAKER_BEFORE_RE = re.compile(
    r"\b([A-Z][a-zA-Z']+(?:\s+[A-Z][a-zA-Z']+)?)\s+"
    r"(?:said|asked|replied|shouted|whispered|muttered|cried|answered|called|murmured|"
    r"snapped|breathed|laughed|sobbed)\b",
)
_PRONOUN_RE = re.compile(r"\b(he|she|they|him|her|them)\b", re.IGNORECASE)
_ATTRIBUTION_WINDOW = 80  # chars of paragraph text scanned before/after the span


@dataclass(frozen=True, slots=True)
class KnownSpeaker:
    """One resolvable identity for this chapter's scene: a real character or
    a sentinel (`NARRATOR`/`UNKNOWN_SPEAKER`/`MULTIPLE_SPEAKERS`/`SYSTEM`)."""

    character_id: str
    display_name: str
    normalized_names: frozenset[str]  # display name + every alias, normalized
    speech_traits: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class SentinelIds:
    narrator: str
    unknown_speaker: str
    multiple_speakers: str
    system: str


@dataclass(frozen=True, slots=True)
class ResolvedSpeaker:
    speaker_type: SpeakerTypeLiteral
    character_id: str
    confidence: float
    strategy: str


def _normalize(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip().lower())


def resolve_speaker(
    span: ChunkSpan,
    *,
    paragraph_text: str,
    known_speakers: list[KnownSpeaker],
    scene_participant_ids: frozenset[str],
    previous_speaker_id: str | None,
    sentinels: SentinelIds,
) -> ResolvedSpeaker:
    if not span.is_dialogue_hint:
        return ResolvedSpeaker(
            speaker_type="NARRATOR",
            character_id=sentinels.narrator,
            confidence=1.0,
            strategy="NARRATION",
        )

    window_start = max(0, span.char_start - _ATTRIBUTION_WINDOW)
    window_end = min(len(paragraph_text), span.char_end + _ATTRIBUTION_WINDOW)
    window = paragraph_text[window_start:window_end]
    by_name = {n: ks for ks in known_speakers for n in ks.normalized_names}

    # Strategy 1: explicit attribution (a speech tag immediately adjacent to
    # this quoted span).
    for pattern in (_SPEAKER_AFTER_RE, _SPEAKER_BEFORE_RE):
        match = pattern.search(window)
        if match:
            candidate = by_name.get(_normalize(match.group(1)))
            if candidate:
                return ResolvedSpeaker(
                    "CHARACTER", candidate.character_id, 0.95, "EXPLICIT_ATTRIBUTION"
                )

    # Strategies 2-3: alias match anywhere in the attribution window, scoped
    # to characters present in this scene when the participant set is known.
    scoped = [
        ks for ks in known_speakers if ks.character_id in scene_participant_ids
    ] or known_speakers
    window_normalized = _normalize(window)
    exact_hits = [
        ks for ks in scoped if any(n in window_normalized for n in ks.normalized_names)
    ]
    if len(exact_hits) == 1:
        strategy = (
            "SCOPED_ALIAS_MATCH" if len(scoped) < len(known_speakers) else "EXACT_ALIAS_MATCH"
        )
        return ResolvedSpeaker("CHARACTER", exact_hits[0].character_id, 0.75, strategy)

    plausible = scoped if scene_participant_ids else known_speakers
    other_participants = [
        ks for ks in plausible if ks.character_id != previous_speaker_id
    ]

    # Strategies 4-5: a pronoun cue, or plain two-participant turn-taking --
    # both resolve to "whoever isn't the previous speaker" among the
    # currently plausible participants.
    has_pronoun = bool(_PRONOUN_RE.search(window))
    if previous_speaker_id is not None and len(other_participants) == 1:
        strategy = "PRONOUN_RESOLUTION" if has_pronoun else "TURN_TAKING"
        return ResolvedSpeaker("CHARACTER", other_participants[0].character_id, 0.6, strategy)

    # Strategy 6: exactly one plausible candidate remains even without a
    # turn-taking signal -- a deterministic stand-in for "LLM adjudication
    # restricted to registry candidates" (see module docstring).
    if len(plausible) == 1:
        return ResolvedSpeaker(
            "CHARACTER", plausible[0].character_id, 0.55, "SOLE_PARTICIPANT_INFERENCE"
        )

    # Strategy 7: fallback. Never a random pick among ambiguous candidates.
    return ResolvedSpeaker("UNKNOWN", sentinels.unknown_speaker, 0.0, "UNRESOLVED_FALLBACK")
