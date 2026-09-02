"""Unit tests for `VoiceCache` (§8.1, §92-§96): bounded LRU with an eviction callback."""

from __future__ import annotations

from worker_gpu.tts.schemas import ProviderVoiceHandle, VoiceReferenceKind
from worker_gpu.tts.voice_cache import VoiceCache


def _handle(voice_id: str, provider_id: str = "mock-tts", model_id: str = "model-1") -> ProviderVoiceHandle:
    return ProviderVoiceHandle(
        voice_profile_version_id=voice_id,
        provider_id=provider_id,
        tts_model_version_id=model_id,
        kind=VoiceReferenceKind.LIBRARY,
    )


async def test_get_returns_none_for_missing_key() -> None:
    cache = VoiceCache(max_size=2)
    assert cache.get(("missing", "mock-tts", "model-1")) is None


async def test_put_then_get_round_trips() -> None:
    cache = VoiceCache(max_size=2)
    handle = _handle("voice-a")
    await cache.put(handle)
    assert cache.get(handle.cache_key) is handle


async def test_different_provider_or_model_is_a_different_cache_entry() -> None:
    """§93: an embedding is not portable across provider or model."""
    cache = VoiceCache(max_size=4)
    handle_a = _handle("voice-a", provider_id="mock-tts")
    handle_b = _handle("voice-a", provider_id="kokoro-v1")
    await cache.put(handle_a)
    await cache.put(handle_b)
    assert len(cache) == 2
    assert cache.get(handle_a.cache_key) is handle_a
    assert cache.get(handle_b.cache_key) is handle_b


async def test_eviction_is_least_recently_used() -> None:
    """§94-§96: bounded so a large cast cannot grow memory without limit."""
    cache = VoiceCache(max_size=2)
    a, b, c = _handle("voice-a"), _handle("voice-b"), _handle("voice-c")
    await cache.put(a)
    await cache.put(b)
    cache.get(a.cache_key)  # touch a, so b becomes the least-recently-used entry
    await cache.put(c)  # evicts b, not a
    assert cache.get(a.cache_key) is a
    assert cache.get(b.cache_key) is None
    assert cache.get(c.cache_key) is c


async def test_eviction_calls_the_release_callback() -> None:
    evicted: list[ProviderVoiceHandle] = []

    async def on_evict(handle: ProviderVoiceHandle) -> None:
        evicted.append(handle)

    cache = VoiceCache(max_size=1, on_evict=on_evict)
    a, b = _handle("voice-a"), _handle("voice-b")
    await cache.put(a)
    await cache.put(b)
    assert evicted == [a]


async def test_reinserting_the_same_key_does_not_grow_or_evict() -> None:
    cache = VoiceCache(max_size=1)
    handle = _handle("voice-a")
    await cache.put(handle)
    await cache.put(handle)
    assert len(cache) == 1
