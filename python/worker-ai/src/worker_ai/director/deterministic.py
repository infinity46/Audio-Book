"""The default `DirectorModelProvider`: lexical/heuristic, deterministic, no
network access. This is what every automated test exercises, and what
`docker-compose.yml`'s `MODEL_ID: stub-director-v0` comment names as the
local/dev/CI default -- "no GPU/LLM backend in local dev".

Same honesty posture as `semantic/deterministic.py`: this makes no claim of
performance-interpretation accuracy. It makes a narrow, inspectable,
reproducible one -- given the same chunk + context, it always returns the
same decision -- with two properties `director-specification.md` requires of
ANY provider: emotional/pacing CONTINUITY (never resets to NEUTRAL absent
evidence, §91) and the exact numeric baselines/bounds of §4.3.

Every heuristic below is independently unit-tested
(`worker-ai/tests/test_deterministic_director.py`) against small fixture
chunks, not claimed to generalize to arbitrary prose.
"""

from __future__ import annotations

import re

from worker_ai.director.analyzer import DirectorModelProvider
from worker_ai.director.schemas import (
    PACING_BASELINE,
    PACING_MAX,
    PACING_MIN,
    PITCH_BASELINE,
    VOLUME_BASELINE,
    DeliveryModeLiteral,
    EmotionLiteral,
    Emphasis,
    ModelIdentity,
    NonVerbal,
    NonVerbalExpressionLiteral,
    Pause,
    PerformanceChunkInput,
    PerformanceDecision,
    PreviousPerformanceState,
    SceneContext,
)

MODEL_IDENTITY = ModelIdentity(
    provider_id="audio-book-director",
    model_id="deterministic-heuristic-director",
    version="1.0.0",
)

# Speech-verb / lexical cues -> delivery mode. Checked in priority order;
# first match wins. Deliberately narrow (task §39: "Use exact approved
# vocabulary... do not create uncontrolled strings" -- and §41 "a shout
# should modify performance/acoustic intent, never rewrite text uppercase").
_DELIVERY_CUES: list[tuple[re.Pattern[str], DeliveryModeLiteral]] = [
    (re.compile(r"\b(whisper(?:ed|s|ing)?|murmur(?:ed|s|ing)?)\b", re.IGNORECASE), "WHISPER"),
    (
        re.compile(
            r"\b(shout(?:ed|s|ing)?|yell(?:ed|s|ing)?|bellow(?:ed|s|ing)?)\b", re.IGNORECASE
        ),
        "SHOUT",
    ),
    (
        re.compile(
            r"\b(laugh(?:ed|s|ing)?|chuckl(?:ed|es|ing)?|giggl(?:ed|es|ing)?)\b", re.IGNORECASE
        ),
        "LAUGHING",
    ),
    (re.compile(r"\b(sob(?:bed|s|bing)?|wept|weeping|cried|crying)\b", re.IGNORECASE), "CRYING"),
    (re.compile(r"\b(sang|sings?|singing)\b", re.IGNORECASE), "SINGING"),
    (re.compile(r"\b(read aloud|recit(?:ed|es|ing))\b", re.IGNORECASE), "READING_ALOUD"),
]

# Lexical cues -> emotion. Checked in priority order; first match wins. Only
# used when no cue fires does continuity (previous_state) take over -- never
# punctuation alone (task §33/§36).
_EMOTION_CUES: list[tuple[re.Pattern[str], EmotionLiteral]] = [
    (re.compile(r"\b(griev(?:e|ed|ing)|mourn(?:ed|ing|s)?|loss of)\b", re.IGNORECASE), "GRIEF"),
    (
        re.compile(r"\b(furious|enraged|angr(?:y|ily)|snarl(?:ed|s|ing)?)\b", re.IGNORECASE),
        "ANGRY",
    ),
    (re.compile(r"\b(afraid|terrified|frighten(?:ed|ing)|scared)\b", re.IGNORECASE), "FEARFUL"),
    (
        re.compile(
            r"\b(gasp(?:ed|s|ing)?|astonish(?:ed|ing)|startled|shocked)\b", re.IGNORECASE
        ),
        "SURPRISED",
    ),
    (
        re.compile(r"\b(disgust(?:ed|ing)|revolt(?:ed|ing)|repuls(?:ed|ive))\b", re.IGNORECASE),
        "DISGUSTED",
    ),
    (
        re.compile(r"\b(thrilled|excited|elated|exhilarat(?:ed|ing))\b", re.IGNORECASE),
        "EXCITED",
    ),
    (re.compile(r"\b(sad(?:ly)?|wept|weeping|sorrow(?:ful)?)\b", re.IGNORECASE), "SAD"),
    (
        re.compile(
            r"\b(happ(?:y|ily)|smil(?:ed|es|ing)|delighted|cheerful)\b", re.IGNORECASE
        ),
        "HAPPY",
    ),
    (re.compile(r"\b(calm(?:ly)?|serene|peaceful|composed)\b", re.IGNORECASE), "CALM"),
    (re.compile(r"\b(tense(?:ly)?|tight(?:ened)?|rigid|braced)\b", re.IGNORECASE), "TENSE"),
    (
        re.compile(r"\b(anxious(?:ly)?|worr(?:ied|ies|y)|nervous(?:ly)?)\b", re.IGNORECASE),
        "ANXIOUS",
    ),
    (re.compile(r"\b(somber(?:ly)?|grim(?:ly)?|bleak)\b", re.IGNORECASE), "SOMBER"),
    (re.compile(r"\b(confident(?:ly)?|assured|resolute)\b", re.IGNORECASE), "CONFIDENT"),
    (
        re.compile(
            r"\b(unsure|uncertain(?:ly)?|hesitant(?:ly)?|doubtful)\b", re.IGNORECASE
        ),
        "UNCERTAIN",
    ),
    (
        re.compile(
            r"\b(playful(?:ly)?|teasing(?:ly)?|mischievous(?:ly)?)\b", re.IGNORECASE
        ),
        "PLAYFUL",
    ),
    (
        re.compile(r"\b(serious(?:ly)?|solemn(?:ly)?|grave(?:ly)?)\b", re.IGNORECASE),
        "SERIOUS",
    ),
]

_NON_VERBAL_CUES: list[tuple[re.Pattern[str], NonVerbalExpressionLiteral]] = [
    (re.compile(r"\b(laugh(?:ed|s)?|chuckl(?:ed|es)?|giggl(?:ed|es)?)\b", re.IGNORECASE), "LAUGH"),
    (re.compile(r"\b(sigh(?:ed|s)?)\b", re.IGNORECASE), "SIGH"),
    (re.compile(r"\b(gasp(?:ed|s)?)\b", re.IGNORECASE), "GASP"),
    (re.compile(r"\b(sob(?:bed|s)?)\b", re.IGNORECASE), "SOB"),
    (re.compile(r"\b(groan(?:ed|s)?)\b", re.IGNORECASE), "GROAN"),
]

_FAST_PACE_CUES = re.compile(
    r"[!?]{1,3}\s*$|\b(quick(?:ly)?|hurr(?:y|ied)|rushed|ran)\b", re.IGNORECASE
)
_SLOW_PACE_CUES = re.compile(r"\.\.\.|\b(slow(?:ly)?|paused?|lingered)\b", re.IGNORECASE)


def _quantize(value: float) -> float:
    return round(value, 2)


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


class DeterministicDirectorProvider(DirectorModelProvider):
    @property
    def model_identity(self) -> ModelIdentity:
        return MODEL_IDENTITY

    async def decide_performance(
        self, chunk_input: PerformanceChunkInput
    ) -> PerformanceDecision:
        text = chunk_input.text
        previous = chunk_input.previous_state

        delivery_mode, delivery_cue_hit = _detect_delivery_mode(text)
        emotion, intensity, emotion_cue_hit = _detect_emotion(text, previous)
        pacing = _detect_pacing(text, chunk_input.scene, delivery_mode)
        pitch, volume = _detect_pitch_volume(delivery_mode, emotion, intensity)
        pauses = _detect_pauses(text, chunk_input, previous)
        emphasis = _detect_emphasis(text)
        non_verbal = _detect_non_verbal(text)

        confidence = 0.75
        if delivery_cue_hit or emotion_cue_hit:
            confidence = 0.9

        return PerformanceDecision(
            is_dialogue=chunk_input.is_dialogue_hint,
            delivery_mode=delivery_mode,
            emotion=emotion,
            emotion_intensity=_quantize(intensity),
            pacing=_quantize(pacing),
            pitch=_quantize(pitch),
            volume=_quantize(volume),
            pauses=pauses,
            emphasis=emphasis,
            non_verbal=non_verbal,
            confidence=confidence,
        )


def _detect_delivery_mode(text: str) -> tuple[DeliveryModeLiteral, bool]:
    for pattern, mode in _DELIVERY_CUES:
        if pattern.search(text):
            return mode, True
    return "NORMAL", False


def _detect_emotion(
    text: str, previous: PreviousPerformanceState | None
) -> tuple[EmotionLiteral, float, bool]:
    for pattern, emotion in _EMOTION_CUES:
        if pattern.search(text):
            return emotion, 0.6, True

    # No lexical cue: continuity, never a reset to NEUTRAL absent evidence
    # (task §91/§181, director-specification.md §41.2's "plausible next
    # step"). Intensity decays gently toward baseline rather than staying
    # pinned, so a long run of unmarked narration doesn't stay at peak
    # intensity forever.
    if previous is not None and previous.emotion is not None:
        inherited_intensity = previous.emotion_intensity or 0.3
        return previous.emotion, max(0.2, inherited_intensity - 0.05), False

    return "NEUTRAL", 0.2, False


def _detect_pacing(text: str, scene: SceneContext | None, delivery_mode: str) -> float:
    pacing = PACING_BASELINE
    if delivery_mode == "SHOUT" or _FAST_PACE_CUES.search(text):
        pacing += 0.12
    if delivery_mode in ("WHISPER", "CRYING") or _SLOW_PACE_CUES.search(text):
        pacing -= 0.12
    tension = scene.tension if scene is not None else None
    if tension is not None:
        pacing += (tension - 0.5) * 0.1
    return _clamp(pacing, PACING_MIN, PACING_MAX)


def _detect_pitch_volume(delivery_mode: str, emotion: str, intensity: float) -> tuple[float, float]:
    pitch, volume = PITCH_BASELINE, VOLUME_BASELINE
    if delivery_mode == "SHOUT":
        pitch += 0.10
        volume += 0.40
    elif delivery_mode == "WHISPER":
        pitch -= 0.05
        volume -= 0.40
    if emotion in ("ANGRY", "EXCITED", "SURPRISED"):
        volume += 0.15 * intensity
    elif emotion in ("SAD", "GRIEF", "SOMBER", "FEARFUL"):
        volume -= 0.10 * intensity
        pitch -= 0.05 * intensity
    return _clamp(pitch, -1.0, 1.0), _clamp(volume, -1.0, 1.0)


def _detect_pauses(
    text: str, chunk_input: PerformanceChunkInput, previous: PreviousPerformanceState | None
) -> list[Pause]:
    pauses: list[Pause] = []
    previous_speaker = previous.speaker_character_id if previous else None
    current_speaker = chunk_input.speaker.character_id
    # Mandatory leading pause on a speaker change (director-specification.md
    # §19.3) -- but only once there IS a previous speaker to change from,
    # never on the very first chunk of a run.
    if previous is not None and previous_speaker != current_speaker:
        pauses.append(
            Pause(position="LEADING", duration_ms=350, kind="SPEAKER_TRANSITION", breath="NATURAL")
        )
    stripped = text.rstrip()
    if stripped.endswith("...") or stripped.endswith("—"):
        pauses.append(Pause(position="TRAILING", duration_ms=500, kind="DRAMATIC"))
    return pauses


def _detect_emphasis(text: str) -> list[Emphasis]:
    # A single genuinely-emphasized ALL-CAPS word (2+ letters, not a common
    # short acronym like "OK"/"US") -- never every important word (task §49).
    match = re.search(r"\b[A-Z]{2,}\b", text)
    if not match or match.group(0) in ("OK", "US", "I"):
        return []
    return [Emphasis(offset_chars=match.start(), length_chars=len(match.group(0)), strength=0.7)]


def _detect_non_verbal(text: str) -> list[NonVerbal]:
    for pattern, expression in _NON_VERBAL_CUES:
        match = pattern.search(text)
        if match:
            return [
                NonVerbal(
                    offset_chars=len(text),
                    length_chars=0,
                    expression=expression,
                    intensity=0.5,
                    placement="AFTER",
                )
            ]
    return []
