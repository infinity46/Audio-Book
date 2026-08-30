# AI Audiobook Generator

**Phase 1: Repository & Infrastructure Foundation.** This repo implements the
monorepo scaffold, database schema, event/queue plumbing, and service
foundations only — no ingestion, Director, TTS, or audio-assembly business
logic yet. See `docs/architecture/` for the authoritative design (read
`context.md` first); this README covers setup and day-to-day commands, not
architecture.

## Prerequisites

- Node.js 20.18+ and [pnpm](https://pnpm.io) 9.12+ (`corepack enable` will pick up the pinned version from `package.json`)
- [uv](https://docs.astral.sh/uv/) (Python packaging) and Python 3.12
- Docker + Docker Compose (local Postgres/Redis/MinIO)

## Repository layout

```
apps/            api (NestJS), worker-cpu (Node) — deployable TypeScript services
packages/        shared TypeScript libraries (config, logging, errors, database, events, queue, storage, observability, contracts)
python/          worker-ai, worker-gpu (Python, uv workspace) + shared workers-common
prisma/          schema.prisma + migrations (see prisma/README.md for what's hand-written vs generated)
docs/             architecture/ (authoritative design docs), contracts/ (JSON Schema convention)
infra/            Dockerfiles, dev scripts
tests/            integration and contract tests spanning multiple packages
```

## First-time setup

```bash
git clone <repo> && cd Audio-Book
cp .env.example .env               # edit values if you changed docker-compose defaults

pnpm install
pnpm prisma:generate
pnpm --filter @audio-book/contracts run generate   # JSON Schema -> TS types

cd python && uv sync --all-packages && cd ..
```

## Start local infrastructure

```bash
docker compose up -d postgres redis minio minio-init
```

This brings up Postgres 16, Redis 7, and a MinIO instance with the dev bucket
pre-created — matching `docker-compose.yml`, which mirrors the topology
described in `docs/architecture/deployment-architecture.md` §6.

## Run database migrations

```bash
pnpm prisma:migrate:deploy
```

Migrations are **never** run automatically by an application process at
startup (`deployment-architecture.md` §27) — always run this explicitly,
as a deliberate step, before starting services that depend on the new
schema.

## Start services

Either run everything in Docker:

```bash
docker compose up --build
```

...or run TypeScript services locally against the Dockerized infra (faster
iteration):

```bash
pnpm --filter @audio-book/api run start:dev
pnpm --filter @audio-book/worker-cpu run start:dev
```

...and the Python workers:

```bash
cd python
uv run --package worker-ai uvicorn worker_ai.main:app --reload --port 8081
uv run --package worker-gpu uvicorn worker_gpu.main:app --reload --port 8082
```

`worker-ai`/`worker-gpu` run against mock LLM/TTS providers locally — no GPU
required for Phase 1 development (`deployment-architecture.md` §6).

## Verify the stack is healthy

```bash
curl http://localhost:3000/health   # API liveness
curl http://localhost:3000/ready    # API readiness (DB/Redis/storage)
curl http://localhost:8081/health   # worker-ai liveness
curl http://localhost:8082/health   # worker-gpu liveness
```

## Tests

```bash
pnpm test                 # TypeScript unit tests, per-package
pnpm test:contract         # envelope / StorageProvider / Queue / Outbox / Inbox contract tests
pnpm test:integration       # requires local infra running (see above)
pnpm schema:drift-check      # asserts the migrated DB matches database-schema.md's constraints/indexes

cd python && uv run pytest
```

## Lint, format, typecheck

```bash
pnpm lint && pnpm format:check && pnpm typecheck
cd python && uv run ruff check . && uv run ruff format --check . && uv run mypy .
```

## Build

```bash
pnpm build
```

## Environment variables

See `.env.example` — every variable is grouped by category (application /
environment / secrets / model configuration) and validated at startup
(`packages/config`); a missing or invalid required value fails fast rather
than falling back to something unsafe.

## Contract strategy

`docs/contracts/README.md` explains the JSON Schema -> TypeScript/Pydantic
codegen convention used to keep the Node and Python sides of the system from
drifting apart.
