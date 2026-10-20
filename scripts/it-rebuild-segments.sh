#!/bin/bash
# Integration check for rebuild-segments (#41): scripts/it-rebuild-segments.ts
# (events -> function -> time_segments, signed-in path, RLS), then the cron leg:
# segments_kick reads the Vault secrets and calls the function through pg_net.
#
# Run on a freshly reset stack with the secrets set and the stack's Edge runtime
# restarted since the function last changed:
#   scripts/stack.sh up && scripts/stack.sh reset && scripts/stack-secrets.sh
#   pnpm it:rebuild-segments
# Which stack: this worktree's through scripts/stack.sh (override with STACK_SH);
# without it, the main checkout's default stack.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:$PATH"

STACK_SH=${STACK_SH:-$ROOT/scripts/stack.sh}
VARS='^(DB_URL|API_URL|ANON_KEY|SERVICE_ROLE_KEY)='
if [ -x "$STACK_SH" ]; then
  eval "$("$STACK_SH" env | grep -E "$VARS")"
else
  eval "$(pnpm --silent supabase status -o env 2>/dev/null | grep -E "$VARS")"
fi
[ -n "${API_URL:-}" ] || { echo "stack not running: scripts/stack.sh up" >&2; exit 1; }

AI_PROCTOR_SUPABASE_URL=$API_URL \
AI_PROCTOR_SUPABASE_ANON_KEY=$ANON_KEY \
AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/it-rebuild-segments.ts

# Cron leg: a dirty day, one kick, and the function (called by pg_net with the
# Vault key) clears it.
ERIN=00000000-0000-4000-8000-0000000000c1
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c \
  "insert into public.dirty_days (user_id, day) values ('$ERIN', current_date) on conflict do nothing"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -o /dev/null -c "select internal.segments_kick()"
for _ in $(seq 1 30); do
  left=$(psql "$DB_URL" -At -c "select count(*) from public.dirty_days")
  [ "$left" = "0" ] && { echo "ok  segments_kick: pg_net called the function, dirty_days empty"; exit 0; }
  sleep 1
done
echo "FAIL segments_kick: dirty_days still has $left row(s) after 30 s (Vault secrets set? Edge runtime up?)" >&2
psql "$DB_URL" -c "select status_code, error_msg, left(content, 200) from net._http_response order by id desc limit 3" >&2 || true
exit 1
