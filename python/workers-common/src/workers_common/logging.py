"""Structured logging.

Every log line carries, without the caller having to remember:

    timestamp, level, service, environment,
    correlation_id, job_id (when applicable), worker_id (when applicable),
    error_code (when applicable)

`service` and `environment` come from configuration and are bound once at startup. The
correlation ids come from `contextvars` (see `correlation.py`), so they appear on lines
logged deep inside a call stack that never saw the envelope.

## Redaction

A hard rule from the architecture: logs must **never** contain full book text, prompts
containing book content, or embeddings. This module enforces that at the processor level
rather than trusting every call site to remember, because the failure mode -- a customer's
manuscript sitting in a log aggregator - is not recoverable after the fact.

Two mechanisms, deliberately layered:

1. `_redact_processor` drops any event-dict key whose *name* matches a content-shaped
   pattern (`text`, `prompt`, `embedding`, `content`, ...), replacing it with a marker.
2. `redact()` / `summarize_text()` are explicit helpers for the cases where a call site
   genuinely needs to say something about the content -- its length, its hash - without
   reproducing it.

The key-name filter is a safety net, not a licence to be careless: it cannot catch book
text passed under an innocuous key such as `detail`. Call sites still carry the
responsibility; this just means a single forgetful one is not a breach.
"""

from __future__ import annotations

import hashlib
import logging
import sys
from typing import TYPE_CHECKING, Any, Final

import structlog

from workers_common.correlation import get_context

if TYPE_CHECKING:  # pragma: no cover
    from workers_common.config import WorkerSettings

# Key names that must never carry a value into the log stream. Matched as substrings
# against the lower-cased key, so `book_text`, `chunk_text` and `raw_text` all hit `text`.
_FORBIDDEN_KEY_SUBSTRINGS: Final[tuple[str, ...]] = (
    "text",
    "prompt",
    "embedding",
    "content",
    "manuscript",
    "paragraph",
    "transcript",
    "passage",
    "excerpt",
    "completion",
    "message_body",
    "password",
    "secret",
    "token",
    "api_key",
    "access_key",
    "authorization",
)

# Keys that contain a forbidden substring but are safe and useful, so they are allowed
# through explicitly. Kept small and reviewed.
_ALLOWED_EXCEPTIONS: Final[frozenset[str]] = frozenset(
    {
        "content_type",  # a MIME type, not content
        "content_length",
        "content_hash",
        "text_length",
        "text_sha256",
        "prompt_token_count",
        "embedding_dimensions",
        "transcript_verified",
        "paragraph_count",
        "paragraph_id",
    }
)

_REDACTED: Final[str] = "[REDACTED]"


def _is_forbidden(key: str) -> bool:
    lowered = key.lower()
    if lowered in _ALLOWED_EXCEPTIONS:
        return False
    return any(bad in lowered for bad in _FORBIDDEN_KEY_SUBSTRINGS)


def _redact_processor(
    _logger: object, _name: str, event_dict: structlog.types.EventDict
) -> structlog.types.EventDict:
    """Replace content-shaped values with a marker before anything is rendered."""
    for key in list(event_dict):
        if key == "event":
            continue
        if _is_forbidden(key):
            event_dict[key] = _REDACTED
    return event_dict


def _correlation_processor(
    _logger: object, _name: str, event_dict: structlog.types.EventDict
) -> structlog.types.EventDict:
    """Merge the ambient correlation ids in.

    Explicit kwargs at the call site win, so a caller can log about a *different* job than
    the one currently bound without the context silently overwriting it.
    """
    for key, value in get_context().as_log_fields().items():
        event_dict.setdefault(key, value)
    return event_dict


def _rename_event_to_message(
    _logger: object, _name: str, event_dict: structlog.types.EventDict
) -> structlog.types.EventDict:
    """structlog calls it `event`; the log contract calls it `message`.

    Renamed here so the Python and TypeScript services emit the same field name and a
    single aggregator query works across both.
    """
    if "event" in event_dict:
        event_dict["message"] = event_dict.pop("event")
    return event_dict


def configure_logging(settings: WorkerSettings) -> None:
    """Install the structlog pipeline. Call once, as early as possible in startup."""
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=settings.app.log_level.value,
        force=True,
    )

    # In development a human is reading the terminal; everywhere else a machine is reading
    # stdout, and JSON is the only format an aggregator can index reliably.
    renderer: structlog.types.Processor = (
        structlog.dev.ConsoleRenderer()
        if not settings.is_production and settings.env.environment.value == "development"
        else structlog.processors.JSONRenderer()
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            _correlation_processor,
            _redact_processor,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            _rename_event_to_message,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelName(settings.app.log_level.value)
        ),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    # `service` and `environment` are constant for the process lifetime, so they are bound
    # once here rather than added by a processor on every line.
    structlog.contextvars.bind_contextvars(
        service=settings.app.service_name,
        environment=settings.env.environment.value,
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """A logger that already satisfies the field contract."""
    logger: structlog.stdlib.BoundLogger = structlog.get_logger(name)
    return logger


# --------------------------------------------------------------------------- #
# Explicit redaction helpers
# --------------------------------------------------------------------------- #
def redact(_value: object) -> str:
    """Unconditionally mask a value. Use when a call site *knows* it holds content."""
    return _REDACTED


def summarize_text(value: str) -> dict[str, Any]:
    """Describe text without reproducing it.

    Returns length and a truncated SHA-256, which is enough to correlate two log lines
    about the same passage, or to confirm a retry saw identical input, while being useless
    to anyone trying to reconstruct the manuscript.
    """
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
    return {"text_length": len(value), "text_sha256": digest[:16]}


def summarize_embedding(vector: object) -> dict[str, Any]:
    """Describe an embedding without logging the vector."""
    try:
        dimensions = len(vector)  # type: ignore[arg-type]
    except TypeError:
        dimensions = -1
    return {"embedding_dimensions": dimensions}
