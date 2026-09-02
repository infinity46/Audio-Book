"""Unit tests for `worker_gpu.tts.capability.negotiate` (§32-§35).

No mocking, no I/O: `negotiate` is a pure function, tested the same way
`worker_ai/tests/test_speaker_resolver.py` tests pure resolution logic.
"""

from __future__ import annotations

import pytest

from worker_gpu.tts.capability import CAPABILITY_MAP_VERSION, negotiate
from worker_gpu.tts.errors import TtsError, TtsErrorCode
from worker_gpu.tts.schemas import CapabilityHandling, EmotionControl, PerformanceIntent, ProviderCapabilities

_NEUTRAL_CAPS = ProviderCapabilities(
    models=("test-model",),
    languages=("en-US",),
    max_input_chars=500,
    native_sample_rate=24_000,
    supports_reference_audio=False,
    supports_embedding=False,
    supports_streaming=False,
    emotion_control=EmotionControl.NONE,
    deterministic_seed=True,
    max_batch=1,
    supports_pitch_control=False,
    supports_speed_control=True,
    supports_ssml=False,
    supports_phoneme_input=False,
)

_CONDITIONING_CAPS = _NEUTRAL_CAPS.model_copy(
    update={"emotion_control": EmotionControl.CONDITIONING, "supports_pitch_control": True}
)


def _performance(**overrides: object) -> PerformanceIntent:
    base: dict[str, object] = {"speaker_type": "CHARACTER"}
    base.update(overrides)
    return PerformanceIntent(**base)


def test_neutral_emotion_produces_no_gap() -> None:
    result = negotiate(
        _performance(emotion="NEUTRAL"), capabilities=_NEUTRAL_CAPS, language="en-US", text_length=10
    )
    assert result.gaps == ()
    assert result.controls.speed == 1.0
    assert result.controls.pitch_semitones == 0.0


def test_unsupported_emotion_mechanism_approximates_and_records_gap() -> None:
    result = negotiate(
        _performance(emotion="ANGRY", emotion_intensity=1.0),
        capabilities=_NEUTRAL_CAPS,  # emotion_control = NONE
        language="en-US",
        text_length=10,
    )
    assert len(result.gaps) == 1
    gap = result.gaps[0]
    assert gap.field == "emotion"
    assert gap.requested == "ANGRY"
    assert gap.handling is CapabilityHandling.APPROXIMATED
    # §35.2 rule 1: the instruction is never silently discarded -- the prosody nudge
    # is non-trivial (ANGRY is speed>1, gain>0 at full intensity in the documented table).
    assert result.controls.speed > 1.0
    assert result.controls.gain_db > 0.0


def test_native_emotion_mechanism_produces_no_gap_and_uses_style_tag() -> None:
    result = negotiate(
        _performance(emotion="HAPPY", emotion_intensity=0.5),
        capabilities=_CONDITIONING_CAPS,
        language="en-US",
        text_length=10,
    )
    assert result.gaps == ()
    assert "emotion:happy" in result.controls.style_tags
    # NATIVE handling does not apply the prosody-nudge fallback.
    assert result.controls.speed == 1.0


def test_per_voice_declaration_can_downgrade_below_engine_capability() -> None:
    """§32.2: a voice with sparse reference material can be less convincing for a given
    emotion than the engine's mechanism would otherwise imply -- the per-voice map wins."""
    result = negotiate(
        _performance(emotion="GRIEF", emotion_intensity=1.0),
        capabilities=_CONDITIONING_CAPS,
        language="en-US",
        text_length=10,
        emotion_capability_map={"GRIEF": "UNSUPPORTED"},
    )
    assert len(result.gaps) == 1
    assert result.gaps[0].handling is CapabilityHandling.UNSUPPORTED


def test_whisper_delivery_mode_is_the_documented_worked_example() -> None:
    """§35.1's worked example, verbatim: WHISPER approximates via reduced volume plus
    slightly slower pacing."""
    result = negotiate(
        _performance(delivery_mode="WHISPER"), capabilities=_NEUTRAL_CAPS, language="en-US", text_length=10
    )
    gap = next(g for g in result.gaps if g.field == "delivery_mode")
    assert gap.handling is CapabilityHandling.APPROXIMATED
    assert result.controls.speed < 1.0
    assert result.controls.gain_db < 0.0


def test_pitch_without_capability_is_recorded_unsupported_never_invented() -> None:
    result = negotiate(
        _performance(pitch=0.5), capabilities=_NEUTRAL_CAPS, language="en-US", text_length=10
    )
    gap = next(g for g in result.gaps if g.field == "pitch")
    assert gap.handling is CapabilityHandling.UNSUPPORTED
    # §87: no fake pitch parameter is invented when the capability is absent.
    assert result.controls.pitch_semitones == 0.0


def test_pitch_with_capability_is_applied() -> None:
    result = negotiate(
        _performance(pitch=0.5), capabilities=_CONDITIONING_CAPS, language="en-US", text_length=10
    )
    assert not any(g.field == "pitch" for g in result.gaps)
    assert result.controls.pitch_semitones == pytest.approx(2.0)


def test_language_mismatch_blocks_rather_than_degrades() -> None:
    with pytest.raises(TtsError) as excinfo:
        negotiate(_performance(), capabilities=_NEUTRAL_CAPS, language="fr-FR", text_length=10)
    assert excinfo.value.code is TtsErrorCode.VOICE_LANGUAGE_MISMATCH


def test_oversized_chunk_blocks_rather_than_truncates() -> None:
    with pytest.raises(TtsError) as excinfo:
        negotiate(_performance(), capabilities=_NEUTRAL_CAPS, language="en-US", text_length=10_000)
    assert excinfo.value.code is TtsErrorCode.UNSUPPORTED_TTS_CAPABILITY


def test_pauses_never_produce_a_capability_gap() -> None:
    """§32.3's pause clause covers only the engine's OWN silence production, which is
    validated (§30), not negotiated -- the IR's pause plan is Audio Processing's (§24.1)."""
    result = negotiate(
        _performance(pauses=({"offset_ms": 100, "duration_ms": 200},)),
        capabilities=_NEUTRAL_CAPS,
        language="en-US",
        text_length=10,
    )
    assert not any(g.field == "pauses" for g in result.gaps)


def test_determinism_same_input_same_output() -> None:
    """§15: same IR, same provider version, same mapping version -> same configuration."""
    kwargs = {
        "performance": _performance(emotion="TENSE", emotion_intensity=0.6, pacing=1.3, delivery_mode="SHOUT"),
        "capabilities": _NEUTRAL_CAPS,
        "language": "en-US",
        "text_length": 42,
    }
    first = negotiate(**kwargs)
    second = negotiate(**kwargs)
    assert first.controls == second.controls
    assert first.gaps == second.gaps
    assert first.capability_map_version == CAPABILITY_MAP_VERSION
