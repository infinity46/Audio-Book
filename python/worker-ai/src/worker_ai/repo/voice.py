"""Voice-binding resolution: `character_id -> voice_profile_version_id`.

`director-specification.md` §17.3 describes this as an "internal endpoint"
the Director calls. No such HTTP endpoint (or any voice module at all)
exists in `apps/api` yet, and no worker in this codebase calls the API over
HTTP for a DB-backed lookup -- every other retrieval (Story Bible, Character
Registry, Narrative State) goes straight to Postgres via a `repo/` module.
This module follows that same, already-established pattern rather than
inventing a new service boundary: it performs exactly the resolution §17.3
specifies (current, active `VoiceAssignment` -> its `VoiceProfileVersion`,
gated on `approval_state`), just as a plain repository read.

The Director RESOLVES a voice; it never creates, approves, or locks one
(task §30, §165) -- this module is read-only.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True, slots=True)
class VoiceBinding:
    voice_profile_id: str
    voice_profile_version_id: str
    tts_provider_id: str
    generation_params: dict[str, object]
    generation_params_hash: str


async def _find_active_assignment(
    session: AsyncSession, *, book_id: str, character_id: str, role: str
) -> VoiceBinding | None:
    row = (
        await session.execute(
            text(
                """
                SELECT va.voice_profile_id, va.voice_profile_version_id,
                       vpv.approval_state, vpv.tts_provider_id,
                       vpv.base_generation_params, vpv.base_generation_params_hash
                FROM voice_assignment va
                JOIN voice_profile_version vpv ON vpv.id = va.voice_profile_version_id
                WHERE va.book_id = :book_id AND va.character_id = :character_id
                  AND va.role = :role AND va.is_active = true
                  AND va.superseded_by_assignment_id IS NULL
                ORDER BY va.assigned_at DESC LIMIT 1
                """
            ),
            {"book_id": book_id, "character_id": character_id, "role": role},
        )
    ).first()
    if row is None:
        return None
    approval_state = row[2]
    if approval_state not in ("APPROVED", "LOCKED"):
        return None
    return VoiceBinding(
        voice_profile_id=str(row[0]),
        voice_profile_version_id=str(row[1]),
        tts_provider_id=row[3],
        generation_params=row[4] or {},
        generation_params_hash=row[5],
    )


async def resolve_voice_binding(
    session: AsyncSession,
    *,
    book_id: str,
    speaker_type: str,
    character_id: str,
    narrator_character_id: str,
) -> tuple[VoiceBinding | None, bool]:
    """Resolves the voice for a chunk's already-resolved speaker.

    Returns `(binding, fallback_applied)`. `binding` is `None` only when
    neither the character's own voice NOR the book's narrator voice is
    castable -- the caller (`ir_builder.py`) must then apply the
    `VOICE_PROFILE_MISSING` / `CAPABILITY_GAP` handling of task §161/§165,
    never invent or reuse an unrelated character's voice.

    `director-specification.md` §16.2: narrator resolution uses the
    IDENTICAL code path as character voice resolution -- both go through
    `_find_active_assignment`, just against a different `(character_id,
    role)` pair.

    Single-chunk convenience wrapper around `preload_voice_bindings` --
    prefer that bulk loader plus `resolve_voice_binding_from_cache` when
    resolving many chunks in a chapter (task §211's N+1 audit): this
    per-call version issues its own queries and is intended for callers
    resolving one chunk in isolation (e.g. the internal Director dry-run).
    """
    if speaker_type == "CHARACTER":
        binding = await _find_active_assignment(
            session, book_id=book_id, character_id=character_id, role="CHARACTER"
        )
        if binding is not None:
            return binding, False

    # Fallback (or the natural narrator path): the book's narrator voice.
    # §14.1-14.2: an unresolved/uncastable speaker renders with the narrator
    # voice as a DOCUMENTED fallback, never left unvoiced and never
    # borrowing another character's specific voice.
    narrator_binding = await _find_active_assignment(
        session, book_id=book_id, character_id=narrator_character_id, role="NARRATOR"
    )
    fallback_applied = speaker_type != "NARRATOR" or character_id != narrator_character_id
    return narrator_binding, fallback_applied


async def preload_voice_bindings(
    session: AsyncSession, *, book_id: str, character_ids: list[str], narrator_character_id: str
) -> dict[str, VoiceBinding]:
    """One query for every known character's `CHARACTER`-role binding, plus
    the narrator's `NARRATOR`-role binding -- called ONCE per chapter, never
    per chunk (task §211: "avoid... for every segment: query voice")."""
    ids = list(dict.fromkeys([*character_ids, narrator_character_id]))
    if not ids:
        return {}
    rows = (
        await session.execute(
            text(
                """
                SELECT va.character_id, va.role, va.voice_profile_id, va.voice_profile_version_id,
                       vpv.approval_state, vpv.tts_provider_id,
                       vpv.base_generation_params, vpv.base_generation_params_hash
                FROM voice_assignment va
                JOIN voice_profile_version vpv ON vpv.id = va.voice_profile_version_id
                WHERE va.book_id = :book_id AND va.character_id = ANY(:ids)
                  AND va.is_active = true AND va.superseded_by_assignment_id IS NULL
                  AND (
                    (va.character_id = :narrator_id AND va.role = 'NARRATOR')
                    OR (va.character_id != :narrator_id AND va.role = 'CHARACTER')
                  )
                ORDER BY va.assigned_at DESC
                """
            ),
            {"book_id": book_id, "ids": ids, "narrator_id": narrator_character_id},
        )
    ).all()
    bindings: dict[str, VoiceBinding] = {}
    for row in rows:
        character_id = str(row[0])
        if character_id in bindings:
            continue  # ORDER BY assigned_at DESC -- first row seen per id is the newest
        approval_state = row[4]
        if approval_state not in ("APPROVED", "LOCKED"):
            continue
        bindings[character_id] = VoiceBinding(
            voice_profile_id=str(row[2]),
            voice_profile_version_id=str(row[3]),
            tts_provider_id=row[5],
            generation_params=row[6] or {},
            generation_params_hash=row[7],
        )
    return bindings


def resolve_voice_binding_from_cache(
    *,
    speaker_type: str,
    character_id: str,
    narrator_character_id: str,
    bindings_by_character: dict[str, VoiceBinding],
) -> tuple[VoiceBinding | None, bool]:
    """Pure, no-DB-access equivalent of `resolve_voice_binding`, against a
    dict already loaded by `preload_voice_bindings`."""
    if speaker_type == "CHARACTER":
        binding = bindings_by_character.get(character_id)
        if binding is not None:
            return binding, False

    narrator_binding = bindings_by_character.get(narrator_character_id)
    fallback_applied = speaker_type != "NARRATOR" or character_id != narrator_character_id
    return narrator_binding, fallback_applied
