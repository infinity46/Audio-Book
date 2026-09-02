"""The Director: provider-independent performance interpretation (speaker
resolution, emotion/pacing/delivery decisions), semantic chunking, and Audio
Script IR validation. Consumes Story Bible / Character Registry / Narrative
State (Phase 3); produces validated `AudioScriptChunk` rows (Phase 4). Does
not perform TTS inference (Phase 5).
"""

from worker_ai.director.analyzer import DirectorModelProvider
from worker_ai.director.config import (
    DirectorConfig,
    DirectorModelProviderKind,
    load_director_config,
)
from worker_ai.director.provider import build_director_provider
from worker_ai.director.schemas import (
    ModelIdentity,
    PerformanceChunkInput,
    PerformanceDecision,
    PreviousPerformanceState,
    SceneContext,
    SpeakerContext,
)

__all__ = [
    "DirectorConfig",
    "DirectorModelProvider",
    "DirectorModelProviderKind",
    "ModelIdentity",
    "PerformanceChunkInput",
    "PerformanceDecision",
    "PreviousPerformanceState",
    "SceneContext",
    "SpeakerContext",
    "build_director_provider",
    "load_director_config",
]
