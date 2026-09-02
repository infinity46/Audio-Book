"""worker-ai-only Director configuration.

Deliberately NOT part of `workers_common.config.WorkerSettings`, and
deliberately its OWN env var namespace rather than reusing
`SemanticConfig`'s `LLM_API_*` variables -- a deployment may want a
different model/endpoint for narrative-understanding extraction than for
performance interpretation (different latency/cost/accuracy tradeoffs), and
folding them together would make that impossible to configure independently.
Loaded independently, the same fail-fast way
`workers_common.config.load_settings_or_exit()` loads everything else (see
`semantic/config.py`'s docstring for the same reasoning, applied here).
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class DirectorModelProviderKind(StrEnum):
    DETERMINISTIC = "deterministic"
    OPENAI_COMPATIBLE = "openai_compatible"


class DirectorConfig(BaseSettings):
    """`DIRECTOR_MODEL_PROVIDER` and, when using `openai_compatible`, its endpoint.

    `deterministic` is the default -- every automated test uses it, and it is
    what `docker-compose.yml`'s `MODEL_ID: stub-director-v0` comment
    anticipates as the local/dev/CI default (no GPU/LLM backend required).
    """

    model_config = SettingsConfigDict(env_file=None, extra="ignore", frozen=True)

    director_model_provider: DirectorModelProviderKind = Field(
        default=DirectorModelProviderKind.DETERMINISTIC,
    )
    director_llm_api_base_url: str | None = Field(
        default=None,
        description="Base URL of an OpenAI-compatible /chat/completions endpoint "
        "used for performance interpretation specifically.",
    )
    director_llm_api_key: SecretStr | None = Field(default=None)
    director_llm_model_name: str | None = Field(default=None)
    director_llm_timeout_seconds: float = Field(default=60.0, gt=0)

    # §28.2: `director_version` identifies the WHOLE decision bundle (prompt
    # templates, chunking rules, validation rules, provider) as a single
    # label. Bumping any part of this package requires bumping this string --
    # never silently changing behavior under an existing label.
    director_version: str = Field(default="director.v1")

    def require_openai_compatible_fields(self) -> tuple[str, str | None, str]:
        if not self.director_llm_api_base_url or not self.director_llm_model_name:
            raise ValueError(
                "DIRECTOR_MODEL_PROVIDER=openai_compatible requires "
                "DIRECTOR_LLM_API_BASE_URL and DIRECTOR_LLM_MODEL_NAME to be set."
            )
        api_key = (
            self.director_llm_api_key.get_secret_value() if self.director_llm_api_key else None
        )
        return self.director_llm_api_base_url, api_key, self.director_llm_model_name


def load_director_config() -> DirectorConfig:
    return DirectorConfig()
