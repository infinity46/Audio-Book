"""Worker-local voice cache (§8.1, §92-§96).

`prepare_voice()` is expensive (an embedding fetch, or decoding reference audio) and its
result is stable for the lifetime of a `(VoiceProfileVersion, provider, model)` triple
(§9.1). This cache is what makes §17.1 step 4 true -- "cached per (worker, VoiceProfile-
Version) with an LRU" -- instead of every chunk re-resolving its voice.

Bounded, not unbounded (§94, §95): a 50+ character book must not grow this cache without
limit, so eviction is plain LRU by insertion/access order. Eviction calls back into the
provider so VRAM-resident state (a loaded embedding, a decoded reference tensor) is
actually released, not just dropped from a Python dict while the engine still holds it.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Awaitable, Callable

from worker_gpu.tts.schemas import ProviderVoiceHandle

CacheKey = tuple[str, str, str]


class VoiceCache:
    """LRU cache of `ProviderVoiceHandle`, keyed by `(voice_profile_version_id, provider_id,
    tts_model_version_id)` -- §93: never reuse a handle prepared for a different provider
    or model, since an embedding is not portable across either (§9.3)."""

    def __init__(self, *, max_size: int, on_evict: Callable[[ProviderVoiceHandle], Awaitable[None]] | None = None) -> None:
        if max_size < 1:
            raise ValueError("VoiceCache max_size must be at least 1.")
        self._max_size = max_size
        self._entries: OrderedDict[CacheKey, ProviderVoiceHandle] = OrderedDict()
        self._on_evict = on_evict

    def get(self, key: CacheKey) -> ProviderVoiceHandle | None:
        handle = self._entries.get(key)
        if handle is not None:
            self._entries.move_to_end(key)
        return handle

    async def put(self, handle: ProviderVoiceHandle) -> None:
        key = handle.cache_key
        if key in self._entries:
            self._entries.move_to_end(key)
            self._entries[key] = handle
            return
        self._entries[key] = handle
        while len(self._entries) > self._max_size:
            _, evicted = self._entries.popitem(last=False)
            if self._on_evict is not None:
                await self._on_evict(evicted)

    def __len__(self) -> int:
        return len(self._entries)

    def __contains__(self, key: CacheKey) -> bool:
        return key in self._entries


__all__ = ["CacheKey", "VoiceCache"]
