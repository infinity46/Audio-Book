"""Configuration must crash loudly rather than default silently."""

from __future__ import annotations

import pytest
from pydantic import SecretStr

from workers_common.config import (
    ConfigurationError,
    Environment,
    LogLevel,
    WorkerSettings,
    load_settings,
)

# A complete, valid environment. Individual tests remove or corrupt one key at a time.
VALID_ENV = {
    "ENVIRONMENT": "production",
    "SERVICE_NAME": "worker-gpu",
    "SERVICE_VERSION": "worker-gpu@2.1.0",
    "WORKER_ID": "worker-gpu-abc123",
    "QUEUE_NAME": "gpu",
    "DATABASE_URL": "postgresql://worker:pw@db.internal:5432/audiobook",
    "REDIS_URL": "redis://redis.internal:6379/0",
    "STORAGE_ENDPOINT_URL": "https://s3.internal:9000",
    "STORAGE_BUCKET": "audiobook-artifacts",
    "STORAGE_ACCESS_KEY_ID": "AKIAEXAMPLE",
    "STORAGE_SECRET_ACCESS_KEY": "s3cr3t-example",
    "MODEL_ID": "stub-tts-v0",
}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Clear every variable the settings classes read, so the host env cannot leak in."""
    for key in (
        *VALID_ENV,
        "REGION",
        "LOG_LEVEL",
        "CONCURRENCY",
        "QUEUE_PREFIX",
        "HEALTH_PORT",
        "STORAGE_REGION",
        "MODEL_REVISION",
        "SHUTDOWN_GRACE_PERIOD_SECONDS",
        "MODEL_LOAD_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(key, raising=False)


def _set(monkeypatch: pytest.MonkeyPatch, env: dict[str, str]) -> None:
    for key, value in env.items():
        monkeypatch.setenv(key, value)


def test_valid_environment_loads(monkeypatch: pytest.MonkeyPatch) -> None:
    _set(monkeypatch, VALID_ENV)
    settings = load_settings()
    assert isinstance(settings, WorkerSettings)
    assert settings.env.environment is Environment.PRODUCTION
    assert settings.app.service_name == "worker-gpu"
    assert settings.app.queue_name == "gpu"
    assert settings.model.model_id == "stub-tts-v0"
    assert settings.is_production


def test_completely_empty_environment_fails() -> None:
    with pytest.raises(ConfigurationError):
        load_settings()


@pytest.mark.parametrize("missing", sorted(VALID_ENV))
def test_every_required_var_is_actually_required(
    monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    """The core fail-fast guarantee: no required variable has a silent fallback."""
    env = {k: v for k, v in VALID_ENV.items() if k != missing}
    _set(monkeypatch, env)
    with pytest.raises(ConfigurationError) as exc_info:
        load_settings()
    assert missing in str(exc_info.value)


def test_error_reports_all_missing_vars_at_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """An operator should not have to fix one variable per restart."""
    _set(monkeypatch, {"ENVIRONMENT": "production"})
    with pytest.raises(ConfigurationError) as exc_info:
        load_settings()
    message = str(exc_info.value)
    for expected in ("SERVICE_NAME", "DATABASE_URL", "MODEL_ID", "QUEUE_NAME"):
        assert expected in message


def test_invalid_environment_value_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _set(monkeypatch, {**VALID_ENV, "ENVIRONMENT": "prod"})  # not one of the enum values
    with pytest.raises(ConfigurationError):
        load_settings()


def test_invalid_queue_name_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """There are exactly five queues; a typo must not create a sixth."""
    _set(monkeypatch, {**VALID_ENV, "QUEUE_NAME": "gpu-high-priority"})
    with pytest.raises(ConfigurationError):
        load_settings()


def test_malformed_database_url_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _set(monkeypatch, {**VALID_ENV, "DATABASE_URL": "not-a-dsn"})
    with pytest.raises(ConfigurationError):
        load_settings()


def test_malformed_redis_url_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _set(monkeypatch, {**VALID_ENV, "REDIS_URL": "http://redis:6379"})
    with pytest.raises(ConfigurationError):
        load_settings()


@pytest.mark.parametrize("bad", ["0", "-1", "999"])
def test_out_of_range_concurrency_rejected(monkeypatch: pytest.MonkeyPatch, bad: str) -> None:
    _set(monkeypatch, {**VALID_ENV, "CONCURRENCY": bad})
    with pytest.raises(ConfigurationError):
        load_settings()


def test_safe_defaults_apply_only_where_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    """Defaults exist, but only for values that are safe in every environment."""
    _set(monkeypatch, VALID_ENV)
    settings = load_settings()
    assert settings.app.log_level is LogLevel.INFO
    assert settings.app.concurrency == 1
    assert settings.app.queue_prefix == "bull"  # must match the Node producer
    assert settings.env.region is None
    assert settings.model.model_revision is None


def test_secrets_are_not_exposed_in_repr(monkeypatch: pytest.MonkeyPatch) -> None:
    """A stray log of the settings object must not leak credentials."""
    _set(monkeypatch, VALID_ENV)
    settings = load_settings()

    assert isinstance(settings.secrets.storage_secret_access_key, SecretStr)
    rendered = repr(settings.secrets) + str(settings.secrets)
    assert "s3cr3t-example" not in rendered
    assert "AKIAEXAMPLE" not in rendered

    # ...and the real value is still reachable, but only explicitly.
    assert settings.secrets.storage_secret_access_key.get_secret_value() == "s3cr3t-example"


def test_settings_are_frozen(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configuration must not drift at runtime."""
    _set(monkeypatch, VALID_ENV)
    settings = load_settings()
    with pytest.raises(Exception):  # noqa: B017 - pydantic raises ValidationError here
        settings.app.concurrency = 8


def test_load_settings_or_exit_uses_ex_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """Exit 78 (EX_CONFIG) tells the orchestrator that restarting will not help."""
    from workers_common.config import load_settings_or_exit

    with pytest.raises(SystemExit) as exc_info:
        load_settings_or_exit()
    assert exc_info.value.code == 78
