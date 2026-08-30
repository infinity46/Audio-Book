# worker-gpu -- TTS worker. Its own deployment unit, always.
#
# BUILD CONTEXT IS `python/`, not the repo root and not this directory:
#     docker build -f worker-gpu/Dockerfile -t worker-gpu:dev python/
#
# PHASE 1 NOTE ON THE BASE IMAGE: this is a plain slim image, not a CUDA one, because
# Phase 1 loads no model and links no CUDA. When the real TTS provider lands, this
# FROM becomes an `nvidia/cuda:*-runtime-*` base and the runtime stage gains the
# NVIDIA_VISIBLE_DEVICES / NVIDIA_DRIVER_CAPABILITIES env vars. Shipping a multi-GB
# CUDA image now, to run a stub that allocates no GPU memory, would be waste.

# ---------------------------------------------------------------- builder ---
# Pinned to an exact patch version. A human should replace these tags with digest
# pins (`python:3.12.14-slim-bookworm@sha256:...`) before this reaches production.
FROM python:3.12.14-slim-bookworm AS builder

COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /build

COPY pyproject.toml uv.lock .python-version ./
# workers-common/README.md is copied here too, not just pyproject.toml — hatchling
# validates pyproject.toml's `readme` field at build time, so `uv sync` fails without it.
COPY workers-common/pyproject.toml workers-common/README.md workers-common/
COPY worker-ai/pyproject.toml worker-ai/
COPY worker-gpu/pyproject.toml worker-gpu/

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --package worker-gpu

COPY workers-common/ workers-common/
COPY worker-gpu/ worker-gpu/

# --no-editable: default editable installs point site-packages back at
# /build/<pkg>/src via a path pointer, which breaks the same way the console-
# script shebangs do once the venv is copied to /app in the runtime stage.
# This installs real copies instead, making the venv self-contained.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --package worker-gpu

# ---------------------------------------------------------------- runtime ---
FROM python:3.12.14-slim-bookworm AS runtime

RUN groupadd --gid 10001 worker \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin worker

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY --from=builder --chown=10001:10001 /build/.venv /app/.venv
COPY --from=builder --chown=10001:10001 /build/workers-common /app/workers-common
COPY --from=builder --chown=10001:10001 /build/worker-gpu /app/worker-gpu

# Non-root even on the GPU node. This is the container running third-party model code
# over every tenant's content, so it is the last one that should have root.
USER 10001:10001

EXPOSE 8080

# No HEALTHCHECK: the orchestrator probes /health and /ready separately. That
# distinction is essential here -- a real TTS model load takes minutes, during which the
# worker is live but not ready, and a single Docker healthcheck cannot express that.

# Invoked via `python -m`, not the generated `worker-gpu` console-script wrapper:
# uv-created venvs are not relocatable — every script uv generates in .venv/bin
# has a shebang hardcoded to the BUILDER stage's absolute path (/build/.venv/...),
# which does not exist once the venv is copied to /app in this runtime stage, so
# the wrapper fails with "no such file or directory". Calling the interpreter
# directly sidesteps the wrapper (and its baked-in path) entirely.
#
# Exec form, so SIGTERM reaches the worker as PID 1. Graceful drain matters more here
# than anywhere else in the system: an abandoned in-flight chunk leaves a chapter
# unassemblable until it is retried.
#
# The orchestrator's terminationGracePeriodSeconds MUST exceed the worker's
# SHUTDOWN_GRACE_PERIOD_SECONDS, or the drain is cut short by SIGKILL.
ENTRYPOINT ["/app/.venv/bin/python", "-m", "worker_gpu.main"]
