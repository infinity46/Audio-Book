"""`director/speaker_resolver.py`: the seven-strategy deterministic-first
resolution algorithm (director-specification.md §11.3). Each test isolates
one strategy by constructing evidence that ONLY that strategy can satisfy.
"""

from __future__ import annotations

from worker_ai.director.chunker import ChunkSpan
from worker_ai.director.speaker_resolver import KnownSpeaker, SentinelIds, resolve_speaker

SENTINELS = SentinelIds(
    narrator="sentinel-narrator",
    unknown_speaker="sentinel-unknown",
    multiple_speakers="sentinel-multiple",
    system="sentinel-system",
)

ALICE = KnownSpeaker(
    character_id="alice-id", display_name="Alice", normalized_names=frozenset({"alice"})
)
BOB = KnownSpeaker(
    character_id="bob-id", display_name="Bob", normalized_names=frozenset({"bob"})
)


def _dialogue_span(paragraph_text: str) -> ChunkSpan:
    start = paragraph_text.index('"')
    end = paragraph_text.rindex('"') + 1
    return ChunkSpan(
        paragraph_id="p1",
        char_start=start,
        char_end=end,
        text=paragraph_text[start:end],
        is_dialogue_hint=True,
    )


def test_narration_resolves_to_narrator_sentinel_without_evidence() -> None:
    span = ChunkSpan(
        paragraph_id="p1", char_start=0, char_end=10, text="She walked.", is_dialogue_hint=False
    )
    result = resolve_speaker(
        span,
        paragraph_text="She walked.",
        known_speakers=[ALICE, BOB],
        scene_participant_ids=frozenset(),
        previous_speaker_id=None,
        sentinels=SENTINELS,
    )
    assert result.speaker_type == "NARRATOR"
    assert result.character_id == SENTINELS.narrator
    assert result.confidence == 1.0
    assert result.strategy == "NARRATION"


def test_strategy_1_explicit_attribution() -> None:
    text = '"Hello there," said Alice.'
    span = _dialogue_span(text)
    result = resolve_speaker(
        span,
        paragraph_text=text,
        known_speakers=[ALICE, BOB],
        scene_participant_ids=frozenset({ALICE.character_id, BOB.character_id}),
        previous_speaker_id=None,
        sentinels=SENTINELS,
    )
    assert result.speaker_type == "CHARACTER"
    assert result.character_id == ALICE.character_id
    assert result.strategy == "EXPLICIT_ATTRIBUTION"
    assert result.confidence >= 0.85


def test_strategy_5_turn_taking_alternates_speaker() -> None:
    # No attribution tag at all -- only turn-taking evidence: Bob spoke last,
    # Alice is the only other scene participant.
    text = '"How are you?"'
    span = _dialogue_span(text)
    result = resolve_speaker(
        span,
        paragraph_text=text,
        known_speakers=[ALICE, BOB],
        scene_participant_ids=frozenset({ALICE.character_id, BOB.character_id}),
        previous_speaker_id=BOB.character_id,
        sentinels=SENTINELS,
    )
    assert result.character_id == ALICE.character_id
    assert result.strategy == "TURN_TAKING"


def test_strategy_6_sole_participant_inference() -> None:
    text = '"I am here."'
    span = _dialogue_span(text)
    result = resolve_speaker(
        span,
        paragraph_text=text,
        known_speakers=[ALICE],
        scene_participant_ids=frozenset({ALICE.character_id}),
        previous_speaker_id=None,
        sentinels=SENTINELS,
    )
    assert result.character_id == ALICE.character_id
    assert result.strategy == "SOLE_PARTICIPANT_INFERENCE"
    assert result.confidence < 0.85  # a weaker inference, not auto-accept-strength


def test_strategy_7_fallback_never_guesses() -> None:
    # Two equally plausible participants, no attribution, no prior speaker to
    # turn-take from -- must fall back to UNKNOWN_SPEAKER, never pick one.
    text = '"Wait."'
    span = _dialogue_span(text)
    result = resolve_speaker(
        span,
        paragraph_text=text,
        known_speakers=[ALICE, BOB],
        scene_participant_ids=frozenset({ALICE.character_id, BOB.character_id}),
        previous_speaker_id=None,
        sentinels=SENTINELS,
    )
    assert result.speaker_type == "UNKNOWN"
    assert result.character_id == SENTINELS.unknown_speaker
    assert result.confidence == 0.0
    assert result.strategy == "UNRESOLVED_FALLBACK"
