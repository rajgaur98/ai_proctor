#!/bin/bash
# Integration check for people imports (#256, ORG-03): the import-people Edge Function
# against the local stack, invite emails read from Mailpit (scripts/it-import-people.ts).
#
# Run it with the stack up and the Edge runtime restarted since the function last
# changed (a new function needs `scripts/stack.sh down && scripts/stack.sh up`):
#   scripts/stack.sh up && scripts/stack.sh reset
#   pnpm it:import-people
# Which stack: this worktree's through scripts/stack.sh (override with STACK_SH);
# without it, the main checkout's default stack.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:$PATH"

STACK_SH=${STACK_SH:-$ROOT/scripts/stack.sh}
VARS='^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|MAILPIT_URL)='
if [ -x "$STACK_SH" ]; then
  eval "$("$STACK_SH" env | grep -E "$VARS")"
else
  eval "$(pnpm --silent supabase status -o env 2>/dev/null | grep -E "$VARS")"
fi
[ -n "${API_URL:-}" ] || { echo "stack not running: scripts/stack.sh up" >&2; exit 1; }

AI_PROCTOR_SUPABASE_URL=$API_URL \
AI_PROCTOR_SUPABASE_ANON_KEY=$ANON_KEY \
AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
AI_PROCTOR_MAILPIT_URL=$MAILPIT_URL \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/it-import-people.ts
