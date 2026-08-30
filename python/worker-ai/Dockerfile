# worker-ai -- Director / LLM worker.
#
# BUILD CONTEXT IS `python/`, not the repo root and not this directory:
#     docker build -f worker-ai/Dockerfile -t worker-ai:dev python/
# The workspace lockfile lives at python/uv.lock and the path dependency on
# workers-common must resolve, so the whole workspace has to be in context.

# ---------------------------------------------------------------- builder ---
# Pinned to an exact patch version. A human should replace these tags with digest
# pins (`python:3.12.14-slim-bookworm@sha256:...`) before this reaches production --
# a tag is mutable and therefore not a reproducible build input.
FROM python:3.12.14-slim-bookworm AS builder

COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /build

# Dependencies first, sources second, so an edit to application code does not invalidate
# the (slow) dependency layer.
COPY pyproject.toml uv.lock .python-version ./
# workers-common/README.md is copied here too, not just pyproject.toml — hatchling
# validates pyproject.toml's `readme` field at build time, so `uv sync` fails without it.
COPY workers-common/pyproject.toml workers-common/README.md workers-common/
COPY worker-ai/pyproject.toml worker-ai/
COPY worker-gpu/pyproject.toml worker-gpu/

# --frozen: fail if uv.lock is out of date rather than silently resolving something new.
# --no-dev: test and lint tooling has no business in a runtime image.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --package worker-ai

COPY workers-common/ workers-common/
COPY worker-ai/ worker-ai/

# --no-editable: default editable installs point site-packages back at
# /build/<pkg>/src via a path pointer, which breaks the same way the console-
# script shebangs do once the venv is copied to /app in the runtime stage.
# This installs real copies instead, making the venv self-contained.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --package worker-ai

# ---------------------------------------------------------------- runtime ---
FROM python:3.12.14-slim-bookworm AS runtime

# Non-root. A fixed uid/gid rather than an auto-assigned one so that volume ownership
# is predictable across rebuilds.
RUN groupadd --gid 10001 worker \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin worker

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY --from=builder --chown=10001:10001 /build/.venv /app/.venv
COPY --from=builder --chown=10001:10001 /build/workers-common /app/workers-common
COPY --from=builder --chown=10001:10001 /build/worker-ai /app/worker-ai

USER 10001:10001

EXPOSE 8080

# No HEALTHCHECK instruction: the orchestrator owns probing, and it needs the
# liveness/readiness distinction that /health and /ready provide. Docker's single
# HEALTHCHECK cannot express that, and having both would give two disagreeing opinions.

# Invoked via `python -m`, not the generated `worker-ai` console-script wrapper:
# uv-created venvs are not relocatable — every script uv generates in .venv/bin
# has a shebang hardcoded to the BUILDER stage's absolute path (/build/.venv/...),
# which does not exist once the venv is copied to /app in this runtime stage, so
# the wrapper fails with "no such file or directory". Calling the interpreter
# directly sidesteps the wrapper (and its baked-in path) entirely.
#
# Exec form, so PID 1 is the worker itself and SIGTERM reaches it directly. With the
# shell form the signal would go to /bin/sh and graceful shutdown would never run.
ENTRYPOINT ["/app/.venv/bin/python", "-m", "worker_ai.main"]
