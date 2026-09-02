"""Orchestration tests for `handle_generate_tts_chunk` -- see `conftest.py` for why these
monkeypatch the `worker_gpu.repo` layer rather than hitting a real Postgres. The provider
itself is the real `MockTTSProvider` (fast, deterministic, no GPU) so the actual
synthesize/validate/upload path is exercised end-to-end, not mocked away.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock

import pytest

from worker_gpu.handlers import generate_tts_chunk as handler_module
from worker_gpu.repo import model_registry, reads_tts, writes_tts
from worker_gpu.tts import VoiceCache
from worker_gpu.tts.providers.mock import MockTTSProvider
from workers_common.events import SimpleJobEnvelope
from workers_common.queue import JobContext

JOB_ID = str(uuid.uuid4())
TTS_JOB_ID = str(uuid.uuid4())
CHUNK_ID = str(uuid.uuid4())
BOOK_ID = str(uuid.uuid4())
TENANT_ID = str(uuid.uuid4())
CORRELATION_ID = str(uuid.uuid4())
VOICE_VERSION_ID = str(uuid.uuid4())
MODEL_VERSION_ID = str(uuid.uuid4())
AUDIO_SCRIPT_ID = str(uuid.uuid4())
CHAPTER_ID = str(uuid.uuid4())
STORY_BIBLE_VERSION_ID = str(uuid.uuid4())
BOOK_VERSION_ID = str(uuid.uuid4())


def _ctx(fake_db: Any, fake_storage: Any, *, attempt: int = 1, max_attempts: int = 3) -> JobContext:
    envelope = SimpleJobEnvelope(
        job_id=uuid.UUID(JOB_ID),
        entity_id=uuid.UUID(TTS_JOB_ID),
        correlation_id=uuid.UUID(CORRELATION_ID),
        causation_id=uuid.UUID(CORRELATION_ID),
        tenant_id=uuid.UUID(TENANT_ID),
        payload={"tts_job_id": TTS_JOB_ID},
    )
    return JobContext(
        envelope=envelope,
        message_type="generate_tts_chunk",
        db=fake_db,  # type: ignore[arg-type]
        storage=fake_storage,  # type: ignore[arg-type]
        settings=None,  # type: ignore[arg-type]
        attempt=attempt,
        max_attempts=max_attempts,
    )


def _job_row() -> reads_tts.JobRow:
    return reads_tts.JobRow(
        id=JOB_ID, tenant_id=TENANT_ID, book_id=BOOK_ID, status="QUEUED", correlation_id=CORRELATION_ID
    )


def _tts_job_row(*, status: str = "PENDING") -> reads_tts.TtsJobRow:
    return reads_tts.TtsJobRow(
        id=TTS_JOB_ID,
        tenant_id=TENANT_ID,
        book_id=BOOK_ID,
        audio_script_chunk_id=CHUNK_ID,
        audio_script_chunk_version=1,
        processing_job_id=JOB_ID,
        tts_provider_id="mock-tts",
        tts_model_version_id=MODEL_VERSION_ID,
        voice_profile_id="profile-1",
        voice_profile_version_id=VOICE_VERSION_ID,
        generation_params={},
        generation_params_hash="a" * 64,
        seed=42,
        target_sample_rate=24_000,
        target_channels=1,
        status=status,
        dedupe_key="b" * 64,
        forced=False,
        force_token=None,
    )


def _chunk_row() -> reads_tts.AudioScriptChunkRow:
    return reads_tts.AudioScriptChunkRow(
        id=CHUNK_ID,
        tenant_id=TENANT_ID,
        book_id=BOOK_ID,
        audio_script_id=AUDIO_SCRIPT_ID,
        chapter_id=CHAPTER_ID,
        scene_id=None,
        character_id=None,
        sequence_index=0,
        version=1,
        state="VALIDATED",
        text="The old ferryman looked out over the grey water.",
        spoken_text=None,
        language="en-US",
        speaker_type="NARRATOR",
        is_dialogue=False,
        delivery_mode="NORMAL",
        emotion="NEUTRAL",
        emotion_intensity=0.0,
        pacing=1.0,
        pitch=0.0,
        volume=0.0,
        pauses=[],
        emphasis=[],
        pronunciation_hints=[],
        non_verbal=None,
        voice_profile_id="profile-1",
        voice_profile_version_id=VOICE_VERSION_ID,
        generation_params=None,
        seed=42,
        target_sample_rate=24_000,
        target_channels=1,
        source_content_hash="c" * 64,
        schema_version="ir.v1",
        director_version="director.v1",
        director_model_version_id=str(uuid.uuid4()),
        story_bible_version_id=STORY_BIBLE_VERSION_ID,
    )


def _voice_version_row() -> reads_tts.VoiceProfileVersionRow:
    return reads_tts.VoiceProfileVersionRow(
        id=VOICE_VERSION_ID,
        voice_profile_id="profile-1",
        tts_provider_id="mock-tts",
        tts_model_id="mock-tone",
        tts_model_version_id=MODEL_VERSION_ID,
        language="en-US",
        supported_languages=["en-US"],
        base_generation_params={},
        base_generation_params_hash="a" * 64,
        reference_audio_storage_key=None,
        reference_audio_content_hash=None,
        embedding_storage_key=None,
        embedding_content_hash=None,
        embedding_extractor_model_version_id=None,
        emotion_capability_map=None,
        approval_state="APPROVED",
        lock_state="UNLOCKED",
    )


def _patch_common(monkeypatch: pytest.MonkeyPatch, *, existing_audio_chunk: str | None = None) -> None:
    monkeypatch.setattr(reads_tts, "load_job", AsyncMock(return_value=_job_row()))
    monkeypatch.setattr(reads_tts, "load_tts_job", AsyncMock(return_value=_tts_job_row()))
    monkeypatch.setattr(reads_tts, "load_audio_script_chunk", AsyncMock(return_value=_chunk_row()))
    monkeypatch.setattr(reads_tts, "find_current_audio_chunk", AsyncMock(return_value=existing_audio_chunk))
    monkeypatch.setattr(reads_tts, "load_voice_profile_version", AsyncMock(return_value=_voice_version_row()))
    monkeypatch.setattr(model_registry, "resolve_model_version_id", AsyncMock(return_value=MODEL_VERSION_ID))
    monkeypatch.setattr(
        reads_tts,
        "load_audio_script",
        AsyncMock(return_value=reads_tts.AudioScriptRow(id=AUDIO_SCRIPT_ID, book_version_id=BOOK_VERSION_ID)),
    )
    monkeypatch.setattr(reads_tts, "next_generation_version", AsyncMock(return_value=1))
    monkeypatch.setattr(writes_tts, "mark_job_running", AsyncMock())
    monkeypatch.setattr(writes_tts, "mark_job_succeeded", AsyncMock())
    monkeypatch.setattr(writes_tts, "mark_job_failed", AsyncMock())
    monkeypatch.setattr(writes_tts, "mark_tts_job_failed", AsyncMock())
    monkeypatch.setattr(writes_tts, "begin_tts_job", AsyncMock())
    monkeypatch.setattr(writes_tts, "insert_audio_chunk", AsyncMock(return_value=None))
    monkeypatch.setattr(writes_tts, "write_tts_event", AsyncMock())


async def _loaded_mock_provider() -> MockTTSProvider:
    provider = MockTTSProvider()
    await provider.load_model(MODEL_VERSION_ID)
    return provider


async def test_happy_path_inserts_audio_chunk_and_marks_job_succeeded(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_storage: Any
) -> None:
    _patch_common(monkeypatch)
    provider = await _loaded_mock_provider()
    ctx = _ctx(fake_db, fake_storage)

    await handler_module.handle_generate_tts_chunk(ctx, provider=provider, voice_cache=VoiceCache(max_size=8))

    writes_tts.insert_audio_chunk.assert_awaited_once()  # type: ignore[attr-defined]
    writes_tts.mark_job_succeeded.assert_awaited_once()  # type: ignore[attr-defined]
    writes_tts.write_tts_event.assert_awaited_once()  # type: ignore[attr-defined]
    event_kwargs = writes_tts.write_tts_event.await_args.kwargs  # type: ignore[attr-defined]
    assert event_kwargs["event_type"] == "tts.chunk_completed"
    assert len(fake_storage.puts) == 1
    key, data, content_type = fake_storage.puts[0]
    assert key == f"{TENANT_ID}/books/{BOOK_ID}/audio/chunks/{CHUNK_ID}/v1.wav"
    assert content_type == "audio/wav"
    assert len(data) > 0


async def test_idempotent_skip_does_not_synthesize_when_audio_chunk_already_exists(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_storage: Any
) -> None:
    """§42.2 -- a current AudioChunk already matching this exact lineage means no
    synthesis is needed at all."""
    existing_id = str(uuid.uuid4())
    _patch_common(monkeypatch, existing_audio_chunk=existing_id)
    provider = AsyncMock()  # any call into the provider would fail this test
    ctx = _ctx(fake_db, fake_storage)

    await handler_module.handle_generate_tts_chunk(ctx, provider=provider, voice_cache=VoiceCache(max_size=8))

    provider.synthesize.assert_not_awaited()
    provider.prepare_voice.assert_not_awaited()
    assert fake_storage.puts == []
    writes_tts.mark_job_succeeded.assert_awaited_once()  # type: ignore[attr-defined]
    call = writes_tts.mark_job_succeeded.await_args  # type: ignore[attr-defined]
    assert call.args[1] == JOB_ID
    assert call.kwargs == {"result_resource_type": "audio_chunk", "result_resource_id": existing_id}


async def test_already_terminal_tts_job_is_skipped(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_storage: Any
) -> None:
    _patch_common(monkeypatch)
    monkeypatch.setattr(reads_tts, "load_tts_job", AsyncMock(return_value=_tts_job_row(status="SUCCEEDED")))
    provider = AsyncMock()
    ctx = _ctx(fake_db, fake_storage)

    await handler_module.handle_generate_tts_chunk(ctx, provider=provider, voice_cache=VoiceCache(max_size=8))

    provider.synthesize.assert_not_awaited()
    writes_tts.mark_job_succeeded.assert_awaited_once()  # type: ignore[attr-defined]


async def test_unapproved_voice_version_raises_terminal_error(
    monkeypatch: pytest.MonkeyPatch, fake_db: Any, fake_storage: Any
) -> None:
    """§48.1 -- production synthesis never targets a DRAFT/PREVIEW_GENERATED version,
    even if a queue message somehow arrives claiming to."""
    import dataclasses

    from workers_common.queue import TerminalJobError

    _patch_common(monkeypatch)
    draft_voice = dataclasses.replace(_voice_version_row(), approval_state="DRAFT")
    monkeypatch.setattr(reads_tts, "load_voice_profile_version", AsyncMock(return_value=draft_voice))
    provider = AsyncMock()
    ctx = _ctx(fake_db, fake_storage)

    with pytest.raises(TerminalJobError):
        await handler_module.handle_generate_tts_chunk(ctx, provider=provider, voice_cache=VoiceCache(max_size=8))
    provider.synthesize.assert_not_awaited()
