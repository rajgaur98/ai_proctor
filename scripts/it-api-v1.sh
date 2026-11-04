#!/bin/bash
# Integration check for the public API v1 (#306): scripts/it-api-v1.ts (keys, the
# api-v1 Edge Function's operations, errors, paging, writes, scopes, rate limit, org
# isolation, audit rows) and that docs/api/openapi.json is current.
#
# Run on a stack whose Edge runtime has the function (stop and start the stack after
# adding it):
#   scripts/stack.sh up && scripts/stack.sh reset && pnpm it:api
# Which stack: this worktree's through scripts/stack.sh (override with STACK_SH);
# without it, the main checkout's default stack.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:$PATH"

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/api-openapi.ts --check

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
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/it-api-v1.ts
