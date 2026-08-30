"""Shared infrastructure for the Python workers.

Phase 1: plumbing only. No Director logic, no TTS inference, no audio processing.
See README.md for the module map and the BullMQ compatibility notes.
"""

from workers_common.config import (
    AppConfig,
    ConfigurationError,
    Environment,
    EnvironmentConfig,
    LogLevel,
    ModelConfig,
    Secrets,
    WorkerSettings,
    load_settings,
    load_settings_or_exit,
)
from workers_common.correlation import (
    CorrelationContext,
    bind_context,
    bind_job_context,
    causation_id_for_downstream,
    get_context,
)
from workers_common.db import Database
from workers_common.events import (
    CommandEnvelope,
    EventEnvelope,
    JobPriority,
    MessageType,
    QueueName,
    new_event,
    new_id,
    queue_for,
    utc_now,
)
from workers_common.health import (
    HealthReport,
    InvalidTransitionError,
    WorkerHealth,
    WorkerState,
    create_health_router,
)
from workers_common.logging import (
    configure_logging,
    get_logger,
    redact,
    summarize_embedding,
    summarize_text,
)
from workers_common.queue import (
    QueueConsumer,
    TerminalJobError,
    TransientJobError,
)
from workers_common.runtime import ModelProvider, WorkerRuntime, create_worker_app
from workers_common.storage import Checksum, ObjectMetadata, ObjectStorage, StorageError

__version__ = "0.1.0"

__all__ = [
    "AppConfig",
    "Checksum",
    "CommandEnvelope",
    "ConfigurationError",
    "CorrelationContext",
    "Database",
    "Environment",
    "EnvironmentConfig",
    "EventEnvelope",
    "HealthReport",
    "InvalidTransitionError",
    "JobPriority",
    "LogLevel",
    "MessageType",
    "ModelConfig",
    "ModelProvider",
    "ObjectMetadata",
    "ObjectStorage",
    "QueueConsumer",
    "QueueName",
    "Secrets",
    "StorageError",
    "TerminalJobError",
    "TransientJobError",
    "WorkerHealth",
    "WorkerRuntime",
    "WorkerSettings",
    "WorkerState",
    "__version__",
    "bind_context",
    "bind_job_context",
    "causation_id_for_downstream",
    "configure_logging",
    "create_health_router",
    "create_worker_app",
    "get_context",
    "get_logger",
    "load_settings",
    "load_settings_or_exit",
    "new_event",
    "new_id",
    "queue_for",
    "redact",
    "summarize_embedding",
    "summarize_text",
    "utc_now",
]
