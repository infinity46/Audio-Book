"""The provider-independent Director performance-interpretation seam.

Mirrors `semantic/analyzer.py`'s `SemanticAnalyzer` Protocol exactly: domain
code (the `generate_director_ir` handler) depends on this Protocol only,
never on `deterministic.py` or `openai_compatible.py` directly -- swapping
the implementation is a configuration change (`provider.py`), not a change
to handler/persistence logic (task instruction: "must not couple the
Director directly to Kokoro, XTTS, or any specific TTS engine" extends, by
the same reasoning, to not coupling it to any specific LLM either).
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from worker_ai.director.schemas import ModelIdentity, PerformanceChunkInput, PerformanceDecision


@runtime_checkable
class DirectorModelProvider(Protocol):
    @property
    def model_identity(self) -> ModelIdentity:
        """The exact model identity stamped on every chunk this provider decides.

        Resolved against `ModelRegistry`/`ModelVersion` by the handler before
        any persistence -- an unregistered identity is a terminal failure,
        matching `semantic/analyzer.py`'s identical contract.
        """
        ...

    async def decide_performance(
        self, chunk_input: PerformanceChunkInput
    ) -> PerformanceDecision:
        """Decide performance intent for ONE chunk, given already-resolved
        speaker context and bounded scene/previous-state context.

        Must return a schema-valid `PerformanceDecision` or raise. Never
        partially valid data -- persistence trusts everything it receives.
        Must NOT invent narrative content: the input `text` is performed,
        never rewritten, summarized, or extended.
        """
        ...
