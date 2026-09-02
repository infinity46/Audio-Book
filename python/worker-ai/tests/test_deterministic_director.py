"""`director/deterministic.py`: the default `DirectorModelProvider`.

Verifies the two properties `director-specification.md` requires of ANY
provider (emotional continuity, exact numeric baselines/bounds from §4.3),
plus the lexical-cue heuristics, without claiming general accuracy (see the
module's own docstring).
"""

from __future__ import annotations

import pytest

from worker_ai.director.deterministic import DeterministicDirectorProvider
from worker_ai.director.schemas import (
    PACING_MAX,
    PACING_MIN,
    PerformanceChunkInput,
    PreviousPerformanceState,
    SpeakerContext,
)

PROVIDER = DeterministicDirectorProvider()


def _input(
    text: str,
    *,
    is_dialogue_hint: bool = False,
    previous_state: PreviousPerformanceState | None = None,
) -> PerformanceChunkInput:
    return PerformanceChunkInput(
        chunk_id="c1",
        text=text,
        is_dialogue_hint=is_dialogue_hint,
        speaker=SpeakerContext(speaker_type="NARRATOR", character_id="narrator-id"),
        previous_state=previous_state,
    )


@pytest.mark.asyncio
async def test_no_cues_defaults_to_neutral_baseline() -> None:
    decision = await PROVIDER.decide_performance(_input("She walked across the room."))
    assert decision.emotion == "NEUTRAL"
    assert decision.delivery_mode == "NORMAL"
    assert decision.pacing == 1.00
    assert decision.pitch == 0.00
    assert decision.volume == 0.00


@pytest.mark.asyncio
async def test_whisper_cue_sets_delivery_mode_and_quieter_volume() -> None:
    decision = await PROVIDER.decide_performance(_input('"Careful," she whispered.'))
    assert decision.delivery_mode == "WHISPER"
    assert decision.volume < 0


@pytest.mark.asyncio
async def test_shout_cue_sets_delivery_mode_and_louder_volume() -> None:
    decision = await PROVIDER.decide_performance(_input('"Get out!" he shouted.'))
    assert decision.delivery_mode == "SHOUT"
    assert decision.volume > 0


@pytest.mark.asyncio
async def test_emotion_continuity_never_resets_to_neutral_without_evidence() -> None:
    previous = PreviousPerformanceState(
        speaker_character_id="narrator-id", emotion="ANGRY", emotion_intensity=0.6
    )
    decision = await PROVIDER.decide_performance(
        _input("The room fell silent.", previous_state=previous)
    )
    assert decision.emotion == "ANGRY"
    assert 0.2 <= decision.emotion_intensity < 0.6


@pytest.mark.asyncio
async def test_lexical_cue_overrides_inherited_emotion() -> None:
    previous = PreviousPerformanceState(
        speaker_character_id="narrator-id", emotion="ANGRY", emotion_intensity=0.6
    )
    decision = await PROVIDER.decide_performance(
        _input("She smiled happily at the news.", previous_state=previous)
    )
    assert decision.emotion == "HAPPY"


@pytest.mark.asyncio
async def test_speaker_change_inserts_leading_speaker_transition_pause() -> None:
    previous = PreviousPerformanceState(speaker_character_id="someone-else")
    decision = await PROVIDER.decide_performance(
        PerformanceChunkInput(
            chunk_id="c1",
            text='"Now it is my turn to speak."',
            is_dialogue_hint=True,
            speaker=SpeakerContext(speaker_type="CHARACTER", character_id="alice-id"),
            previous_state=previous,
        )
    )
    transition_pauses = [p for p in decision.pauses if p.kind == "SPEAKER_TRANSITION"]
    assert len(transition_pauses) == 1
    assert transition_pauses[0].position == "LEADING"


@pytest.mark.asyncio
async def test_no_pause_inserted_on_first_chunk_with_no_previous_speaker() -> None:
    decision = await PROVIDER.decide_performance(_input('"Hello."', is_dialogue_hint=True))
    assert all(p.kind != "SPEAKER_TRANSITION" for p in decision.pauses)


@pytest.mark.asyncio
async def test_numeric_outputs_stay_within_bounds() -> None:
    decision = await PROVIDER.decide_performance(
        _input('"Get out now!!!" he shouted furiously, rushing forward.')
    )
    assert PACING_MIN <= decision.pacing <= PACING_MAX
    assert -1.0 <= decision.pitch <= 1.0
    assert -1.0 <= decision.volume <= 1.0
    assert 0.0 <= decision.emotion_intensity <= 1.0
    assert 0.0 <= decision.confidence <= 1.0


@pytest.mark.asyncio
async def test_model_identity_is_stable() -> None:
    identity = PROVIDER.model_identity
    assert identity.role == "LLM"
    assert identity.provider_id == "audio-book-director"
    assert identity.model_id == "deterministic-heuristic-director"
