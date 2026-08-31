"""Structured input/output contracts for chapter-level semantic analysis.

This is what "schema-validated structured output" means concretely for Phase 3: a
`SemanticAnalyzer` (deterministic or LLM-backed) returns a `ChapterAnalysisResult`, and
Pydantic rejects anything that does not match it -- an analyzer that returns malformed
JSON, wrong types, or an out-of-vocabulary enum member never reaches persistence
(`repo/`). Enum members here are copied verbatim from `prisma/schema.prisma`
(`RelationshipType`, `CharacterAliasType`, `NarrativeThreadKind`, `SpanKind`, `PovType`)
so a candidate can be inserted directly without a translation table drifting from the DB.

Analysis is chapter-scoped and stateless per call (`context.md` §5.6: "the system never
relies on the LLM 'remembering' anything between calls"): `AnalyzeChapterInput` carries
this chapter's paragraphs plus a small, already-summarized `PriorContext` -- never
previous chapters' raw text.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

AliasType = Literal[
    "GIVEN_NAME", "FULL_NAME", "SURNAME", "NICKNAME", "TITLE", "EPITHET", "DESCRIPTOR", "RELATIONAL"
]
RelationshipTypeLiteral = Literal[
    "FAMILY",
    "ROMANTIC",
    "FRIENDSHIP",
    "RIVALRY",
    "ADVERSARIAL",
    "MENTOR",
    "PROFESSIONAL",
    "AUTHORITY",
    "ALLIANCE",
    "BETRAYAL",
    "UNKNOWN",
]
ThreadKind = Literal["OPEN_QUESTION", "SECRET", "DRAMATIC_IRONY", "FORESHADOWING"]
SpanKindLiteral = Literal["NORMAL", "FLASHBACK", "FLASH_FORWARD"]
PovTypeLiteral = Literal["FIRST", "THIRD_LIMITED", "THIRD_OMNISCIENT", "SECOND", "MIXED"]


class _Strict(BaseModel):
    """Base for every schema in this module: unknown fields are a validation error, not
    silently dropped data -- an analyzer inventing extra fields is itself a signal
    something is wrong with its output, not a forward-compatible addition to tolerate."""

    model_config = ConfigDict(extra="forbid", frozen=True)


# --------------------------------------------------------------------------- #
# Input
# --------------------------------------------------------------------------- #


class ParagraphInput(_Strict):
    id: str
    order_index: int
    spine_position: int
    text: str


class KnownCharacter(_Strict):
    id: str
    display_name: str
    aliases: list[str] = Field(default_factory=list)


class PriorNarrativeStateSummary(_Strict):
    present_character_ids: list[str] = Field(default_factory=list)
    pov_character_id: str | None = None
    location_name: str | None = None
    unresolved_thread_summaries: list[str] = Field(default_factory=list)


class PriorContext(_Strict):
    """Bounded prior-chapter context -- never the whole book (task's context-window-
    strategy requirement). `known_characters` is the existing Character Registry for
    this book so far; `previous_narrative_state` is the single most recent snapshot."""

    known_characters: list[KnownCharacter] = Field(default_factory=list)
    previous_narrative_state: PriorNarrativeStateSummary | None = None


class AnalyzeChapterInput(_Strict):
    chapter_id: str
    book_id: str
    paragraphs: list[ParagraphInput]
    prior_context: PriorContext


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #


class CharacterMention(_Strict):
    """A candidate character identity. `normalized_key` (not a database id -- none
    exists yet) is how other candidates in the SAME result reference this one (e.g. a
    `RelationshipCandidate.source_key`); the handler resolves it against the existing
    Character Registry and mints a real id only for genuinely new identities."""

    surface_form: str
    normalized_key: str
    alias_type: AliasType
    is_speaker: bool = False
    pronoun_hints: list[str] = Field(default_factory=list)
    evidence_paragraph_ids: list[str]
    confidence: float = Field(ge=0.0, le=1.0)
    resolved_character_id: str | None = Field(
        default=None,
        description="Set only when this mention already matches a KnownCharacter from "
        "PriorContext -- an existing identity, not a new candidate.",
    )


class SceneBoundary(_Strict):
    order_index: int
    start_paragraph_id: str
    end_paragraph_id: str
    paragraph_ids: list[str]
    location_name: str | None = None
    in_story_time: str | None = None
    mood: str | None = None
    tension: float | None = Field(default=None, ge=0.0, le=1.0)
    pov_character_key: str | None = None
    participant_keys: list[str] = Field(default_factory=list)
    summary: str | None = None
    confidence: float = Field(ge=0.0, le=1.0)


class RelationshipCandidate(_Strict):
    source_key: str
    target_key: str
    relationship_type: RelationshipTypeLiteral
    label: str | None = None
    directional: bool = True
    evidence_paragraph_ids: list[str]
    confidence: float = Field(ge=0.0, le=1.0)


class LocationCandidate(_Strict):
    name: str
    location_kind: str | None = None
    evidence_paragraph_ids: list[str]
    confidence: float = Field(ge=0.0, le=1.0)


class ObjectCandidate(_Strict):
    name: str
    significance: str | None = None
    custody_character_key: str | None = None
    evidence_paragraph_ids: list[str]
    confidence: float = Field(ge=0.0, le=1.0)


class FactionCandidate(_Strict):
    name: str
    summary: str | None = None
    evidence_paragraph_ids: list[str]
    confidence: float = Field(ge=0.0, le=1.0)


class ThreadCandidate(_Strict):
    kind: ThreadKind
    summary: str | None = None
    known_to_keys: list[str] = Field(default_factory=list)
    evidence_paragraph_ids: list[str]
    confidence: float = Field(ge=0.0, le=1.0)


class TimelineEventCandidate(_Strict):
    title: str
    summary: str | None = None
    span_kind: SpanKindLiteral = "NORMAL"
    in_story_time_marker: str | None = None
    evidence_paragraph_ids: list[str]
    confidence: float = Field(ge=0.0, le=1.0)


class ChapterAnalysisResult(_Strict):
    characters: list[CharacterMention] = Field(default_factory=list)
    scenes: list[SceneBoundary]
    relationships: list[RelationshipCandidate] = Field(default_factory=list)
    locations: list[LocationCandidate] = Field(default_factory=list)
    objects: list[ObjectCandidate] = Field(default_factory=list)
    factions: list[FactionCandidate] = Field(default_factory=list)
    threads: list[ThreadCandidate] = Field(default_factory=list)
    timeline_events: list[TimelineEventCandidate] = Field(default_factory=list)
    pov_type: PovTypeLiteral | None = None


class ModelIdentity(_Strict):
    """The (role, provider_id, model_id, version) tuple a `ModelVersion` row is looked
    up by -- the same identity shape `ingestion.ts`'s `resolveModelVersionId` uses."""

    role: Literal["LLM"] = "LLM"
    provider_id: str
    model_id: str
    version: str
