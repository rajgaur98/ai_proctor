#!/bin/bash
# Integration check for webhooks (#320, API-06): scripts/it-webhooks.ts. Endpoints made on the
# dashboard RPCs, events from the real code paths (an invite, a timesheet submitted and
# approved, a time-off decision, an alert, a deactivation), delivery by the deliver-webhooks
# Edge Function (once through pg_cron + pg_net, then called directly), the signature checked
# with the endpoint's secret, retries, an endpoint turned off after failing with the owner
# notified, secret rotation, the delivery log, the production URL check, and the audit rows.
#
# The receiver lives inside the stack, so the Edge runtime reaches it on any host (CI's
# Linux runner has no host.docker.internal): two SQL functions this script adds for the run,
# called through PostgREST at http://rest:3000/rpc/..., one that records the request's
# headers and raw body and one that refuses (400). They are dropped when the script ends.
# The stack must allow private hosts (the Vault secret webhooks_allow_private_hosts, which
# scripts/stack-secrets.sh sets; this script runs it).
#
# Run on a stack whose Edge runtime has the function (stop and start the stack after
# adding it):
#   scripts/stack.sh up && scripts/stack.sh reset && pnpm it:webhooks
# Which stack: this worktree's through scripts/stack.sh (override with STACK_SH);
# without it, the main checkout's default stack.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:$PATH"

STACK_SH=${STACK_SH:-$ROOT/scripts/stack.sh}
VARS='^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|DB_URL)='
if [ -x "$STACK_SH" ]; then
  eval "$("$STACK_SH" env | grep -E "$VARS")"
else
  eval "$(pnpm --silent supabase status -o env 2>/dev/null | grep -E "$VARS")"
fi
[ -n "${API_URL:-}" ] || { echo "stack not running: scripts/stack.sh up" >&2; exit 1; }
command -v psql >/dev/null || { echo "psql not found (brew install libpq)" >&2; exit 1; }

STACK_SH=$STACK_SH bash scripts/stack-secrets.sh >/dev/null

receiver_down() {
  psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
set client_min_messages = warning;
drop function if exists public.it_webhook_sink(json);
drop function if exists public.it_webhook_fail(json);
drop table if exists public.it_webhook_received;
notify pgrst, 'reload schema';
SQL
}
trap receiver_down EXIT

receiver_down
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create table public.it_webhook_received (
  id bigint generated always as identity primary key,
  headers json not null,
  body text not null,
  received_at timestamptz not null default now()
);
-- A single unnamed json parameter takes the whole body as sent (PostgREST).
create function public.it_webhook_sink(json) returns void
language sql security definer set search_path = '' as $$
  insert into public.it_webhook_received (headers, body)
  values (current_setting('request.headers', true)::json, $1::text);
$$;
create function public.it_webhook_fail(json) returns void
language plpgsql as $$ begin raise exception 'receiver refused'; end $$;
grant execute on function public.it_webhook_sink(json), public.it_webhook_fail(json) to anon;
notify pgrst, 'reload schema';
SQL
sleep 1

AI_PROCTOR_SUPABASE_URL=$API_URL \
AI_PROCTOR_SUPABASE_ANON_KEY=$ANON_KEY \
AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
AI_PROCTOR_DB_URL=$DB_URL \
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/it-webhooks.ts
