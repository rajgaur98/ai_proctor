#!/bin/bash
# Integration check for delete-checkin-parts (#253; EMP-06, CAP-09, AUD-01): an employee
# removes parts of their own check-in through the real Edge Function, and the files are
# really gone from Storage; nobody else can (scripts/it-checkin-parts.ts).
#
# Run it with the stack up and the Edge runtime restarted since the functions last
# changed (new functions need `scripts/stack.sh down && scripts/stack.sh up`):
#   scripts/stack.sh up && scripts/stack.sh reset
#   pnpm it:checkin-parts
# Which stack: this worktree's through scripts/stack.sh (override with STACK_SH);
# without it, the main checkout's default stack.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:$PATH"

STACK_SH=${STACK_SH:-$ROOT/scripts/stack.sh}
VARS='^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)='
if [ -x "$STACK_SH" ]; then
  eval "$("$STACK_SH" env | grep -E "$VARS")"
else
  eval "$(pnpm --silent supabase status -o env 2>/dev/null | grep -E "$VARS")"
fi
[ -n "${API_URL:-}" ] || { echo "stack not running: scripts/stack.sh up" >&2; exit 1; }

AI_PROCTOR_SUPABASE_URL=$API_URL \
AI_PROCTOR_SUPABASE_ANON_KEY=$ANON_KEY \
AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/it-checkin-parts.ts
