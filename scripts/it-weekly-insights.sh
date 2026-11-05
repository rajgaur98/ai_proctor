#!/bin/bash
# Integration check for the weekly insights email (#305, INS-06), end to end on a local
# stack: weekly_insights_eval (the `weekly_insights` cron job's function, here with a fixed
# clock) queues the email_outbox row -> send_emails_kick calls the send-emails Edge
# Function through pg_net with the Vault key -> the mail lands in Mailpit. Max manages Erin
# and Lucas; in the week of Monday 16 March 2026 Erin worked 3 h 30 min (30 min of it
# flagged), missed a check-in, clocked in 20 minutes late and took Wednesday off (an approved
# paid day of leave: her 8-hour shift, the Leave line, #344). The email is off until Max
# turns it on (set_weekly_insights, signed in as him); then it goes out at 09:00 Chicago on
# Monday 23 March, with last week's totals next to the week before's and no names. A
# repeat run sends nothing.
#
# Needs a reset stack with this branch's migrations and an Edge runtime started since
# send-emails last changed (stack.sh down, then up). It puts the two Vault secrets in the
# stack's database itself (project_url, service_role_key). Local only: it clears the weekly
# emails sent, the outbox and Mailpit, and signs in as the seed users.
#   scripts/stack.sh up && scripts/stack.sh reset && scripts/it-weekly-insights.sh
# Which stack: this worktree's through scripts/stack.sh (override with STACK_SH);
# without it, the main checkout's default stack.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:$PATH"
command -v psql >/dev/null || { echo "psql not found (brew install libpq)" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq not found" >&2; exit 1; }

STACK_SH=${STACK_SH:-$ROOT/scripts/stack.sh}
VARS='^(DB_URL|API_URL|ANON_KEY|SERVICE_ROLE_KEY|MAILPIT_URL)='
if [ -x "$STACK_SH" ]; then
  eval "$("$STACK_SH" env | grep -E "$VARS")"
else
  eval "$(pnpm --silent supabase status -o env 2>/dev/null | grep -E "$VARS")"
fi
[ -n "${API_URL:-}" ] || { echo "stack not running: scripts/stack.sh up" >&2; exit 1; }

ERIN=00000000-0000-4000-8000-0000000000c1
ORG=00000000-0000-4000-8000-000000000001
DEV=00000000-0000-4000-8000-0000000067e2

sql() { psql "$DB_URL" -v ON_ERROR_STOP=1 -At -q "$@"; }
fail() { echo "FAIL $*" >&2; exit 1; }
ok() { echo "ok  $*"; }

# Weekly insights mail to $1 in Mailpit.
weeklies() {
  curl -s -G "$MAILPIT_URL/api/v1/search" --data-urlencode "query=to:$1 subject:\"Weekly insights\"" \
    | jq '.messages_count'
}
wait_mail() {
  local n=0
  for _ in $(seq 1 40); do
    n=$(weeklies "$1")
    [ "$n" = "$2" ] && return 0
    sleep 1
  done
  fail "expected $2 weekly email(s) to $1 in Mailpit, found $n"
}
# The first weekly email to $1: prints "subject|body text".
first_mail() {
  local id
  id=$(curl -s -G "$MAILPIT_URL/api/v1/search" --data-urlencode "query=to:$1 subject:\"Weekly insights\"" \
    | jq -r '.messages[0].ID')
  curl -s "$MAILPIT_URL/api/v1/message/$id" | jq -r '[.Subject, (.Text | gsub("\n"; " "))] | join("|")'
}
run_at() {
  sql -c "select internal.weekly_insights_eval('$1')" >/dev/null
  sql -c "select internal.send_emails_kick()" >/dev/null
}

# The Vault secrets send_emails_kick reads (values via stdin, not the command line).
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -o /dev/null -f - <<SQL
select vault.create_secret('http://kong:8000', 'project_url')
where not exists (select 1 from vault.secrets where name = 'project_url');
select vault.update_secret(id, 'http://kong:8000') from vault.secrets where name = 'project_url';
select vault.create_secret('$SERVICE_ROLE_KEY', 'service_role_key')
where not exists (select 1 from vault.secrets where name = 'service_role_key');
select vault.update_secret(id, '$SERVICE_ROLE_KEY') from vault.secrets where name = 'service_role_key';
SQL

cleanup() {
  sql -c "delete from public.time_segments where user_id = '$ERIN' and day = '2026-03-17';
          delete from public.checkin_events where device_id = '$DEV';
          delete from public.clock_sessions where device_id = '$DEV';
          delete from public.devices where id = '$DEV';
          delete from public.leave_requests where user_id = '$ERIN' and note = 'it-weekly-insights';
          delete from public.notification_prefs;
          delete from public.weekly_insights_sent;
          delete from public.dirty_days where day = '2026-03-17'" >/dev/null || true
}
trap cleanup EXIT

sql -c "delete from public.weekly_insights_sent; delete from public.email_outbox; delete from public.notification_prefs" >/dev/null
curl -s -X DELETE "$MAILPIT_URL/api/v1/messages" >/dev/null

sql -c "insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
        values ('$DEV', '$ORG', '$ERIN', 'macos', '26.0', '0.1.0', 'it-weekly-insights');
        insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
        values ('$ORG', '$ERIN', '$DEV', '2026-03-17 09:20:00-07', '2026-03-17 12:50:00-07', gen_random_uuid());
        insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome)
        values (gen_random_uuid(), '$ORG', '$ERIN', '$DEV', '2026-03-17 11:00:00-07', '2026-03-17 11:00:00-07', 'miss');
        delete from public.leave_requests where user_id = '$ERIN' and note = 'it-weekly-insights';
        insert into public.leave_requests (org_id, user_id, leave_type_id, paid, kind, first_day, last_day,
          start_at, end_at, timezone, note, status)
        select '$ORG', '$ERIN', t.id, true, 'days', '2026-03-18', '2026-03-18', '2026-03-18 00:00:00-07',
          '2026-03-19 00:00:00-07', 'America/Los_Angeles', 'it-weekly-insights', 'approved'
        from public.leave_types t where t.org_id = '$ORG' and t.name = 'Vacation';
        delete from public.time_segments where user_id = '$ERIN' and day = '2026-03-17';
        insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged)
        values ('$ORG', '$ERIN', '2026-03-17', '2026-03-17 09:20:00-07', '2026-03-17 12:20:00-07', 'verified', true, false),
               ('$ORG', '$ERIN', '2026-03-17', '2026-03-17 12:20:00-07', '2026-03-17 12:50:00-07', 'unverified', true, true);
        delete from public.dirty_days where day = '2026-03-17'" >/dev/null

# Off by default ----------------------------------------------------------------------------------
run_at '2026-03-23 14:00:00+00'
sleep 3
[ "$(weeklies manager@acme.test)" = "0" ] || fail "Max got a weekly email he never turned on"
ok "nothing for Max while the weekly email is off (the default)"

# Max turns it on, through the API -------------------------------------------------------------------
token=$(curl -s -X POST "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" \
  -H 'Content-Type: application/json' -d '{"email":"manager@acme.test","password":"password123"}' \
  | jq -r .access_token)
[ -n "$token" ] && [ "$token" != null ] || fail "Max could not sign in"
on=$(curl -s -X POST "$API_URL/rest/v1/rpc/set_weekly_insights" -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"p_enabled": true}')
[ "$on" = "true" ] || fail "set_weekly_insights answered $on"

run_at '2026-03-23 13:59:00+00'
sleep 3
[ "$(weeklies manager@acme.test)" = "0" ] || fail "Max got the weekly email before 09:00 his time"
ok "nothing for Max at 08:59 Chicago on Monday"

run_at '2026-03-23 14:00:00+00'
wait_mail manager@acme.test 1
mail=$(first_mail manager@acme.test)
case "${mail%%|*}" in "Weekly insights: your team, "*) ;; *) fail "unexpected subject: ${mail%%|*}" ;; esac
for want in "Worked: 3:30 (week before 0:00)" "Flagged: 0:30 (week before 0:00)" \
  "Leave: 8:00 (week before 0:00)" \
  "Late clock-ins: 1 (week before 0)" "Missed check-ins: 1 (week before 0)" "/insights"; do
  case "$mail" in *"$want"*) ;; *) fail "'$want' is missing in: $mail" ;; esac
done
case "$mail" in *"Erin Employee"*|*"Lucas Martin"*) fail "the weekly email names people: $mail" ;; esac
ok "at 09:00 Chicago on Monday Max gets '${mail%%|*}' with last week's totals and no names"

run_at '2026-03-23 15:00:00+00'
sleep 3
[ "$(weeklies manager@acme.test)" = "1" ] || fail "a repeat run sent another weekly email"
ok "a later run the same week sends nothing more (one a week)"

sent=$(sql -c "select count(*) from public.email_outbox where template = 'weekly_insights' and sent_at is not null and attempts = 1")
[ "$sent" = "1" ] || fail "expected 1 weekly outbox row marked sent after one attempt, found $sent"
ok "the outbox row is marked sent"
echo "all checks passed"
