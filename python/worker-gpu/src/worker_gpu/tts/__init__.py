"""The TTS Provider Runtime (Phase 5).

Public surface: `TTSProvider` (the interface every adapter satisfies), the provider-neutral
request/result schemas, the capability negotiation engine, the error taxonomy, the voice
cache, and the config/factory pair that selects a concrete adapter. Handler code
(`worker_gpu.handlers.generate_tts_chunk`) imports from here, never from
`worker_gpu.tts.providers.*` directly.
"""

from __future__ import annotations

from worker_gpu.tts.capability import CAPABILITY_MAP_VERSION, Negotiation, SynthesisControls, negotiate
from worker_gpu.tts.config import TtsConfig, TtsProviderKind, load_tts_config
from worker_gpu.tts.errors import CLASSIFICATION, Classification, TtsError, TtsErrorCode, classify_provider_error, to_job_error
from worker_gpu.tts.factory import build_tts_provider
from worker_gpu.tts.provider import TTSProvider
from worker_gpu.tts.schemas import (
    CapabilityGap,
    CapabilityHandling,
    EmotionControl,
    ModelIdentity,
    PerformanceIntent,
    PronunciationHint,
    ProviderCapabilities,
    ProviderHealth,
    ProviderVoiceHandle,
    ResourceEstimate,
    SpeakerReference,
    SupportLevel,
    SynthesisRequest,
    SynthesisResult,
    VoiceReferenceKind,
    VoiceValidation,
)
from worker_gpu.tts.text_prep import PreparedText, prepare_text
from worker_gpu.tts.voice_cache import VoiceCache

__all__ = [
    "CAPABILITY_MAP_VERSION",
    "CLASSIFICATION",
    "CapabilityGap",
    "CapabilityHandling",
    "Classification",
    "EmotionControl",
    "ModelIdentity",
    "Negotiation",
    "PerformanceIntent",
    "PreparedText",
    "PronunciationHint",
    "ProviderCapabilities",
    "ProviderHealth",
    "ProviderVoiceHandle",
    "ResourceEstimate",
    "SpeakerReference",
    "SupportLevel",
    "SynthesisControls",
    "SynthesisRequest",
    "SynthesisResult",
    "TTSProvider",
    "TtsConfig",
    "TtsError",
    "TtsErrorCode",
    "TtsProviderKind",
    "VoiceCache",
    "VoiceReferenceKind",
    "VoiceValidation",
    "build_tts_provider",
    "classify_provider_error",
    "load_tts_config",
    "negotiate",
    "prepare_text",
    "to_job_error",
]
