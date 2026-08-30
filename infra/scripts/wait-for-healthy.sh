#!/usr/bin/env bash
# Waits for a docker-compose service to report healthy, using its own
# healthcheck (not an arbitrary sleep) — task requirement §54: "Use health
# checks rather than arbitrary sleep commands where possible."
#
# Usage: infra/scripts/wait-for-healthy.sh <service-name> [timeout-seconds]
set -euo pipefail

service="${1:?usage: wait-for-healthy.sh <service-name> [timeout-seconds]}"
timeout="${2:-60}"
elapsed=0

while true; do
  status="$(docker compose ps --format '{{.Health}}' "$service" 2>/dev/null || true)"
  if [[ "$status" == "healthy" ]]; then
    echo "$service is healthy"
    exit 0
  fi
  if (( elapsed >= timeout )); then
    echo "Timed out after ${timeout}s waiting for $service to become healthy (last status: ${status:-unknown})" >&2
    docker compose logs "$service" --tail 50 >&2 || true
    exit 1
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done
