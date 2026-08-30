#!/usr/bin/env bash
# Explicit, deliberate migration step. Never invoked automatically by an
# application process at startup (deployment-architecture.md §27 /
# database-schema.md §45 rule 19: "never run migrations from an application
# process") — this script IS the deployment-time migration step.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

echo "Waiting for Postgres to accept connections..."
./infra/scripts/wait-for-healthy.sh postgres 60

echo "Running Prisma migrations (deploy — no schema drift resolution, no dev prompts)..."
pnpm prisma:migrate:deploy

echo "Verifying schema against docs/architecture/database-schema.md (constraints/indexes drift check)..."
pnpm schema:drift-check

echo "Migrations applied and verified."
