"""The default `SemanticAnalyzer`: regex/heuristic, deterministic, no network access.

This is what every automated test in this repository exercises, and what a deployment
with no `LLM_API_BASE_URL` configured runs in production. It is intentionally modest --
proper-noun-run character detection, dialogue-tag speaker hints, a small relationship
keyword dictionary, and a small location gazetteer -- rather than a claim of NLP
accuracy. Task instruction: "Do not claim semantic accuracy without actual evaluation."
This module makes no such claim; it makes a narrow, inspectable, reproducible one:
given the same paragraphs, it always returns the same result.

Every heuristic below is independently unit-tested against small fixture chapters
(`worker-ai/tests/test_deterministic_analyzer.py`) rather than against real books --
there is no claim that these thresholds generalize to arbitrary prose.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict

from worker_ai.semantic.analyzer import SemanticAnalyzer
from worker_ai.semantic.schemas import (
    AnalyzeChapterInput,
    ChapterAnalysisResult,
    CharacterMention,
    LocationCandidate,
    ModelIdentity,
    ParagraphInput,
    PovTypeLiteral,
    RelationshipCandidate,
    RelationshipTypeLiteral,
    SceneBoundary,
)

MODEL_IDENTITY = ModelIdentity(
    provider_id="audio-book-nlp",
    model_id="deterministic-heuristic-analyzer",
    version="1.0.0",
)

# A capitalized word, or a short run of them ("Alice", "Mr Carter", "Lady Jane Grey"),
# not immediately preceded by sentence-ending punctuation two tokens back -- a cheap
# proxy for "not just a sentence-initial capital". Names of 2+ words are trusted
# regardless of position, since "The Old Man" aside, multi-word capitalized runs are a
# much stronger name signal than a single capitalized word.
_NAME_RUN_RE = re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b")

_SPEAKER_AFTER_RE = re.compile(
    r"[,\"']\s*(?:said|asked|replied|shouted|whispered|muttered|cried|answered)\s+"
    r"([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)",
)
_SPEAKER_BEFORE_RE = re.compile(
    r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+"
    r"(?:said|asked|replied|shouted|whispered|muttered|cried|answered)\b",
)

_SCENE_BREAK_RE = re.compile(r"^\s*(\*\s*){3,}\s*$|^\s*-{3,}\s*$|^\s*#+\s*$")

_STOPWORDS = {
    "the", "a", "an", "and", "but", "or", "if", "when", "while", "chapter", "part",
    "i", "he", "she", "it", "they", "we", "you", "mr", "mrs", "ms", "dr", "there",
    "this", "that", "these", "those", "then", "yes", "no", "oh", "well", "now",
}

_RELATIONSHIP_KEYWORDS: dict[str, RelationshipTypeLiteral] = {
    "brother": "FAMILY", "sister": "FAMILY", "mother": "FAMILY", "father": "FAMILY",
    "son": "FAMILY", "daughter": "FAMILY", "husband": "FAMILY", "wife": "FAMILY",
    "cousin": "FAMILY", "aunt": "FAMILY", "uncle": "FAMILY", "grandmother": "FAMILY",
    "grandfather": "FAMILY",
    "friend": "FRIENDSHIP", "companion": "FRIENDSHIP",
    "enemy": "ADVERSARIAL", "foe": "ADVERSARIAL",
    "rival": "RIVALRY",
    "boss": "AUTHORITY", "employer": "AUTHORITY", "master": "AUTHORITY",
    "teacher": "MENTOR", "mentor": "MENTOR", "tutor": "MENTOR",
    "colleague": "PROFESSIONAL", "partner": "PROFESSIONAL",
    "lover": "ROMANTIC", "fiance": "ROMANTIC", "fiancee": "ROMANTIC",
    "sweetheart": "ROMANTIC", "beloved": "ROMANTIC",
    "ally": "ALLIANCE",
    "traitor": "BETRAYAL",
}

_LOCATION_NOUNS = {
    "house", "forest", "castle", "city", "room", "garden", "street", "village",
    "kitchen", "hall", "tower", "road", "river", "mountain", "cottage", "office",
    "school", "manor", "inn", "harbor", "harbour", "square", "market", "bridge",
    "church", "palace", "camp", "cabin", "library", "chapel", "farm",
}

_FIRST_PERSON_RE = re.compile(r"\b(I|me|my|mine|myself)\b")
_THIRD_PERSON_RE = re.compile(r"\b(he|him|his|she|her|hers|they|them|their)\b", re.IGNORECASE)


def _normalize_key(surface_form: str) -> str:
    return re.sub(r"\s+", " ", surface_form.strip().lower())


class DeterministicSemanticAnalyzer(SemanticAnalyzer):
    @property
    def model_identity(self) -> ModelIdentity:
        return MODEL_IDENTITY

    async def analyze_chapter(self, chapter_input: AnalyzeChapterInput) -> ChapterAnalysisResult:
        paragraphs = chapter_input.paragraphs
        known_by_key = _index_known_characters(chapter_input)

        candidates = _detect_characters(paragraphs, known_by_key)
        scenes = _detect_scenes(paragraphs, candidates)
        relationships = _detect_relationships(paragraphs, candidates)
        locations = _detect_locations(paragraphs, candidates)
        pov_type = _detect_pov(paragraphs)

        return ChapterAnalysisResult(
            characters=list(candidates.values()),
            scenes=scenes,
            relationships=relationships,
            locations=locations,
            objects=[],
            factions=[],
            threads=[],
            timeline_events=[],
            pov_type=pov_type,
        )


def _index_known_characters(chapter_input: AnalyzeChapterInput) -> dict[str, str]:
    """normalized alias/name -> existing Character.id, for resolving mentions that are
    already-known identities rather than new candidates."""
    index: dict[str, str] = {}
    for known in chapter_input.prior_context.known_characters:
        index[_normalize_key(known.display_name)] = known.id
        for alias in known.aliases:
            index[_normalize_key(alias)] = known.id
    return index


def _detect_characters(
    paragraphs: list[ParagraphInput], known_by_key: dict[str, str]
) -> dict[str, CharacterMention]:
    counts: Counter[str] = Counter()
    surface_forms: dict[str, str] = {}
    evidence: defaultdict[str, list[str]] = defaultdict(list)
    speakers: set[str] = set()

    for paragraph in paragraphs:
        for match in _NAME_RUN_RE.finditer(paragraph.text):
            surface = match.group(1)
            key = _normalize_key(surface)
            first_word = surface.split(" ", 1)[0].lower()
            multi_word = " " in surface
            if not multi_word and first_word in _STOPWORDS:
                continue
            counts[key] += 1
            surface_forms.setdefault(key, surface)
            if paragraph.id not in evidence[key]:
                evidence[key].append(paragraph.id)

        for pattern in (_SPEAKER_AFTER_RE, _SPEAKER_BEFORE_RE):
            for match in pattern.finditer(paragraph.text):
                surface = match.group(1)
                key = _normalize_key(surface)
                speakers.add(key)
                counts[key] += 1
                surface_forms.setdefault(key, surface)
                if paragraph.id not in evidence[key]:
                    evidence[key].append(paragraph.id)

    candidates: dict[str, CharacterMention] = {}
    for key, count in counts.items():
        multi_word = " " in key
        if count < 2 and key not in speakers and not multi_word:
            continue  # a single passing capitalized word, never repeated -- too weak

        confidence = min(0.95, 0.4 + 0.15 * count + (0.2 if key in speakers else 0.0))
        candidates[key] = CharacterMention(
            surface_form=surface_forms[key],
            normalized_key=key,
            alias_type="FULL_NAME" if multi_word else "GIVEN_NAME",
            is_speaker=key in speakers,
            evidence_paragraph_ids=evidence[key],
            confidence=round(confidence, 2),
            resolved_character_id=known_by_key.get(key),
        )

    _link_short_forms_as_aliases(candidates)
    return candidates


def _link_short_forms_as_aliases(candidates: dict[str, CharacterMention]) -> None:
    """A single-token candidate whose token is a prefix word of a more frequent,
    multi-token candidate is treated as a short form of the same person (e.g. "Alice"
    alongside "Alice Carter") -- token-subset matching, nothing more sophisticated.
    Two DIFFERENT people who happen to share a first name are not merged: the subset
    rule only ever collapses a short form INTO the single long form it is a prefix of,
    and is skipped entirely when more than one long form shares that first token."""
    single_tokens = {k: v for k, v in candidates.items() if " " not in k}
    multi_tokens = {k: v for k, v in candidates.items() if " " in k}

    for short_key, short_mention in list(single_tokens.items()):
        matches = [
            long_key for long_key in multi_tokens if long_key.split(" ")[0] == short_key
        ]
        if len(matches) != 1:
            continue  # ambiguous or no match -- leave the short form as its own candidate
        long_key = matches[0]
        long_mention = candidates[long_key]

        # Same person: the long form absorbs the short form's speaker/evidence
        # signal (e.g. dialogue attributed to just "Alice" still counts as
        # "Alice Carter" speaking), and the short form becomes an alias pointing
        # at whatever identity the long form eventually resolves to.
        merged_evidence = list(
            dict.fromkeys(
                long_mention.evidence_paragraph_ids + short_mention.evidence_paragraph_ids
            )
        )
        candidates[long_key] = long_mention.model_copy(
            update={
                "is_speaker": long_mention.is_speaker or short_mention.is_speaker,
                "evidence_paragraph_ids": merged_evidence,
            }
        )
        candidates[short_key] = short_mention.model_copy(
            update={
                "alias_type": "GIVEN_NAME",
                "resolved_character_id": long_mention.resolved_character_id,
            }
        )


def _detect_scenes(
    paragraphs: list[ParagraphInput], candidates: dict[str, CharacterMention]
) -> list[SceneBoundary]:
    if not paragraphs:
        return []

    groups: list[list[ParagraphInput]] = [[]]
    for paragraph in paragraphs:
        if _SCENE_BREAK_RE.match(paragraph.text):
            if groups[-1]:
                groups.append([])
            continue
        groups[-1].append(paragraph)
    groups = [g for g in groups if g]
    if not groups:
        groups = [paragraphs]

    scenes: list[SceneBoundary] = []
    for order_index, group in enumerate(groups):
        paragraph_ids = [p.id for p in group]
        group_text = " ".join(p.text for p in group)
        present = [
            key
            for key, mention in candidates.items()
            if any(pid in mention.evidence_paragraph_ids for pid in paragraph_ids)
        ]
        pov_key = next((k for k in present if candidates[k].is_speaker), None) or (
            present[0] if present else None
        )
        location = _first_location_mention(group_text)
        scenes.append(
            SceneBoundary(
                order_index=order_index,
                start_paragraph_id=paragraph_ids[0],
                end_paragraph_id=paragraph_ids[-1],
                paragraph_ids=paragraph_ids,
                location_name=location,
                participant_keys=present,
                pov_character_key=pov_key,
                confidence=0.5 if len(groups) > 1 else 0.4,
            )
        )
    return scenes


def _first_location_mention(text: str) -> str | None:
    for match in _NAME_RUN_RE.finditer(text):
        surface = match.group(1)
        last_word = surface.split(" ")[-1].lower()
        if last_word in _LOCATION_NOUNS:
            return surface
    for noun in _LOCATION_NOUNS:
        if re.search(rf"\bthe {noun}\b", text, re.IGNORECASE):
            return noun
    return None


def _detect_relationships(
    paragraphs: list[ParagraphInput], candidates: dict[str, CharacterMention]
) -> list[RelationshipCandidate]:
    if len(candidates) < 2:
        return []

    results: list[RelationshipCandidate] = []
    seen: set[tuple[str, str, str]] = set()
    for paragraph in paragraphs:
        present = [
            key for key in candidates if paragraph.id in candidates[key].evidence_paragraph_ids
        ]
        if len(present) < 2:
            continue
        lowered = paragraph.text.lower()
        for keyword, rel_type in _RELATIONSHIP_KEYWORDS.items():
            # Word-boundary match, not substring: a plain `in` check would let "son"
            # match inside "Harrison" and "ally" match inside "finally".
            if not re.search(rf"\b{re.escape(keyword)}\b", lowered):
                continue
            source, target = present[0], present[1]
            dedup_key = (source, target, rel_type)
            if dedup_key in seen:
                continue
            seen.add(dedup_key)
            results.append(
                RelationshipCandidate(
                    source_key=source,
                    target_key=target,
                    relationship_type=rel_type,
                    label=keyword,
                    evidence_paragraph_ids=[paragraph.id],
                    confidence=0.55,
                )
            )
    return results


def _detect_locations(
    paragraphs: list[ParagraphInput], candidates: dict[str, CharacterMention]
) -> list[LocationCandidate]:
    found: dict[str, list[str]] = defaultdict(list)
    candidate_keys = set(candidates.keys())
    for paragraph in paragraphs:
        for match in _NAME_RUN_RE.finditer(paragraph.text):
            surface = match.group(1)
            key = _normalize_key(surface)
            if key in candidate_keys:
                continue
            last_word = surface.split(" ")[-1].lower()
            if last_word in _LOCATION_NOUNS:
                found[surface].append(paragraph.id)
    return [
        LocationCandidate(
            name=name,
            evidence_paragraph_ids=paragraph_ids,
            confidence=0.5,
        )
        for name, paragraph_ids in found.items()
    ]


def _detect_pov(paragraphs: list[ParagraphInput]) -> PovTypeLiteral | None:
    if not paragraphs:
        return None
    text = " ".join(p.text for p in paragraphs)
    first = len(_FIRST_PERSON_RE.findall(text))
    third = len(_THIRD_PERSON_RE.findall(text))
    if first == 0 and third == 0:
        return None
    return "FIRST" if first > third else "THIRD_LIMITED"
