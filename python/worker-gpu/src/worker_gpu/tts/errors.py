"""The TTS error taxonomy (`tts-provider-specification.md` §78) and its classification.

§78.2 is the binding rule this module exists to make mechanical: **every code carries
exactly one classification**, and none is left unclassified. `CLASSIFICATION` is therefore
exhaustive over `TtsErrorCode` and a test asserts that it stays so.

§79.2's rule -- an adapter maps its engine's native error surface onto these codes before
anything outside the adapter sees it -- is served by `classify_provider_error`, which is
the one place a raw engine string is inspected. Everything downstream reasons about
`GPU_OUT_OF_MEMORY`, never about a CUDA message.
"""

from __future__ import annotations

from enum import StrEnum

from workers_common.queue import TerminalJobError, TransientJobError


class TtsErrorCode(StrEnum):
    """§78.1's table, verbatim. New codes are introduced here and nowhere else."""

    INVALID_AUDIO_SCRIPT = "INVALID_AUDIO_SCRIPT"
    VOICE_NOT_FOUND = "VOICE_NOT_FOUND"
    VOICE_VERSION_INVALID = "VOICE_VERSION_INVALID"
    MISSING_VOICE_PROFILE = "MISSING_VOICE_PROFILE"
    VOICE_MODEL_INCOMPATIBLE = "VOICE_MODEL_INCOMPATIBLE"
    MODEL_NOT_FOUND = "MODEL_NOT_FOUND"
    MODEL_LOAD_FAILED = "MODEL_LOAD_FAILED"
    GPU_OUT_OF_MEMORY = "GPU_OUT_OF_MEMORY"
    GPU_UNAVAILABLE = "GPU_UNAVAILABLE"
    VOICE_LANGUAGE_MISMATCH = "VOICE_LANGUAGE_MISMATCH"
    UNSUPPORTED_TTS_CAPABILITY = "UNSUPPORTED_TTS_CAPABILITY"
    PROVIDER_TIMEOUT = "PROVIDER_TIMEOUT"
    PROVIDER_RATE_LIMIT = "PROVIDER_RATE_LIMIT"
    SYNTHESIS_FAILED = "SYNTHESIS_FAILED"
    AUDIO_CORRUPTED = "AUDIO_CORRUPTED"
    AUDIO_VALIDATION_FAILED = "AUDIO_VALIDATION_FAILED"
    OUTPUT_STORAGE_FAILED = "OUTPUT_STORAGE_FAILED"
    VOICE_MODEL_UNAVAILABLE = "VOICE_MODEL_UNAVAILABLE"
    VOICE_CONSISTENCY_VIOLATION = "VOICE_CONSISTENCY_VIOLATION"
    ARTIFACT_UPLOAD_UNVERIFIED = "ARTIFACT_UPLOAD_UNVERIFIED"
    INVALID_SOURCE_HASH = "INVALID_SOURCE_HASH"


class Classification(StrEnum):
    """§78.2. `HUMAN_REVIEW_REQUIRED` is an escalation after bounded retries, never a first
    response, so nothing in the retry path may produce it directly."""

    RETRYABLE = "RETRYABLE"
    NON_RETRYABLE = "NON_RETRYABLE"
    HUMAN_REVIEW_REQUIRED = "HUMAN_REVIEW_REQUIRED"


CLASSIFICATION: dict[TtsErrorCode, Classification] = {
    TtsErrorCode.INVALID_AUDIO_SCRIPT: Classification.NON_RETRYABLE,
    TtsErrorCode.VOICE_NOT_FOUND: Classification.NON_RETRYABLE,
    TtsErrorCode.VOICE_VERSION_INVALID: Classification.NON_RETRYABLE,
    TtsErrorCode.MISSING_VOICE_PROFILE: Classification.NON_RETRYABLE,
    TtsErrorCode.VOICE_MODEL_INCOMPATIBLE: Classification.NON_RETRYABLE,
    TtsErrorCode.MODEL_NOT_FOUND: Classification.NON_RETRYABLE,
    # §78.1: terminal for THIS worker, retryable at job level via a different worker --
    # which is what a transient classification expresses here, since BullMQ's retry is
    # what re-routes it (`event-contracts.md` §21.4 "different worker where possible").
    TtsErrorCode.MODEL_LOAD_FAILED: Classification.RETRYABLE,
    TtsErrorCode.GPU_OUT_OF_MEMORY: Classification.RETRYABLE,
    TtsErrorCode.GPU_UNAVAILABLE: Classification.RETRYABLE,
    TtsErrorCode.VOICE_LANGUAGE_MISMATCH: Classification.NON_RETRYABLE,
    TtsErrorCode.UNSUPPORTED_TTS_CAPABILITY: Classification.NON_RETRYABLE,
    TtsErrorCode.PROVIDER_TIMEOUT: Classification.RETRYABLE,
    TtsErrorCode.PROVIDER_RATE_LIMIT: Classification.RETRYABLE,
    TtsErrorCode.SYNTHESIS_FAILED: Classification.RETRYABLE,
    TtsErrorCode.AUDIO_CORRUPTED: Classification.RETRYABLE,
    # §28.3/§21.3: a validation VERDICT is deterministic. Re-running the same check on the
    # same bytes finds the same fault, so it never retries -- it triggers regeneration,
    # which is a different operation on different input.
    TtsErrorCode.AUDIO_VALIDATION_FAILED: Classification.NON_RETRYABLE,
    TtsErrorCode.OUTPUT_STORAGE_FAILED: Classification.RETRYABLE,
    TtsErrorCode.VOICE_MODEL_UNAVAILABLE: Classification.NON_RETRYABLE,
    TtsErrorCode.VOICE_CONSISTENCY_VIOLATION: Classification.NON_RETRYABLE,
    TtsErrorCode.ARTIFACT_UPLOAD_UNVERIFIED: Classification.NON_RETRYABLE,
    TtsErrorCode.INVALID_SOURCE_HASH: Classification.NON_RETRYABLE,
}


class TtsError(RuntimeError):
    """A failure already mapped onto the taxonomy.

    Adapters raise this; the handler converts it into the queue's transient/terminal
    vocabulary via `to_job_error`, so the retry decision is derived from §78.2's
    classification rather than restated at every raise site.
    """

    def __init__(self, code: TtsErrorCode, message: str, *, note: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.note = note

    @property
    def classification(self) -> Classification:
        return CLASSIFICATION[self.code]

    @property
    def retryable(self) -> bool:
        return self.classification is Classification.RETRYABLE


def to_job_error(error: TtsError) -> TerminalJobError | TransientJobError:
    """Convert a taxonomy error into the queue's retry vocabulary."""
    if error.retryable:
        return TransientJobError(str(error), error_code=error.code.value)
    return TerminalJobError(str(error), error_code=error.code.value)


# §79.1's worked examples, generalised. Ordered most-specific-first: "out of memory" must
# win over the broader "memory" style matches, and a rate-limit response must not be
# swallowed by the generic timeout rule.
_NATIVE_ERROR_PATTERNS: tuple[tuple[tuple[str, ...], TtsErrorCode], ...] = (
    (("out of memory", "oom", "cuda_error_out_of_memory"), TtsErrorCode.GPU_OUT_OF_MEMORY),
    (
        ("no cuda", "no gpu", "cuda unavailable", "device unavailable", "no such device"),
        TtsErrorCode.GPU_UNAVAILABLE,
    ),
    (
        ("dimension mismatch", "embedding dimension", "speaker embedding", "shape mismatch"),
        TtsErrorCode.VOICE_MODEL_INCOMPATIBLE,
    ),
    (("429", "too many requests", "rate limit"), TtsErrorCode.PROVIDER_RATE_LIMIT),
    (("timed out", "timeout", "deadline exceeded"), TtsErrorCode.PROVIDER_TIMEOUT),
    (("nan", "inf", "corrupt"), TtsErrorCode.AUDIO_CORRUPTED),
)


def classify_provider_error(exc: BaseException) -> TtsError:
    """§79.2: the single place an engine's native error text is inspected.

    An unrecognised failure becomes `SYNTHESIS_FAILED`, which is retryable -- the safe
    default, matching `event-contracts.md` §21.2 ("unclassifiable... retryable but
    attempt-bounded"): a genuinely terminal fault costs a bounded few attempts and then
    dead-letters visibly, whereas discarding a transient one silently loses a chunk.
    """
    if isinstance(exc, TtsError):
        return exc
    text = f"{type(exc).__name__}: {exc}".lower()
    for needles, code in _NATIVE_ERROR_PATTERNS:
        if any(needle in text for needle in needles):
            return TtsError(code, str(exc) or type(exc).__name__)
    return TtsError(TtsErrorCode.SYNTHESIS_FAILED, str(exc) or type(exc).__name__)


__all__ = [
    "CLASSIFICATION",
    "Classification",
    "TtsError",
    "TtsErrorCode",
    "classify_provider_error",
    "to_job_error",
]
