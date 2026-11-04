#!/bin/bash
# The seat map with a big org (#308, DSH-11: smooth with 5,000 people). Seeds synthetic
# people into this worktree's stack, runs the seat map's performance spec (frame timing,
# DOM size, query count, live updates without a new layout) and removes them again, even
# when the spec fails. Local only, not part of CI.
#   scripts/stack.sh up && scripts/stack.sh dotenv
#   scripts/it-seat-map-scale.sh [people=5000]
# The spec prints the frame timings it measured.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
command -v psql >/dev/null || { echo "psql not found (brew install libpq)" >&2; exit 1; }
eval "$(scripts/stack.sh env | grep -E '^DB_URL=')"
: "${DB_URL:?stack not running: scripts/stack.sh up}"
PEOPLE=${1:-5000}

trap 'psql "$DB_URL" -X -q -v remove=1 -f scripts/it-seat-map-scale.sql' EXIT
psql "$DB_URL" -X -q -v people="$PEOPLE" -f scripts/it-seat-map-scale.sql
SEAT_MAP_SCALE="$PEOPLE" scripts/stack.sh run pnpm --filter @ai-proctor/web e2e seat-map-scale.spec.ts
