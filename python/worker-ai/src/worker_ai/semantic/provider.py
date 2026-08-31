"""Selects the `SemanticAnalyzer` implementation from configuration.

The one place `deterministic.py` vs `openai_compatible.py` is chosen -- domain code
(handlers) never imports either concrete class directly, only this factory's result
typed as `SemanticAnalyzer` (task instruction: "Do not hard-code a single LLM provider
into domain logic").
"""

from __future__ import annotations

from worker_ai.semantic.analyzer import SemanticAnalyzer
from worker_ai.semantic.config import SemanticAnalyzerProvider, SemanticConfig
from worker_ai.semantic.deterministic import DeterministicSemanticAnalyzer
from worker_ai.semantic.openai_compatible import OpenAiCompatibleSemanticAnalyzer


def build_semantic_analyzer(config: SemanticConfig) -> SemanticAnalyzer:
    if config.semantic_analyzer_provider is SemanticAnalyzerProvider.DETERMINISTIC:
        return DeterministicSemanticAnalyzer()

    base_url, api_key, model_name = config.require_openai_compatible_fields()
    return OpenAiCompatibleSemanticAnalyzer(
        base_url=base_url,
        api_key=api_key,
        model_name=model_name,
        timeout_seconds=config.llm_timeout_seconds,
    )
