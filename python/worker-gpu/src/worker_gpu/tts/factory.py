"""The one place a concrete `TTSProvider` class is chosen (§88 rule 9-11).

Mirrors `worker_ai/director/provider.py`'s `build_director_provider` exactly: domain and
handler code only ever import `TTSProvider` (the Protocol); this function is the sole
caller that imports a concrete adapter class.
"""

from __future__ import annotations

from worker_gpu.tts.config import TtsConfig, TtsProviderKind
from worker_gpu.tts.provider import TTSProvider


def build_tts_provider(config: TtsConfig) -> TTSProvider:
    if config.tts_provider is TtsProviderKind.MOCK:
        from worker_gpu.tts.providers.mock import MockTTSProvider  # noqa: PLC0415

        return MockTTSProvider(model_version=config.tts_model_version)

    if config.tts_provider is TtsProviderKind.KOKORO:
        from worker_gpu.tts.providers.kokoro import KokoroProvider  # noqa: PLC0415

        model_path, voices_path = config.require_kokoro_fields()
        return KokoroProvider(
            model_path=model_path,
            voices_path=voices_path,
            model_version=config.tts_model_version,
        )

    raise ValueError(f"Unknown TTS_PROVIDER: {config.tts_provider!r}")


__all__ = ["build_tts_provider"]
