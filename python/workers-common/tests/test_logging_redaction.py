"""Book content must never reach the log stream.

This is a security guarantee, not a style preference: a customer's manuscript sitting in a
log aggregator is not recoverable after the fact. The redaction processor is the safety net
that keeps a single forgetful call site from becoming a breach.
"""

from __future__ import annotations

import pytest

from workers_common.logging import (
    _redact_processor,
    redact,
    summarize_embedding,
    summarize_text,
)

MANUSCRIPT = "It was the best of times, it was the worst of times."


def _process(**fields: object) -> dict[str, object]:
    return dict(_redact_processor(None, "info", dict(fields)))


@pytest.mark.parametrize(
    "key",
    [
        "text",
        "book_text",
        "chunk_text",
        "raw_text",
        "prompt",
        "system_prompt",
        "user_prompt",
        "embedding",
        "speaker_embedding",
        "content",
        "manuscript",
        "paragraph_text",
        "transcript",
        "passage",
        "excerpt",
        "completion",
    ],
)
def test_content_shaped_keys_are_redacted(key: str) -> None:
    result = _process(**{key: MANUSCRIPT})
    assert result[key] == "[REDACTED]"
    assert MANUSCRIPT not in str(result)


@pytest.mark.parametrize(
    "key",
    ["password", "secret", "api_key", "access_key", "authorization", "token"],
)
def test_credential_shaped_keys_are_redacted(key: str) -> None:
    result = _process(**{key: "hunter2"})
    assert result[key] == "[REDACTED]"


@pytest.mark.parametrize(
    "key",
    [
        "content_type",
        "content_length",
        "content_hash",
        "text_length",
        "text_sha256",
        "prompt_token_count",
        "embedding_dimensions",
        "paragraph_count",
        "paragraph_id",
        "transcript_verified",
    ],
)
def test_safe_metadata_keys_survive(key: str) -> None:
    """Redaction must not be so blunt that it destroys the diagnostics."""
    result = _process(**{key: 42})
    assert result[key] == 42


def test_identifiers_and_state_survive() -> None:
    result = _process(
        correlation_id="c-1",
        job_id="j-1",
        worker_id="w-1",
        message_type="generate_tts_chunk",
        error_code="OOM",
        attempt=2,
    )
    assert result == {
        "correlation_id": "c-1",
        "job_id": "j-1",
        "worker_id": "w-1",
        "message_type": "generate_tts_chunk",
        "error_code": "OOM",
        "attempt": 2,
    }


def test_the_event_name_itself_is_never_redacted() -> None:
    """`event` is the log message name, not a data field."""
    result = _process(event="job.completed", text=MANUSCRIPT)
    assert result["event"] == "job.completed"
    assert result["text"] == "[REDACTED]"


def test_matching_is_case_insensitive() -> None:
    assert _process(BookText=MANUSCRIPT)["BookText"] == "[REDACTED]"
    assert _process(PROMPT="x")["PROMPT"] == "[REDACTED]"


def test_redaction_applies_regardless_of_value_type() -> None:
    assert _process(embedding=[0.1, 0.2, 0.3])["embedding"] == "[REDACTED]"
    assert _process(content={"nested": MANUSCRIPT})["content"] == "[REDACTED]"


# --------------------------------------------------------------------------- #
# Explicit helpers
# --------------------------------------------------------------------------- #
def test_redact_helper_masks_anything() -> None:
    assert redact(MANUSCRIPT) == "[REDACTED]"


def test_summarize_text_describes_without_reproducing() -> None:
    summary = summarize_text(MANUSCRIPT)
    assert summary["text_length"] == len(MANUSCRIPT)
    assert len(summary["text_sha256"]) == 16
    assert MANUSCRIPT not in str(summary)
    # Every word is absent, not merely the whole string.
    assert "times" not in str(summary)


def test_summarize_text_is_stable_and_distinguishing() -> None:
    """Enough to correlate a retry with its original, useless for reconstruction."""
    assert summarize_text(MANUSCRIPT) == summarize_text(MANUSCRIPT)
    assert summarize_text("a") != summarize_text("b")


def test_summarize_text_output_survives_redaction() -> None:
    """The helper's own keys must be on the allow-list, or it would be pointless."""
    assert _process(**summarize_text(MANUSCRIPT)) == summarize_text(MANUSCRIPT)


def test_summarize_embedding_reports_only_dimensions() -> None:
    assert summarize_embedding([0.1, 0.2, 0.3]) == {"embedding_dimensions": 3}
    assert summarize_embedding(object()) == {"embedding_dimensions": -1}


def test_summarize_embedding_output_survives_redaction() -> None:
    assert _process(**summarize_embedding([1.0, 2.0])) == {"embedding_dimensions": 2}
