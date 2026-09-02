"""Selects the `DirectorModelProvider` implementation from configuration.

The one place `deterministic.py` vs `openai_compatible.py` is chosen --
domain code (handlers) never imports either concrete class directly, only
this factory's result typed as `DirectorModelProvider`. Mirrors
`semantic/provider.py` exactly.
"""

from __future__ import annotations

from worker_ai.director.analyzer import DirectorModelProvider
from worker_ai.director.config import DirectorConfig, DirectorModelProviderKind
from worker_ai.director.deterministic import DeterministicDirectorProvider
from worker_ai.director.openai_compatible import OpenAiCompatibleDirectorProvider


def build_director_provider(config: DirectorConfig) -> DirectorModelProvider:
    if config.director_model_provider is DirectorModelProviderKind.DETERMINISTIC:
        return DeterministicDirectorProvider()

    base_url, api_key, model_name = config.require_openai_compatible_fields()
    return OpenAiCompatibleDirectorProvider(
        base_url=base_url,
        api_key=api_key,
        model_name=model_name,
        timeout_seconds=config.director_llm_timeout_seconds,
    )
