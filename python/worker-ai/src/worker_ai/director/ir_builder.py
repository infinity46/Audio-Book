"""Assembles one validated `AudioScriptChunk` (+ its `AudioScriptChunkSource`
row) from a chunk span, its resolved speaker, a provider's performance
decision, and a resolved voice binding. Field names match
`prisma/schema.prisma`'s `AudioScriptChunk` model exactly -- this is the one
place Python-native values are shaped into what `repo/writes_director.py`
inserts.

Quality/provenance fields (`review_flags`, `fallback_applied`,
`fallback_reason`, `confidence`) are computed HERE, deterministically, from
the upstream deterministic evidence (speaker confidence, voice-resolution
outcome) -- never left to the LLM-backed provider to self-report, since a
provider has no visibility into speaker or voice resolution outcomes (task
§57: "Use deterministic code for... allowed enums... continuity constraints").
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from worker_ai.director.chunker import ChunkSpan
from worker_ai.director.schemas import PerformanceDecision
from worker_ai.director.speaker_resolver import ResolvedSpeaker
from worker_ai.repo.reads_director import PronunciationHintSource
from worker_ai.repo.voice import VoiceBinding

IR_SCHEMA_VERSION = "ir.v1.0"

# Below this, a chunk's OWN speaker-resolution confidence earns a
# `LOW_CONFIDENCE` review flag -- mirrors director-specification.md §13.3's
# medium band (`0.50 <= confidence < 0.85`).
LOW_CONFIDENCE_THRESHOLD = 0.85


@dataclass(frozen=True, slots=True)
class BuiltChunk:
    fields: dict[str, object]
    source: dict[str, object]


def _match_pronunciation_hints(
    text: str, entries: list[PronunciationHintSource]
) -> list[dict[str, object]]:
    """Deterministic substring match against the book's global pronunciation
    lexicon -- text matching, not a performance-interpretation decision, so
    it never goes through the model (see module docstring)."""
    hints: list[dict[str, object]] = []
    lowered = text.lower()
    for entry in entries:
        needle = entry.surface_form_normalized
        if not needle:
            continue
        start = lowered.find(needle)
        if start == -1:
            continue
        hints.append(
            {
                "offset_chars": start,
                "length_chars": len(entry.surface_form),
                "lexicon_key": entry.lexicon_key,
                "ipa": entry.ipa,
                # PronunciationEntry has no stored `reason` column; PROPER_NOUN
                # is the most common case for a book-level lexicon entry and
                # is used as the deterministic default rather than inventing
                # per-entry classification this phase has no evidence for.
                "reason": "PROPER_NOUN",
            }
        )
    return hints


def build_chunk(
    *,
    chunk_id: str,
    audio_script_id: str,
    book_id: str,
    tenant_id: str,
    chapter_id: str,
    scene_id: str | None,
    sequence_index: int,
    chapter_sequence_index: int,
    span: ChunkSpan,
    resolved_speaker: ResolvedSpeaker,
    decision: PerformanceDecision,
    voice_binding: VoiceBinding | None,
    voice_fallback_applied: bool,
    pronunciation_entries: list[PronunciationHintSource],
    language: str,
    director_version: str,
    director_model_version_id: str,
    story_bible_version_id: str,
    context_bundle_hash: str,
) -> BuiltChunk:
    text = span.text
    source_content_hash = hashlib.sha256(text.encode()).hexdigest()
    pronunciation_hints = _match_pronunciation_hints(text, pronunciation_entries)

    review_flags: list[str] = []
    fallback_applied = False
    fallback_reason: str | None = None

    if resolved_speaker.speaker_type == "UNKNOWN":
        review_flags.append("UNKNOWN_SPEAKER")
    elif resolved_speaker.confidence < LOW_CONFIDENCE_THRESHOLD:
        review_flags.append("LOW_CONFIDENCE")

    if voice_binding is None:
        review_flags.append("CAPABILITY_GAP")
        fallback_applied = True
        fallback_reason = "VOICE_PROFILE_MISSING"
    elif voice_fallback_applied:
        fallback_applied = True
        fallback_reason = "SPEAKER_UNRESOLVED_NARRATOR_FALLBACK"

    # Composite confidence: the more conservative (lower) of speaker-
    # resolution confidence and performance-decision confidence -- narration
    # (resolved deterministically, confidence 1.0) is gated only by the
    # provider's own confidence.
    composite_confidence = round(min(resolved_speaker.confidence, decision.confidence), 2)

    fields: dict[str, object] = {
        "id": chunk_id,
        "tenant_id": tenant_id,
        "book_id": book_id,
        "audio_script_id": audio_script_id,
        "chapter_id": chapter_id,
        "section_id": None,
        "scene_id": scene_id,
        "sequence_index": sequence_index,
        "chapter_sequence_index": chapter_sequence_index,
        "version": 1,
        "supersedes_chunk_id": None,
        "source_content_hash": source_content_hash,
        "schema_version": IR_SCHEMA_VERSION,
        "director_version": director_version,
        "director_model_version_id": director_model_version_id,
        "context_bundle_hash": context_bundle_hash,
        "story_bible_version_id": story_bible_version_id,
        "text": text,
        "spoken_text": None,
        "language": language,
        "script": None,
        "speaker_type": resolved_speaker.speaker_type,
        "character_id": resolved_speaker.character_id,
        "is_dialogue": decision.is_dialogue,
        "delivery_mode": decision.delivery_mode,
        "emotion": decision.emotion,
        "emotion_intensity": decision.emotion_intensity,
        "pacing": decision.pacing,
        "pitch": decision.pitch,
        "volume": decision.volume,
        "pauses": [p.model_dump() for p in decision.pauses] or None,
        "emphasis": [e.model_dump() for e in decision.emphasis] or None,
        "pronunciation_hints": pronunciation_hints or None,
        "non_verbal": [n.model_dump() for n in decision.non_verbal] or None,
        "voice_profile_id": voice_binding.voice_profile_id if voice_binding else None,
        "voice_profile_version_id": (
            voice_binding.voice_profile_version_id if voice_binding else None
        ),
        "tts_provider_id": voice_binding.tts_provider_id if voice_binding else None,
        "generation_params": voice_binding.generation_params if voice_binding else None,
        "generation_params_hash": voice_binding.generation_params_hash if voice_binding else None,
        "seed": None,
        "target_sample_rate": None,
        "target_channels": None,
        "confidence": composite_confidence,
        "decision_confidence": (
            decision.decision_confidence.model_dump() if decision.decision_confidence else None
        ),
        "review_flags": review_flags,
        "fallback_applied": fallback_applied,
        "fallback_reason": fallback_reason,
        "capability_gaps": None,
        "continuity": None,
        "origin": "AUTO_GENERATED",
        "director_original": None,
        "override": None,
        "state": "DRAFT",
    }
    source: dict[str, object] = {
        "audio_script_chunk_id": chunk_id,
        "order_index": 0,
        "paragraph_id": span.paragraph_id,
        "book_id": book_id,
        "paragraph_char_start": span.char_start,
        "paragraph_char_end": span.char_end,
    }
    return BuiltChunk(fields=fields, source=source)
