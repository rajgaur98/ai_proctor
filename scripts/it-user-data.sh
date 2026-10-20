#!/bin/bash
# Integration check for the data subject request functions (#54, ADM-05): export-user-data
# and delete-user-data, through the real Edge Functions against the local stack. A new
# employee (Dana) works a day with a pause and a capture; the owner exports her data and
# then deletes it; peers, managers and wrong confirmations are refused
# (scripts/it-user-data.ts).
#
# Run it with the stack up and the Edge runtime restarted since the functions last
# changed (new functions need `scripts/stack.sh down && scripts/stack.sh up`):
#   scripts/stack.sh up && scripts/stack.sh reset
#   pnpm it:user-data
# Which stack: this worktree's through scripts/stack.sh (override with STACK_SH);
# without it, the main checkout's default stack. Needs `unzip` (macOS has it).
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
command -v unzip >/dev/null || { echo "unzip not found" >&2; exit 1; }

AI_PROCTOR_SUPABASE_URL=$API_URL \
AI_PROCTOR_SUPABASE_ANON_KEY=$ANON_KEY \
AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/it-user-data.ts
