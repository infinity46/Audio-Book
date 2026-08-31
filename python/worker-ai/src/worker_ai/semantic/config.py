"""worker-ai-only semantic-analyzer configuration.

Deliberately NOT part of `workers_common.config.WorkerSettings` -- that struct is shared
and validated identically by worker-gpu, which has no use for an LLM endpoint. Folding
these fields into it would force worker-gpu deployments to also supply (or explicitly
not-supply) LLM configuration that means nothing to them. Loaded independently, the same
fail-fast way `workers_common.config.load_settings_or_exit()` loads everything else.

Per `context.md` §23 row 16 ("local via Ollama/vLLM in dev, hosted API in production,
both behind one `LLMProvider`-shaped interface"): `openai_compatible` covers both of
those deployment shapes with one adapter, since Ollama/vLLM both speak the OpenAI
chat-completions wire format. `deterministic` needs no network access at all and is the
default -- every automated test uses it, and it is what a deployment with no LLM
credentials configured falls back to.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class SemanticAnalyzerProvider(StrEnum):
    DETERMINISTIC = "deterministic"
    OPENAI_COMPATIBLE = "openai_compatible"


class SemanticConfig(BaseSettings):
    """`SEMANTIC_ANALYZER_PROVIDER` and, when using `openai_compatible`, its endpoint."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore", frozen=True)

    semantic_analyzer_provider: SemanticAnalyzerProvider = Field(
        default=SemanticAnalyzerProvider.DETERMINISTIC,
    )
    llm_api_base_url: str | None = Field(
        default=None,
        description="Base URL of an OpenAI-compatible /chat/completions endpoint "
        "(OpenAI itself, Azure OpenAI, or a local vLLM/Ollama server).",
    )
    llm_api_key: SecretStr | None = Field(default=None)
    llm_model_name: str | None = Field(default=None)
    llm_timeout_seconds: float = Field(default=60.0, gt=0)

    def require_openai_compatible_fields(self) -> tuple[str, str | None, str]:
        """Validates the three fields `openai_compatible` needs are all present.

        Raises `ValueError` rather than starting with a half-configured adapter that
        would only fail on the first real job -- the same fail-fast posture
        `workers_common.config` uses for every other required value.
        """
        if not self.llm_api_base_url or not self.llm_model_name:
            raise ValueError(
                "SEMANTIC_ANALYZER_PROVIDER=openai_compatible requires "
                "LLM_API_BASE_URL and LLM_MODEL_NAME to be set."
            )
        api_key = self.llm_api_key.get_secret_value() if self.llm_api_key else None
        return self.llm_api_base_url, api_key, self.llm_model_name


def load_semantic_config() -> SemanticConfig:
    return SemanticConfig()
