"""Consumes `generate_voice_preview` (`api-specification.md` §16.14, `tts-provider-
specification.md` §47).

A preview is disposable and outside every audiobook lineage: it never creates or touches a
`TtsJob` or an `AudioChunk`, only its own `VoicePreview` row. It MUST render with the exact
same provider, model version, and generation parameters production would use for that
`VoiceProfileVersion` (§47.1) — no override, which is why this handler builds its
`SynthesisRequest` from `voice_profile_version.base_generation_params` alone, never from a
second, request-supplied parameter set.
"""

from __future__ import annotations

from typing import Any

from worker_gpu.repo import model_registry, reads_tts, writes_tts
from worker_gpu.tts import (
    PerformanceIntent,
    SpeakerReference,
    SynthesisRequest,
    TTSProvider,
    TtsErrorCode,
    VoiceCache,
    VoiceReferenceKind,
    classify_provider_error,
    to_job_error,
)
from worker_gpu.tts.synth import synthesize_and_check
from workers_common.logging import get_logger
from workers_common.queue import JobContext, TerminalJobError

log = get_logger(__name__)


async def handle_generate_voice_preview(
    ctx: JobContext, *, provider: TTSProvider, voice_cache: VoiceCache
) -> None:
    payload: dict[str, Any] = ctx.envelope.payload
    job_id = str(ctx.envelope.job_id)
    preview_id = str(payload["preview_id"])

    async with ctx.db.session() as session:
        job = await reads_tts.load_job(session, job_id)
        if job is None:
            raise TerminalJobError(f"ProcessingJob {job_id} not found", error_code="JOB_NOT_FOUND")
        if job.status in ("SUCCEEDED", "FAILED"):
            return

        preview = await reads_tts.load_voice_preview(session, preview_id)
        if preview is None:
            raise TerminalJobError(f"VoicePreview {preview_id} not found", error_code="VOICE_PREVIEW_NOT_FOUND")
        if preview.status in ("READY", "FAILED", "EXPIRED"):
            log.info("preview.already_terminal_skip", preview_id=preview_id, status=preview.status)
            await writes_tts.mark_job_succeeded(
                session, job_id, result_resource_type="voice_preview", result_resource_id=preview_id
            )
            return

        voice_version = await reads_tts.load_voice_profile_version(
            session, preview.voice_profile_version_id
        )
        if voice_version is None:
            raise TerminalJobError(
                "Bound VoiceProfileVersion not found", error_code=TtsErrorCode.MISSING_VOICE_PROFILE.value
            )

        loaded_model_version_id = await model_registry.resolve_model_version_id(
            session, provider.model_identity
        )
        if loaded_model_version_id != voice_version.tts_model_version_id:
            raise TerminalJobError(
                "This worker's loaded model does not match the voice's bound model.",
                error_code=TtsErrorCode.MODEL_NOT_FOUND.value,
            )

        await writes_tts.mark_job_running(session, job_id)

    capabilities = provider.capabilities()
    request = SynthesisRequest(
        audio_script_chunk_id=preview.id,
        audio_script_chunk_version=1,
        audio_script_id=preview.id,
        tts_job_id=preview.id,
        correlation_id=job.correlation_id,
        job_id=job_id,
        text=preview.text_excerpt,
        language=voice_version.language,
        voice_profile_id=voice_version.voice_profile_id,
        voice_profile_version_id=voice_version.id,
        speaker_reference=_speaker_reference(voice_version),
        tts_provider_id=voice_version.tts_provider_id,
        tts_model_version_id=voice_version.tts_model_version_id,
        # §47.1 — production parameters, verbatim. No preview-specific override exists.
        performance=PerformanceIntent(speaker_type="CHARACTER", emotion=preview.emotion),
        generation_params=voice_version.base_generation_params,
        generation_params_hash=voice_version.base_generation_params_hash,
        seed=None,
        target_sample_rate=capabilities.native_sample_rate,
        target_channels=1,
    )

    try:
        outcome = await synthesize_and_check(provider, request, voice_cache)
    except Exception as exc:  # noqa: BLE001 - §79.2
        tts_error = classify_provider_error(exc)
        if ctx.is_final_attempt:
            async with ctx.db.session() as session:
                await writes_tts.mark_voice_preview_failed(
                    session, preview_id, error_code=tts_error.code.value, error_message=str(tts_error)
                )
                await writes_tts.mark_job_failed(
                    session, job_id, error_code=tts_error.code.value,
                    error_message=str(tts_error), retryable=tts_error.retryable,
                )
        raise to_job_error(tts_error) from exc

    storage_key = f"{job.tenant_id}/previews/{voice_version.id}/{preview.id}.wav"
    try:
        checksum = await ctx.storage.put(storage_key, outcome.result.audio_wav, content_type="audio/wav")
    except Exception as exc:  # noqa: BLE001
        raise to_job_error(classify_provider_error(exc)) from exc

    gap = outcome.result.capability_gaps[0].model_dump(mode="json") if outcome.result.capability_gaps else None

    async with ctx.db.session() as session:
        await writes_tts.mark_voice_preview_ready(
            session,
            preview_id,
            duration_ms=outcome.result.duration_ms,
            sample_rate=outcome.result.sample_rate,
            storage_key=storage_key,
            storage_bucket=ctx.storage.bucket,
            content_hash=checksum.sha256,
            size_bytes=checksum.size_bytes,
            capability_gap=gap,
        )
        await writes_tts.mark_job_succeeded(
            session, job_id, result_resource_type="voice_preview", result_resource_id=preview_id
        )
        await writes_tts.write_voice_event(
            session,
            event_type="voice.preview_ready",
            tenant_id=preview.tenant_id,
            correlation_id=job.correlation_id,
            aggregate_id=preview_id,
            book_id=preview.book_id,
            job_id=job_id,
            payload={
                "voice_profile_version_id": voice_version.id,
                "preview_id": preview_id,
                "duration_ms": outcome.result.duration_ms,
                "sample_rate": outcome.result.sample_rate,
                "emotion": preview.emotion,
                "capability_gap": gap,
            },
        )

    log.info("generate_voice_preview.completed", job_id=job_id, preview_id=preview_id)


def _speaker_reference(voice_version: Any) -> SpeakerReference:
    if voice_version.embedding_storage_key:
        return SpeakerReference(
            kind=VoiceReferenceKind.EMBEDDING,
            object_key=voice_version.embedding_storage_key,
            content_hash=voice_version.embedding_content_hash,
            extractor_model_version_id=voice_version.embedding_extractor_model_version_id,
        )
    if voice_version.reference_audio_storage_key:
        return SpeakerReference(
            kind=VoiceReferenceKind.REFERENCE_AUDIO,
            object_key=voice_version.reference_audio_storage_key,
            content_hash=voice_version.reference_audio_content_hash,
        )
    return SpeakerReference(kind=VoiceReferenceKind.LIBRARY)


__all__ = ["handle_generate_voice_preview"]
