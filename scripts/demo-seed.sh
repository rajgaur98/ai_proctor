#!/bin/bash
# Demo data set (#351): resets this checkout's stack, then loads ~60 more people into
# the base seed's org (Acme Remote) with about four weeks of history ending now, so
# signing in as Ada (admin@acme.test) or Max (manager@acme.test) shows every state the
# product can display. Everyone signs in with `password123`.
#
#   scripts/demo-seed.sh
#
# It RESETS the database (scripts/stack.sh reset): everything in it is replaced. Never
# part of a test run: pgTAP and e2e expect the bare base seed (scripts/stack.sh reset).
#
# How the data is made (supabase/demo/): generate.ts writes a plan (people, catalogue,
# leave, holidays, raw agent events checked against the events contract), then SQL
# replays the events through internal.apply_event and does what people do through the
# product's own RPCs, as the signed-in person; rebuild-segments, Storage uploads and
# webhook deliveries go over HTTP as in production. Deterministic: the same story every
# run, moved to the current time. "Now" is live for 8 hours (see 20_replay.sql).
#
# Which stack: this worktree's, through scripts/stack.sh (override with STACK_SH).
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:$PATH"
STACK_SH=${STACK_SH:-$ROOT/scripts/stack.sh}
DEMO=$ROOT/supabase/demo
command -v psql >/dev/null || { echo "psql not found (brew install libpq)" >&2; exit 1; }
start=$(date +%s)
step() { printf '[%3ss] %s\n' $(($(date +%s) - start)) "$*"; }

step "resetting the stack"
"$STACK_SH" reset >/dev/null 2>&1 || { "$STACK_SH" reset; exit 1; }
eval "$("$STACK_SH" env | grep -E '^(DB_URL|API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
[ -n "${DB_URL:-}" ] || { echo "stack not running: scripts/stack.sh up" >&2; exit 1; }
export AI_PROCTOR_SUPABASE_URL=$API_URL AI_PROCTOR_SUPABASE_ANON_KEY=$ANON_KEY \
  AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
STACK_SH=$STACK_SH bash scripts/stack-secrets.sh >/dev/null

TMP=$(mktemp -d)
cron() {
  psql "$DB_URL" -X -q -o /dev/null -c "select cron.alter_job(jobid, active := $1) from cron.job"
}
cleanup() {
  rm -rf "$TMP"
  cron true >/dev/null 2>&1 || true
  # The temporary webhook receiver never outlives the run.
  psql "$DB_URL" -X -q -c "drop function if exists public.demo_webhook_sink(json); notify pgrst, 'reload schema';" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT
sql() { psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
node_ts() { node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$@"; }

step "generating the plan"
node_ts "$DEMO/generate.ts" > "$TMP/plan.sql"

step "setting up the org"
# The cron jobs wait while history is replayed (alerts, sweeps and emails would act on a
# half-loaded past); the replay runs their functions at the replayed times instead.
cron false
sql -1 -f "$DEMO/00_schema.sql" -f "$TMP/plan.sql" -f "$DEMO/10_setup.sql" -f "$DEMO/20_replay.sql" >/dev/null

step "replaying the history"
sql -c "call demo.replay()" -c "select demo.settle()" >/dev/null
cron true

step "activity samples, time segments and captures (in parallel)"
# Activity buckets (psql, in slices), the segments rebuild and the capture uploads read
# different tables; the uploads wait for the retention job, which marks the check-ins
# past the image retention as deleted (their files are never uploaded).
parts=8
pids=()
for i in $(seq 0 $((parts - 1))); do
  sql -c "select demo.activity($i, $parts)" >/dev/null &
  pids+=($!)
done
node_ts "$DEMO/http.ts" rebuild &
pids+=($!)
(
  node_ts "$DEMO/http.ts" retention
  sql -At -F $'\t' -c "
    select u.email, c.org_id, c.user_id, to_char(c.scheduled_at at time zone 'UTC', 'YYYY-MM-DD'), c.id, k
    from public.checkin_events c
    join public.users u on u.id = c.user_id
    cross join unnest(c.object_keys) k
    where c.outcome = 'pass' and c.captures_purged_at is null" > "$TMP/captures.tsv"
  node_ts "$DEMO/http.ts" captures "$TMP/captures.tsv"
) &
pids+=($!)
for pid in "${pids[@]}"; do
  wait "$pid"
done
sql -c "select demo.ack_devices()" >/dev/null
rejected=$(sql -At -c "select count(*) from demo.rejections")
if [ "$rejected" != "0" ]; then
  echo "the server refused $rejected generated events:" >&2
  sql -c "select person, type, reason, count(*) from demo.rejections group by 1, 2, 3 order by 4 desc limit 20" >&2
  exit 1
fi

step "people's actions"
# The payroll webhook's receiver: a PostgREST function inside the stack (as
# it-webhooks.sh does), there only while the seed runs (cleanup drops it).
sql >/dev/null <<'SQL'
create function public.demo_webhook_sink(json) returns void language sql as $$ select $$;
grant execute on function public.demo_webhook_sink(json) to anon;
notify pgrst, 'reload schema';
SQL
sql -1 -f "$DEMO/30_people.sql" >/dev/null
node_ts "$DEMO/http.ts" rebuild

step "timesheets"
sql -1 -f "$DEMO/40_timesheets.sql" >/dev/null
node_ts "$DEMO/http.ts" rebuild

step "insights, digests, reminders"
sql -1 -f "$DEMO/50_finish.sql" >/dev/null

step "webhook deliveries"
# deliver-webhooks, as the webhooks_kick cron calls it, until nothing new is waiting.
sql -c "select internal.webhooks_kick()" >/dev/null
for _ in $(seq 1 30); do
  left=$(sql -At -c "select count(*) from public.webhook_deliveries where status = 'pending' and attempts = 0")
  [ "$left" = "0" ] && break
  sleep 1
done

sql -f "$DEMO/90_finish.sql"
step "done"
cat <<EOF

Sign in at the dashboard (password123):
  admin@acme.test          Ada, owner: everything
  manager@acme.test        Max, Support's manager
  daniel.okafor@acme.test  Daniel, manager of managers, covering Sales (delegation)
  priya.raman@acme.test    Priya, admin and Finance's manager
  sofia.herrera@acme.test  Sofia, Engineering's manager: the live crew (every status)
  erin@acme.test           Erin, an employee: her own data, timesheets, time off
                           (also the one to sign in with on the agent's tray)
The live statuses hold for 8 hours; run this again to move "now".
EOF
