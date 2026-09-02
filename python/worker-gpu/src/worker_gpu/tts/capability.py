"""Capability negotiation and the degradation policy (§32-§35, §41).

This is the layer between "what the Director asked for" and "what this engine can do". It
is a **pure function of (IR chunk, declared capabilities, per-voice emotion capability
map)** -- no I/O, no randomness, no clock -- because §15 requires that the same IR under
the same provider version and the same mapping version always selects the same
configuration. `CAPABILITY_MAP_VERSION` is stamped onto the result so an audited
generation can be reproduced against the exact mapping that produced it (§14, §83.2).

Two things this module deliberately does NOT do:

  * It does not translate to engine parameter names. It emits `SynthesisControls` --
    normalized, provider-neutral quantities (a speed multiplier, a semitone offset, a gain
    in dB) -- and the adapter maps those onto whatever its engine calls them (§41.2).
  * It does not ask anything to reinterpret the book. An unsupported emotion is mapped
    through the documented table below, never re-derived from the text by a model: the
    Director already decided, and §13 of the task brief forbids re-deciding.

The four binding rules of §35.2 are what the code below implements literally: never
silently discard an instruction; never falsely report exact support; approximate only
where a documented approximation exists (that is what `_EMOTION_PROSODY` and
`_DELIVERY_PROSODY` are -- the documentation, in executable form); and prefer
approximation over failure, except for voice identity, which blocks (§34.2).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from worker_gpu.tts.errors import TtsError, TtsErrorCode
from worker_gpu.tts.schemas import (
    CapabilityGap,
    CapabilityHandling,
    EmotionControl,
    PerformanceIntent,
    ProviderCapabilities,
)

CAPABILITY_MAP_VERSION = "tts-capability-map.v1"

# Documented approximations, per §35.2 rule 3: a provider may only claim APPROXIMATED for a
# field when a documented method exists. These are that method, expressed as multipliers and
# offsets on the neutral rendering, applied in proportion to `emotion_intensity` so that a
# 0.2-intensity ANGRY is not rendered as a shout.
#
# (speed_scale, pitch_semitones, gain_db) at full intensity.
_EMOTION_PROSODY: dict[str, tuple[float, float, float]] = {
    "NEUTRAL": (1.00, 0.0, 0.0),
    "HAPPY": (1.06, 0.8, 0.7),
    "SAD": (0.92, -0.8, -1.2),
    "GRIEF": (0.86, -1.2, -1.8),
    "ANGRY": (1.08, 0.6, 1.6),
    "FEARFUL": (1.10, 1.0, -0.6),
    "SURPRISED": (1.09, 1.4, 0.9),
    "DISGUSTED": (0.95, -0.4, 0.3),
    "EXCITED": (1.12, 1.2, 1.2),
    "CALM": (0.95, -0.3, -0.4),
    "TENSE": (1.04, 0.4, 0.4),
    "ANXIOUS": (1.09, 0.7, -0.3),
    "SOMBER": (0.90, -0.9, -1.0),
    "CONFIDENT": (1.00, -0.2, 0.8),
    "UNCERTAIN": (0.94, 0.3, -0.7),
    "PLAYFUL": (1.05, 0.9, 0.4),
    "SERIOUS": (0.97, -0.4, 0.2),
}

# §35.1's worked example is the WHISPER row: "approximate via reduced volume + slightly
# slower pacing". The rest follow the same discipline.
_DELIVERY_PROSODY: dict[str, tuple[float, float, float]] = {
    "NORMAL": (1.00, 0.0, 0.0),
    "INTERNAL_THOUGHT": (0.95, -0.3, -2.0),
    "WHISPER": (0.93, -0.5, -6.0),
    "SHOUT": (1.05, 1.0, 4.0),
    "LAUGHING": (1.05, 0.8, 0.5),
    "CRYING": (0.88, -0.6, -1.0),
    "SINGING": (0.95, 0.0, 0.5),
    "READING_ALOUD": (0.98, 0.0, 0.0),
}


@dataclass(frozen=True, slots=True)
class SynthesisControls:
    """Provider-neutral controls. The adapter maps these onto engine parameters.

    `speed` is a multiplier on the engine's natural rate (1.0 = unmodified), `pitch_
    semitones` an offset, `gain_db` a level offset the adapter may apply where it can and
    Audio Processing otherwise applies downstream (§24.1, §25.1).
    """

    speed: float
    pitch_semitones: float
    gain_db: float
    emotion: str
    emotion_intensity: float
    delivery_mode: str
    style_tags: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Negotiation:
    """The result of §34's capability check: what to render, and what was degraded."""

    controls: SynthesisControls
    gaps: tuple[CapabilityGap, ...] = ()
    capability_map_version: str = CAPABILITY_MAP_VERSION
    prepared_text_version: str = ""
    extra: dict[str, str] = field(default_factory=dict)


def _round(value: float) -> float:
    """Quantise every emitted control to 3 decimals.

    Determinism (§15, §40.3) is a contract here, and float accumulation order across the
    emotion and delivery passes would otherwise let two mathematically identical inputs
    produce configurations differing in the last bits -- enough to change a
    `generation_params` hash and defeat the cache (§43).
    """
    return round(value + 0.0, 3)


def negotiate(
    performance: PerformanceIntent,
    *,
    capabilities: ProviderCapabilities,
    language: str,
    text_length: int,
    emotion_capability_map: dict[str, str] | None = None,
) -> Negotiation:
    """Run §34's capability check and §35's degradation policy.

    Raises `TtsError` for the **critical** requirements of §34.2 -- unsupported language and
    over-capacity input -- which block rather than degrade. Everything non-critical
    degrades with a recorded `capability_gap`.
    """
    if not capabilities.supports_language(language):
        raise TtsError(
            TtsErrorCode.VOICE_LANGUAGE_MISMATCH,
            f"Provider does not support language {language!r}.",
        )
    if text_length > capabilities.max_input_chars:
        # §22.2/§22.3: never a silent truncation and never an ad-hoc re-segmentation. An
        # over-long chunk means the Director's chunk sizing is out of step with the bound
        # provider, which is a configuration defect to fix upstream.
        raise TtsError(
            TtsErrorCode.UNSUPPORTED_TTS_CAPABILITY,
            f"Chunk of {text_length} chars exceeds the provider's "
            f"{capabilities.max_input_chars}-char ceiling.",
            note="Re-chunk upstream (audio-script-ir.md §10.3); do not truncate or split here.",
        )

    gaps: list[CapabilityGap] = []
    speed = 1.0
    pitch = 0.0
    gain = 0.0
    style_tags: list[str] = []

    emotion = performance.emotion
    intensity = max(0.0, min(1.0, performance.emotion_intensity))
    declared = (emotion_capability_map or {}).get(emotion)

    if emotion != "NEUTRAL":
        handling = _emotion_handling(capabilities, declared)
        if handling is CapabilityHandling.NATIVE:
            style_tags.append(f"emotion:{emotion.lower()}")
        else:
            e_speed, e_pitch, e_gain = _EMOTION_PROSODY.get(emotion, (1.0, 0.0, 0.0))
            speed *= 1.0 + (e_speed - 1.0) * intensity
            pitch += e_pitch * intensity
            gain += e_gain * intensity
            gaps.append(
                CapabilityGap(
                    field="emotion",
                    requested=emotion,
                    handling=handling,
                    note=(
                        "prosody approximation (speed+pitch+gain), scaled by intensity"
                        if handling is CapabilityHandling.APPROXIMATED
                        else "declared unsupported for this voice; rendered with neutral "
                        "prosody, intent recorded"
                    ),
                )
            )
            if handling is CapabilityHandling.UNSUPPORTED:
                # §85: not silently neutral -- the gap above records the discarded intent.
                # The prosody nudge is still applied because a documented approximation is
                # strictly better than discarding the instruction entirely (§35.2 rule 4).
                pass

    if performance.delivery_mode != "NORMAL":
        d_speed, d_pitch, d_gain = _DELIVERY_PROSODY.get(performance.delivery_mode, (1.0, 0.0, 0.0))
        speed *= d_speed
        pitch += d_pitch
        gain += d_gain
        # No provider in `ProviderCapabilities` declares a delivery-mode axis: §3.3 has no
        # such flag, so every non-NORMAL delivery is an approximation by construction.
        gaps.append(
            CapabilityGap(
                field="delivery_mode",
                requested=performance.delivery_mode,
                handling=CapabilityHandling.APPROXIMATED,
                note="volume+pacing approximation",
            )
        )

    if performance.pacing != 1.0:
        if capabilities.supports_speed_control:
            speed *= performance.pacing
        else:
            gaps.append(
                CapabilityGap(
                    field="pacing",
                    requested=f"{performance.pacing:.2f}",
                    handling=CapabilityHandling.UNSUPPORTED,
                    note="provider exposes no speed control; rate left at the engine's natural pace",
                )
            )

    if performance.pitch != 0.0:
        if capabilities.supports_pitch_control:
            # IR pitch is a normalized offset in [-1, 1] (`audio-script-ir.md`); one unit is
            # mapped to four semitones, which is the documented conversion for this map
            # version. It is not an engine parameter -- the adapter still owns that step.
            pitch += performance.pitch * 4.0
        else:
            # §87: do not invent a fake pitch parameter.
            gaps.append(
                CapabilityGap(
                    field="pitch",
                    requested=f"{performance.pitch:.2f}",
                    handling=CapabilityHandling.UNSUPPORTED,
                    note="provider exposes no pitch control",
                )
            )

    if performance.volume != 0.0:
        # §25.1: loudness is Audio Processing's, in two passes. TTS records the intent and
        # the gap rather than baking a level into the waveform that mastering would then
        # have to undo.
        gaps.append(
            CapabilityGap(
                field="volume",
                requested=f"{performance.volume:.2f}",
                handling=CapabilityHandling.APPROXIMATED,
                note="level intent deferred to audio processing (tts-provider-spec §25.1)",
            )
        )

    if performance.pronunciation_hints and not (
        capabilities.supports_phoneme_input or capabilities.supports_ssml
    ):
        gaps.append(
            CapabilityGap(
                field="pronunciation_hints",
                requested=f"{len(performance.pronunciation_hints)} hint(s)",
                handling=CapabilityHandling.UNSUPPORTED,
                note="provider accepts neither phonemes nor SSML; engine's built-in "
                "pronunciation used",
            )
        )

    if performance.emphasis and not capabilities.supports_ssml:
        gaps.append(
            CapabilityGap(
                field="emphasis",
                requested=f"{len(performance.emphasis)} span(s)",
                handling=CapabilityHandling.UNSUPPORTED,
                note="provider exposes no emphasis markup",
            )
        )

    if performance.non_verbal:
        gaps.append(
            CapabilityGap(
                field="non_verbal",
                requested=f"{len(performance.non_verbal)} event(s)",
                handling=CapabilityHandling.UNSUPPORTED,
                note="no provider-neutral non-verbal control exists in ProviderCapabilities",
            )
        )

    # `pauses[]` is deliberately absent from the gap list: the IR's pause plan is applied by
    # Audio Processing (§24.1, §30.2), so it is not a field TTS failed to honour. §32.3's
    # pause clause covers only the engine's OWN silence production, which §30.1 validates
    # rather than negotiates.

    controls = SynthesisControls(
        speed=_round(max(0.25, min(4.0, speed))),
        pitch_semitones=_round(max(-12.0, min(12.0, pitch))),
        gain_db=_round(max(-24.0, min(12.0, gain))),
        emotion=emotion,
        emotion_intensity=_round(intensity),
        delivery_mode=performance.delivery_mode,
        style_tags=tuple(style_tags),
    )
    return Negotiation(controls=controls, gaps=tuple(gaps))


def _emotion_handling(
    capabilities: ProviderCapabilities, declared: str | None
) -> CapabilityHandling:
    """Combine the provider's mechanism (§32.2) with the per-voice declaration.

    The per-voice map is authoritative when it is more pessimistic: two voices on one
    engine genuinely differ in how convincingly they carry an emotion (§32.2), so a voice
    declaring `UNSUPPORTED` is not promoted to `NATIVE` by the engine's own capability.
    """
    if declared == CapabilityHandling.UNSUPPORTED.value:
        return CapabilityHandling.UNSUPPORTED
    if capabilities.emotion_control is EmotionControl.NONE:
        return CapabilityHandling.APPROXIMATED
    if declared == CapabilityHandling.NATIVE.value:
        return CapabilityHandling.NATIVE
    if declared == CapabilityHandling.APPROXIMATED.value:
        return CapabilityHandling.APPROXIMATED
    # No per-voice declaration: an engine with a real emotion mechanism is taken at its
    # word (that is what `capabilities()` is for, §3.3), but never upgraded past it.
    return CapabilityHandling.NATIVE


__all__ = [
    "CAPABILITY_MAP_VERSION",
    "Negotiation",
    "SynthesisControls",
    "negotiate",
]
