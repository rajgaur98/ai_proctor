#!/bin/bash
# How fast is report_rows for a big org (#156, NFR-PERF-03: pages load in < 2 s p95 up to
# 500 users)? Seeds synthetic people and history in one transaction, times the report as
# the owner and as a manager, rolls everything back. Local only, not part of CI (it
# writes a few hundred thousand rows; a year of history takes minutes on a busy machine).
#   scripts/stack.sh up && scripts/stack.sh reset
#   scripts/it-reports-scale.sh [people=500] [history_days=28]
# The best of three timed calls per scenario is in milliseconds; the PRD target is < 2000.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
command -v psql >/dev/null || { echo "psql not found (brew install libpq)" >&2; exit 1; }
eval "$(scripts/stack.sh env | grep -E '^DB_URL=')"
: "${DB_URL:?stack not running: scripts/stack.sh up}"

psql "$DB_URL" -X -v people="${1:-500}" -v history="${2:-28}" -f scripts/it-reports-scale.sql
