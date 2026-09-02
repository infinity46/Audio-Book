"""worker-gpu-only TTS provider configuration.

Mirrors `worker_ai/director/config.py` exactly: its own env var namespace, loaded
independently and fail-fast, `mock` as the default so every automated test and the local
Compose stack run with no GPU and no model weights (`deployment-architecture.md` §6, §39).
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class TtsProviderKind(StrEnum):
    MOCK = "mock"
    KOKORO = "kokoro"


class TtsConfig(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore", frozen=True, protected_namespaces=())

    tts_provider: TtsProviderKind = Field(default=TtsProviderKind.MOCK)

    # `kokoro` only. Paths to the ONNX model and voices files a deployment has already
    # fetched and pinned — this worker never downloads model weights during inference
    # (`tts-provider-specification.md` §31.1, mirroring `context.md` §10.4 step 1).
    kokoro_model_path: str | None = Field(default=None)
    kokoro_voices_path: str | None = Field(default=None)

    # Identifies the exact `model_version` row this worker is certified against
    # (§13.1) — never "latest". Matches `MockTTSProvider`'s own default and
    # `infra/scripts/seed.ts`'s `TTS_MODEL_VERSIONS` entry, so a worker started with
    # no TTS_* env vars at all resolves against a seeded ModelVersion out of the box.
    tts_model_version: str = Field(default="v1")

    # §8.1/§92-96: bounded so a large cast cannot grow VRAM/memory without limit.
    voice_cache_size: int = Field(default=64, ge=1, le=4096)

    def require_kokoro_fields(self) -> tuple[str, str]:
        if not self.kokoro_model_path or not self.kokoro_voices_path:
            raise ValueError(
                "TTS_PROVIDER=kokoro requires KOKORO_MODEL_PATH and KOKORO_VOICES_PATH to be set."
            )
        return self.kokoro_model_path, self.kokoro_voices_path


def load_tts_config() -> TtsConfig:
    return TtsConfig()


__all__ = ["TtsConfig", "TtsProviderKind", "load_tts_config"]
