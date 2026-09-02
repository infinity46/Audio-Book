"""Provider-neutral TTS contracts (`tts-provider-specification.md` §3-§5).

Every type here is engine-independent by construction. Nothing in this module -- and
nothing outside a provider adapter -- may name XTTS, Kokoro, CUDA, torch, or any other
engine concept (§88 rule 9).

The one deliberate shaping of §5.1: `SynthesisResult.audio_wav` carries the produced bytes
in-process, and is excluded from every serialisation and repr. §5.2's rule is that no
result *leaving the process* ever carries audio -- the bytes go to object storage and the
result carries `audio_object_key` instead, which the worker fills in after a verified
upload. Excluding the field rather than putting the bytes in a second parallel type keeps
`synthesize()`'s signature exactly as §3.2 specifies while making "these bytes must not
travel" a property of the type instead of a convention.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# The closed vocabularies, owned upstream (`director-specification.md` §4.1 for emotion,
# `audio-script-ir.md` for delivery mode) and mirrored by the `emotion`/`delivery_mode`
# Postgres enums. Duplicated here as tuples only so the capability map can be proven
# exhaustive in a test; never extended locally (§33.3).
EMOTIONS: tuple[str, ...] = (
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
)

DELIVERY_MODES: tuple[str, ...] = (
    "NORMAL",
    "INTERNAL_THOUGHT",
    "WHISPER",
    "SHOUT",
    "LAUGHING",
    "CRYING",
    "SINGING",
    "READING_ALOUD",
)


class CapabilityHandling(StrEnum):
    """§32.1. Exactly three levels; `DEGRADED`/`UNKNOWN` were rejected upstream."""

    NATIVE = "NATIVE"
    APPROXIMATED = "APPROXIMATED"
    UNSUPPORTED = "UNSUPPORTED"


class SupportLevel(StrEnum):
    """§33.2's one narrowly-scoped addition: whether a provider exposes a *mechanism* at
    all. Never used as a fidelity scale -- that is `CapabilityHandling`."""

    SUPPORTED = "SUPPORTED"
    UNSUPPORTED = "UNSUPPORTED"


class EmotionControl(StrEnum):
    """§3.3 `emotion_control` -- how (or whether) the engine expresses emotion."""

    NONE = "NONE"
    TAGS = "TAGS"
    CONDITIONING = "CONDITIONING"


class VoiceReferenceKind(StrEnum):
    """Which of §7.1's representations a `VoiceProfileVersion` actually resolves to.

    The core never branches on this; only an adapter's `prepare_voice()` does (§7.2).
    """

    LIBRARY = "LIBRARY"
    EMBEDDING = "EMBEDDING"
    REFERENCE_AUDIO = "REFERENCE_AUDIO"


class ModelIdentity(BaseModel):
    """The (role, provider_id, model_id, version) tuple `model_registry` is keyed by.

    Structurally identical to worker-ai's Director/semantic identities, which is what lets
    `repo.model_registry.resolve_model_version_id` be shared unchanged.
    """

    model_config = ConfigDict(frozen=True, protected_namespaces=())

    role: Literal["TTS"] = "TTS"
    provider_id: str
    model_id: str
    version: str


class ProviderCapabilities(BaseModel):
    """§3.3. A declaration, verified at certification (§73), never probed mid-request."""

    model_config = ConfigDict(frozen=True, protected_namespaces=())

    models: tuple[str, ...]
    languages: tuple[str, ...]
    max_input_chars: int = Field(gt=0)
    native_sample_rate: int = Field(gt=0)
    supports_reference_audio: bool
    supports_embedding: bool
    supports_streaming: bool
    emotion_control: EmotionControl
    deterministic_seed: bool
    max_batch: int = Field(ge=1)
    supports_pitch_control: bool
    supports_speed_control: bool
    supports_ssml: bool
    supports_phoneme_input: bool

    def supports_language(self, language: str) -> bool:
        """BCP-47 match, tolerating region refinement: a provider declaring `en` serves
        `en-GB`, but one declaring only `en-GB` does not serve `fr-FR` (§61.2).

        `"*"` is a legitimate declaration for a provider that is genuinely
        language-agnostic at the mechanism level (e.g. a tone-based dev/CI provider) —
        never used by a real speech engine, which always has a finite trained set.
        """
        if "*" in self.languages:
            return True
        if language in self.languages:
            return True
        primary = language.split("-", 1)[0]
        return any(tag == primary or tag.split("-", 1)[0] == primary for tag in self.languages)


class CapabilityGap(BaseModel):
    """§35.1's record shape, verbatim: `{ field, requested, handling, note }`.

    Persisted onto `tts_job.capability_gaps` and `audio_chunk.capability_gaps`, and carried
    on `tts.chunk_completed`. Never absent -- an empty list means nothing degraded (§5.1).
    """

    model_config = ConfigDict(frozen=True)

    field: str
    requested: str
    handling: CapabilityHandling
    note: str


class PronunciationHint(BaseModel):
    """One IR pronunciation annotation (`audio-script-ir.md` §25-§26).

    The IR's canonical representation is IPA, or a `lexicon_key` that resolves to IPA. The
    adapter -- never this layer -- translates it into whatever the engine consumes (§31.2).
    """

    model_config = ConfigDict(frozen=True, extra="ignore")

    text: str | None = None
    char_start: int | None = None
    char_end: int | None = None
    ipa: str | None = None
    lexicon_key: str | None = None


class PerformanceIntent(BaseModel):
    """The IR's semantic performance fields, exactly as the Director decided them.

    Provider-neutral by construction: no engine parameter names appear here, and none may
    be added (`audio-script-ir.md` §38.4, §41.2).
    """

    model_config = ConfigDict(frozen=True, extra="ignore")

    speaker_type: str
    character_id: str | None = None
    is_dialogue: bool = False
    delivery_mode: str = "NORMAL"
    emotion: str = "NEUTRAL"
    emotion_intensity: float = 0.0
    pacing: float = 1.0
    pitch: float = 0.0
    volume: float = 0.0
    pauses: tuple[dict[str, Any], ...] = ()
    emphasis: tuple[dict[str, Any], ...] = ()
    pronunciation_hints: tuple[PronunciationHint, ...] = ()
    non_verbal: tuple[dict[str, Any], ...] = ()


class SpeakerReference(BaseModel):
    """§17.2's object-storage reference, as it arrives on the command payload.

    Bytes never travel on the queue; this is the pointer the adapter resolves in
    `prepare_voice()`, and `content_hash` is verified before the object is used (§17.2).
    """

    model_config = ConfigDict(frozen=True, extra="ignore")

    kind: VoiceReferenceKind
    object_key: str | None = None
    bucket: str | None = None
    content_hash: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None
    extractor_model_version_id: str | None = None


class SynthesisRequest(BaseModel):
    """§4.1. Enough to reproduce a generation, and nothing more.

    This is the `generate_tts_chunk` payload (`event-contracts.md` §16.1) as the worker
    consumes it -- not a second copy fetched independently (§4.1).
    """

    model_config = ConfigDict(frozen=True, extra="ignore", protected_namespaces=())

    # identity
    audio_script_chunk_id: str
    audio_script_chunk_version: int
    audio_script_id: str
    tts_job_id: str
    correlation_id: str
    job_id: str

    # content
    text: str
    language: str
    script: str | None = None

    # speaker / voice identity
    voice_profile_id: str
    voice_profile_version_id: str
    speaker_reference: SpeakerReference

    # model
    tts_provider_id: str
    tts_model_version_id: str

    # performance instructions
    performance: PerformanceIntent

    # generation configuration
    generation_params: dict[str, Any] = Field(default_factory=dict)
    generation_params_hash: str
    seed: int | None = None
    target_sample_rate: int
    target_channels: int


class ProviderVoiceHandle(BaseModel):
    """§6.1's fourth box: what a `VoiceProfileVersion` becomes for one specific engine.

    `payload` is opaque outside the adapter that produced it (an embedding array, a decoded
    reference waveform, a model-native speaker id). Nothing outside the adapter inspects it,
    which is what keeps §7.2's "the core does not depend on one representation" true.
    """

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    voice_profile_version_id: str
    provider_id: str
    tts_model_version_id: str
    kind: VoiceReferenceKind
    payload: Any = Field(default=None, repr=False)

    @property
    def cache_key(self) -> tuple[str, str, str]:
        """§93: a cached voice is only valid for the exact provider+model it was prepared
        against -- an embedding is not portable across either (§9.3)."""
        return (self.voice_profile_version_id, self.provider_id, self.tts_model_version_id)


class SynthesisResult(BaseModel):
    """§5.1. The adapter's return value: transient, in-process, not an `AudioChunk` (§5.3).

    `audio_wav` holds the produced bytes for the worker to upload and is excluded from every
    dump and repr, because §5.2 forbids audio travelling anywhere but object storage.
    `audio_object_key` is filled in by the worker *after* the upload is verified.
    """

    model_config = ConfigDict(protected_namespaces=())

    tts_job_id: str
    audio_script_chunk_id: str
    generation_version: int

    provider_id: str
    tts_model_version_id: str
    voice_profile_version_id: str

    audio_wav: bytes = Field(repr=False, exclude=True)
    audio_object_key: str | None = None
    format: Literal["WAV"] = "WAV"
    sample_rate: int
    channels: int
    duration_ms: int
    content_hash: str | None = None

    generation_latency_ms: int
    provider_metadata: dict[str, Any] = Field(default_factory=dict)

    capability_gaps: tuple[CapabilityGap, ...] = ()
    seed_used: int | None = None


class ResourceEstimate(BaseModel):
    """§19.4. Advisory scheduling input, explicitly not a commitment -- which is why the
    OOM retry ladder (§56.2) exists at all."""

    model_config = ConfigDict(frozen=True)

    vram_mb: int
    estimated_duration_ms: int


class VoiceValidation(BaseModel):
    """§7.4's cheap precondition result. A mismatch is a scheduling-time rejection, never a
    wasted inference attempt."""

    model_config = ConfigDict(frozen=True)

    valid: bool
    reason: str | None = None


class ProviderHealth(BaseModel):
    """§3.2 `health()`, mirroring the worker control surface of `api-specification.md`
    §18.2."""

    model_config = ConfigDict(frozen=True, protected_namespaces=())

    status: Literal["AVAILABLE", "DEGRADED", "UNAVAILABLE"]
    loaded_models: tuple[str, ...] = ()
    vram_free_mb: int | None = None


__all__ = [
    "DELIVERY_MODES",
    "EMOTIONS",
    "CapabilityGap",
    "CapabilityHandling",
    "EmotionControl",
    "ModelIdentity",
    "PerformanceIntent",
    "PronunciationHint",
    "ProviderCapabilities",
    "ProviderHealth",
    "ProviderVoiceHandle",
    "ResourceEstimate",
    "SpeakerReference",
    "SupportLevel",
    "SynthesisRequest",
    "SynthesisResult",
    "VoiceReferenceKind",
    "VoiceValidation",
]
