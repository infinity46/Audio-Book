"""Provider-independent semantic analysis: the `SemanticAnalyzer` seam, a deterministic
default implementation, an OpenAI-compatible HTTP adapter, and structured I/O schemas.
"""

from worker_ai.semantic.analyzer import SemanticAnalyzer
from worker_ai.semantic.config import SemanticAnalyzerProvider, SemanticConfig, load_semantic_config
from worker_ai.semantic.provider import build_semantic_analyzer
from worker_ai.semantic.schemas import AnalyzeChapterInput, ChapterAnalysisResult, ModelIdentity

__all__ = [
    "AnalyzeChapterInput",
    "ChapterAnalysisResult",
    "ModelIdentity",
    "SemanticAnalyzer",
    "SemanticAnalyzerProvider",
    "SemanticConfig",
    "build_semantic_analyzer",
    "load_semantic_config",
]
