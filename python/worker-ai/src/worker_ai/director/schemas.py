"""Structured input/output contracts for one-chunk performance interpretation.

Mirrors `semantic/schemas.py`'s approach exactly: a `DirectorModelProvider`
(deterministic or LLM-backed) returns a `PerformanceDecision`, and Pydantic
rejects anything that does not match it -- malformed output never reaches
persistence. Enum members are copied verbatim from `prisma/schema.prisma`
(`Emotion`, `DeliveryMode`) so a decision can be written directly without a
translation table drifting from the DB.

Deliberately absent from `PerformanceDecision`: `speaker_type`/`character_id`.
`director-specification.md` §11.3's speaker-resolution algorithm is
deterministic-first, and even its one LLM-consulted strategy (turn 6, LLM
adjudication) is restricted to candidates already in the Character Registry --
the model is never the origin of a speaker identity. Speaker resolution is a
separate module (`speaker_resolver.py`) whose result is passed IN to the
provider as context, never asked of it.

Also deliberately absent: `pronunciation_hints`. Matching a book's
`PronunciationEntry` lexicon against a chunk's text is a deterministic
substring-match problem, not a performance-interpretation one -- computed in
`ir_builder.py`, not asked of the model.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# Verbatim from `prisma/schema.prisma`'s `Emotion` enum (17 members, closed
# vocabulary owned by `director-specification.md` §4.1).
EmotionLiteral = Literal[
    "NEUTRAL",
    "HAPPY",
    "SAD",
    "GRIEF",
    "ANGRY",
    "FEARFUL",
    "SURPRISED",
    "DISGUSTED",
    "EXCITED",
    "CALM",
    "TENSE",
    "ANXIOUS",
    "SOMBER",
    "CONFIDENT",
    "UNCERTAIN",
    "PLAYFUL",
    "SERIOUS",
]

# Verbatim from `prisma/schema.prisma`'s `DeliveryMode` enum (8 members).
DeliveryModeLiteral = Literal[
    "NORMAL",
    "INTERNAL_THOUGHT",
    "WHISPER",
    "SHOUT",
    "LAUGHING",
    "CRYING",
    "SINGING",
    "READING_ALOUD",
]

SpeakerTypeLiteral = Literal["NARRATOR", "CHARACTER", "UNKNOWN", "SYSTEM"]

PausePositionLiteral = Literal["LEADING", "TRAILING", "OFFSET"]
PauseKindLiteral = Literal[
    "BEAT", "SENTENCE", "PARAGRAPH", "DRAMATIC", "SCENE_TRANSITION", "SPEAKER_TRANSITION"
]
BreathLiteral = Literal["NONE", "NATURAL", "AUDIBLE", "HEAVY"]
NonVerbalExpressionLiteral = Literal[
    "LAUGH", "SIGH", "GASP", "SOB", "GROAN", "BREATH", "THROAT_CLEAR", "HESITATION"
]
NonVerbalPlacementLiteral = Literal["BEFORE", "AFTER", "OVERLAY"]

# Numeric bounds/baselines/quantization -- verbatim from
# `director-specification.md` §4.3's table. A single `0.01` step applies to
# every bounded field.
PACING_MIN, PACING_MAX, PACING_BASELINE = 0.50, 2.00, 1.00
PITCH_MIN, PITCH_MAX, PITCH_BASELINE = -1.00, 1.00, 0.00
VOLUME_MIN, VOLUME_MAX, VOLUME_BASELINE = -1.00, 1.00, 0.00
QUANTIZATION_STEP = 0.01
UNKNOWN_SPEAKER_RATE_THRESHOLD = 0.02  # §14.3's illustrative circuit-breaker


class _Strict(BaseModel):
    """Unknown fields are a validation error, not silently dropped data --
    matches `semantic/schemas.py`'s `_Strict` base for the same reason."""

    model_config = ConfigDict(extra="forbid", frozen=True)


# --------------------------------------------------------------------------- #
# Performance-instruction sub-objects (audio-script-ir.md §22-27)
# --------------------------------------------------------------------------- #


class Pause(_Strict):
    position: PausePositionLiteral
    offset_chars: int | None = None
    duration_ms: int = Field(ge=0)
    kind: PauseKindLiteral = "BEAT"
    breath: BreathLiteral = "NONE"


class Emphasis(_Strict):
    offset_chars: int = Field(ge=0)
    length_chars: int = Field(ge=1)
    strength: float = Field(ge=0.0, le=1.0)


class PronunciationHint(_Strict):
    offset_chars: int = Field(ge=0)
    length_chars: int = Field(ge=1)
    lexicon_key: str | None = None
    ipa: str | None = None
    reason: Literal[
        "PROPER_NOUN", "FOREIGN_WORD", "HOMOGRAPH", "ABBREVIATION", "ACRONYM",
        "INVENTED_WORD", "DOMAIN_TERM",
    ]


class NonVerbal(_Strict):
    offset_chars: int = Field(ge=0)
    length_chars: int = Field(ge=0)
    expression: NonVerbalExpressionLiteral
    intensity: float = Field(ge=0.0, le=1.0)
    placement: NonVerbalPlacementLiteral


class DecisionConfidence(_Strict):
    speaker: float | None = Field(default=None, ge=0.0, le=1.0)
    emotion: float | None = Field(default=None, ge=0.0, le=1.0)
    pronunciation: float | None = Field(default=None, ge=0.0, le=1.0)


# --------------------------------------------------------------------------- #
# Provider input
# --------------------------------------------------------------------------- #


class SpeakerContext(_Strict):
    """The ALREADY-RESOLVED speaker, handed to the provider as a fact, never
    a question. `speaker_resolver.py` produces this before the provider is
    ever called (director-specification.md §11.6: "resolution never mutates
    the registry" and is never delegated wholesale to the model)."""

    speaker_type: SpeakerTypeLiteral
    character_id: str | None = None
    display_name: str | None = None
    speech_traits: dict[str, object] | None = None


class SceneContext(_Strict):
    summary: str | None = None
    mood: str | None = None
    tension: float | None = Field(default=None, ge=0.0, le=1.0)


class PreviousPerformanceState(_Strict):
    """The tail of L5 (`director-specification.md` §5.1) -- what the PRECEDING
    chunk resolved to, so emotion/pacing/pitch/volume for this chunk can be
    "a plausible next step" (§41.2) rather than an independent per-chunk
    draw. `None` at the start of a chapter/scene, never fabricated."""

    speaker_character_id: str | None = None
    emotion: EmotionLiteral | None = None
    emotion_intensity: float | None = Field(default=None, ge=0.0, le=1.0)
    pacing: float | None = Field(default=None, ge=PACING_MIN, le=PACING_MAX)
    pitch: float | None = Field(default=None, ge=PITCH_MIN, le=PITCH_MAX)
    volume: float | None = Field(default=None, ge=VOLUME_MIN, le=VOLUME_MAX)
    delivery_mode: DeliveryModeLiteral | None = None


class PerformanceChunkInput(_Strict):
    chunk_id: str
    text: str
    is_dialogue_hint: bool = Field(
        description="Structural (quotation-boundary) hint from the chunker -- "
        "evidence, not a directive the provider must agree with."
    )
    speaker: SpeakerContext
    scene: SceneContext | None = None
    previous_state: PreviousPerformanceState | None = None


# --------------------------------------------------------------------------- #
# Provider output
# --------------------------------------------------------------------------- #


class PerformanceDecision(_Strict):
    is_dialogue: bool
    delivery_mode: DeliveryModeLiteral
    emotion: EmotionLiteral
    emotion_intensity: float = Field(ge=0.0, le=1.0)
    pacing: float = Field(ge=PACING_MIN, le=PACING_MAX)
    pitch: float = Field(ge=PITCH_MIN, le=PITCH_MAX)
    volume: float = Field(ge=VOLUME_MIN, le=VOLUME_MAX)
    pauses: list[Pause] = Field(default_factory=list)
    emphasis: list[Emphasis] = Field(default_factory=list)
    non_verbal: list[NonVerbal] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    decision_confidence: DecisionConfidence | None = None


class ModelIdentity(_Strict):
    """The (role, provider_id, model_id, version) tuple a `ModelVersion` row
    is looked up by -- same shape `semantic/schemas.py`'s `ModelIdentity`
    uses, resolved by `worker_ai.repo.model_registry.resolve_model_version_id`."""

    role: Literal["LLM"] = "LLM"
    provider_id: str
    model_id: str
    version: str
