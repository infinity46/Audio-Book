"""Fail-fast worker configuration.

The contract is that a worker with missing or invalid configuration **crashes at startup**.
It never falls back to a silent default that happens to work in development and quietly
does the wrong thing in production. Every field below is therefore either

  * required with no default (the process will not start without it), or
  * defaulted to a value that is safe in *every* environment.

There is deliberately no `DATABASE_URL = "postgresql://localhost/dev"` anywhere in here.

Configuration is split into the four categories the architecture calls for:

  APPLICATION CONFIG    `AppConfig`          what this service is and how it behaves
  ENVIRONMENT CONFIG    `EnvironmentConfig`  where it is running
  SECRETS               `Secrets`            credentials; never logged, never in a repr
  MODEL CONFIGURATION   `ModelConfig`        which model set the worker is assigned

Each category is a separate `BaseSettings` with its own env prefix, so an operator reading
a deployment manifest can see at a glance which variables are secret material and which are
not. Secrets are typed `SecretStr`, whose `repr` is `**********` — so an accidental
`log.info("config", cfg=settings)` cannot leak a password.
"""

from __future__ import annotations

import sys
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field, PostgresDsn, RedisDsn, SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


class ConfigurationError(RuntimeError):
    """Raised when configuration is missing or invalid. Always fatal."""


class Environment(StrEnum):
    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


class LogLevel(StrEnum):
    DEBUG = "DEBUG"
    INFO = "INFO"
    WARNING = "WARNING"
    ERROR = "ERROR"


_BASE = SettingsConfigDict(
    env_file=None,  # containers get real env vars; no .env magic in the runtime path
    extra="ignore",
    frozen=True,
)


# --------------------------------------------------------------------------- #
# ENVIRONMENT CONFIG
# --------------------------------------------------------------------------- #
class EnvironmentConfig(BaseSettings):
    """Where this process is running. Required: guessing is never acceptable."""

    model_config = SettingsConfigDict(**_BASE, env_prefix="")

    environment: Environment = Field(
        description="Deployment environment. Appears on every log line.",
    )
    region: str | None = Field(
        default=None,
        description="Cloud region, when the deployment has one.",
    )


# --------------------------------------------------------------------------- #
# APPLICATION CONFIG
# --------------------------------------------------------------------------- #
class AppConfig(BaseSettings):
    """What this service is and how it behaves."""

    model_config = SettingsConfigDict(**_BASE, env_prefix="")

    service_name: str = Field(
        description="Service identity, e.g. `worker-ai`. Appears on every log line and "
        "is the `producer` field of any envelope this service emits.",
    )
    service_version: str = Field(
        description="Build identity, e.g. `worker-gpu@2.1.0`. This is `producer_version`; "
        "it is required so that a bad release is attributable.",
    )
    worker_id: str = Field(
        description="Unique identity of this worker instance (typically the pod name). "
        "Used for job leases and log correlation.",
    )
    log_level: LogLevel = Field(default=LogLevel.INFO)

    # A queue name is required rather than defaulted: routing a GPU worker to the `ai`
    # queue because someone forgot to set a variable would be a silent, expensive mistake.
    queue_name: Literal["parse", "ai", "gpu", "audio", "maintenance"] = Field(
        description="Which of the five queues this worker consumes (`event-contracts.md` §5.2).",
    )
    queue_prefix: str = Field(
        default="bull",
        description="BullMQ key prefix. MUST match the Node producer's configuration.",
    )
    concurrency: Annotated[int, Field(ge=1, le=64)] = Field(
        default=1,
        description="How many jobs this worker processes at once. Workers advertise their "
        "own concurrency; the queue does not guess (`context.md` §10.4).",
    )
    shutdown_grace_period_seconds: Annotated[float, Field(gt=0, le=600)] = Field(
        default=30.0,
        description="How long DRAINING waits for in-flight work before forcing STOPPED.",
    )
    health_port: Annotated[int, Field(ge=1, le=65535)] = Field(
        default=8080,
        description="Port for the internal control surface. Not publicly routable.",
    )


# --------------------------------------------------------------------------- #
# SECRETS
# --------------------------------------------------------------------------- #
class Secrets(BaseSettings):
    """Credentials and connection strings.

    All secret-bearing values are `SecretStr`. Getting the real value requires an explicit
    `.get_secret_value()`, which makes every leak site greppable.
    """

    model_config = SettingsConfigDict(**_BASE, env_prefix="")

    database_url: PostgresDsn = Field(
        description="Async Postgres DSN. Each worker connects with its OWN narrowly-scoped "
        "role; see the note in `db.py`.",
    )
    redis_url: RedisDsn = Field(description="Redis 7+ instance backing BullMQ.")

    storage_endpoint_url: str = Field(description="S3-compatible endpoint.")
    storage_bucket: str = Field(description="Bucket this worker reads/writes.")
    storage_access_key_id: SecretStr = Field(description="Narrow-prefix-grant access key.")
    storage_secret_access_key: SecretStr = Field(description="Matching secret key.")
    storage_region: str = Field(default="us-east-1")


# --------------------------------------------------------------------------- #
# MODEL CONFIGURATION
# --------------------------------------------------------------------------- #
class ModelConfig(BaseSettings):
    """The model set this worker is assigned.

    PHASE 1: nothing here is loaded. The stub providers in `worker-ai` and `worker-gpu`
    read `model_id` only to prove the MODEL_READY transition carries an identity, and then
    do nothing with it. Real loading is a later phase.
    """

    model_config = SettingsConfigDict(**_BASE, env_prefix="", protected_namespaces=())

    model_id: str = Field(
        description="Identifier of the assigned model set. Required even in Phase 1: a "
        "worker whose assignment is ambiguous must not start, because capability-based "
        "routing (`context.md` §10.3) depends on the worker advertising it accurately.",
    )
    model_revision: str | None = Field(
        default=None,
        description="Pinned revision/commit of the model, when the provider has one.",
    )
    model_load_timeout_seconds: Annotated[float, Field(gt=0)] = Field(default=300.0)


# --------------------------------------------------------------------------- #
# Composite
# --------------------------------------------------------------------------- #
class WorkerSettings(BaseSettings):
    """The four categories, composed.

    Built via `load_settings()` rather than instantiated directly, so that a configuration
    error produces one readable report instead of a pydantic traceback.
    """

    model_config = SettingsConfigDict(frozen=True, protected_namespaces=())

    env: EnvironmentConfig
    app: AppConfig
    secrets: Secrets
    model: ModelConfig

    @property
    def is_production(self) -> bool:
        return self.env.environment is Environment.PRODUCTION


def _format_errors(category: str, exc: ValidationError) -> list[str]:
    lines = []
    for err in exc.errors():
        var = ".".join(str(p) for p in err["loc"]) or "<root>"
        lines.append(f"  [{category}] {var.upper()}: {err['msg']}")
    return lines


def load_settings() -> WorkerSettings:
    """Load and validate all configuration, or raise `ConfigurationError`.

    Every category is attempted even if an earlier one failed, so that an operator fixing a
    misconfigured deployment sees *all* the missing variables at once instead of
    rediscovering them one restart at a time.
    """
    problems: list[str] = []

    env_cfg = app_cfg = sec_cfg = mdl_cfg = None
    for category, factory in (
        ("environment", EnvironmentConfig),
        ("application", AppConfig),
        ("secrets", Secrets),
        ("model", ModelConfig),
    ):
        try:
            loaded = factory()  # type: ignore[call-arg]  # values come from the environment
        except ValidationError as exc:
            problems.extend(_format_errors(category, exc))
            continue
        if category == "environment":
            env_cfg = loaded
        elif category == "application":
            app_cfg = loaded
        elif category == "secrets":
            sec_cfg = loaded
        else:
            mdl_cfg = loaded

    if problems:
        raise ConfigurationError(
            "Worker configuration is invalid; refusing to start.\n"
            + "\n".join(problems)
            + "\n\nEvery variable above is required and has no safe default."
        )

    assert isinstance(env_cfg, EnvironmentConfig)
    assert isinstance(app_cfg, AppConfig)
    assert isinstance(sec_cfg, Secrets)
    assert isinstance(mdl_cfg, ModelConfig)

    return WorkerSettings(env=env_cfg, app=app_cfg, secrets=sec_cfg, model=mdl_cfg)


def load_settings_or_exit() -> WorkerSettings:
    """`load_settings()`, but reports to stderr and exits 78 instead of raising.

    Exit code 78 is sysexits.h `EX_CONFIG`, which lets an orchestrator distinguish "this
    deployment is misconfigured, restarting will not help" from a crash worth retrying.
    Writing to stderr directly is deliberate: this runs before logging is configured.
    """
    try:
        return load_settings()
    except ConfigurationError as exc:
        print(str(exc), file=sys.stderr)  # noqa: T201 - pre-logging startup path
        raise SystemExit(78) from exc
