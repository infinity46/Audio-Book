"""The provider-independent semantic analysis seam.

Mirrors `context.md` §23 row 16's `LLMProvider`-shaped interface and
`workers_common.runtime.ModelProvider`'s spirit: domain code (the `analyze_scene`
handler) depends on this Protocol only, never on `deterministic.py` or
`openai_compatible.py` directly, so swapping the implementation is a configuration
change (`provider.py`), not a change to handler/persistence logic.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from worker_ai.semantic.schemas import AnalyzeChapterInput, ChapterAnalysisResult, ModelIdentity


@runtime_checkable
class SemanticAnalyzer(Protocol):
    @property
    def model_identity(self) -> ModelIdentity:
        """The exact model identity to stamp on every row this analyzer produces.

        Resolved against `ModelRegistry`/`ModelVersion` by the handler before any
        persistence -- an unregistered identity is a terminal failure (no
        provenance-less write), matching `ingestion.ts`'s `resolveModelVersionId`.
        """
        ...

    async def analyze_chapter(self, chapter_input: AnalyzeChapterInput) -> ChapterAnalysisResult:
        """Analyze one chapter's paragraphs, given bounded prior context.

        Must return a schema-valid `ChapterAnalysisResult` or raise. Never partially
        valid data -- persistence trusts everything it receives here.
        """
        ...
