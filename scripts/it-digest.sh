#!/bin/bash
# Integration check for the managers' daily digest (#67, ALR-03), end to end on a local
# stack: digest_eval (the `digest` cron job's function, here with a fixed clock) queues
# the email_outbox row -> send_emails_kick calls the send-emails Edge Function through
# pg_net with the Vault key -> the mail lands in Mailpit. Max manages Erin and Lucas; on
# Tuesday 17 March 2026 Erin worked 3 h 30 min (30 min of it flagged), missed a check-in
# and clocked in 20 minutes late. Max's digest goes out at 09:00 Chicago the next morning.
# Then: a repeat run sends nothing, and after Max turns the digest off (set_daily_digest,
# signed in as him) the next day's digest is not sent.
#
# Needs a reset stack with this branch's migrations and an Edge runtime started since
# send-emails last changed (stack.sh down, then up). It puts the two Vault secrets in the
# stack's database itself (project_url, service_role_key). Local only: it clears digests,
# the outbox and Mailpit, and signs in as the seed users.
#   scripts/stack.sh up && scripts/stack.sh reset && scripts/it-digest.sh
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
DEV=00000000-0000-4000-8000-0000000067e1

sql() { psql "$DB_URL" -v ON_ERROR_STOP=1 -At -q "$@"; }
fail() { echo "FAIL $*" >&2; exit 1; }
ok() { echo "ok  $*"; }

# Digest mail to $1 in Mailpit (the stack's alert_eval cron may mail other things meanwhile).
digests() {
  curl -s -G "$MAILPIT_URL/api/v1/search" --data-urlencode "query=to:$1 subject:\"Daily digest\"" \
    | jq '.messages_count'
}
# Waits up to 40 s for digest mail to $1 to reach $2 messages.
wait_mail() {
  local n=0
  for _ in $(seq 1 40); do
    n=$(digests "$1")
    [ "$n" = "$2" ] && return 0
    sleep 1
  done
  fail "expected $2 digest(s) to $1 in Mailpit, found $n"
}
# The first digest to $1: prints "subject|body text".
first_mail() {
  local id
  id=$(curl -s -G "$MAILPIT_URL/api/v1/search" --data-urlencode "query=to:$1 subject:\"Daily digest\"" \
    | jq -r '.messages[0].ID')
  curl -s "$MAILPIT_URL/api/v1/message/$id" | jq -r '[.Subject, (.Text | gsub("\n"; " "))] | join("|")'
}
# Runs the digest evaluation at a fixed time, then the send_emails job.
run_at() {
  sql -c "select internal.digest_eval('$1')" >/dev/null
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
          delete from public.notification_prefs;
          delete from public.dirty_days where day = '2026-03-17'" >/dev/null || true
}
trap cleanup EXIT

sql -c "delete from public.digests_sent; delete from public.email_outbox; delete from public.notification_prefs" >/dev/null
curl -s -X DELETE "$MAILPIT_URL/api/v1/messages" >/dev/null

# Erin's Tuesday (Los Angeles, -07): 3 h counted, then 30 min flagged; a miss; clocked in at
# 09:20 for her 09:00 shift (recorded as a late clock-in by the clock_sessions trigger).
sql -c "insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
        values ('$DEV', '$ORG', '$ERIN', 'macos', '26.0', '0.1.0', 'it-digest');
        insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
        values ('$ORG', '$ERIN', '$DEV', '2026-03-17 09:20:00-07', '2026-03-17 12:50:00-07', gen_random_uuid());
        insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome)
        values (gen_random_uuid(), '$ORG', '$ERIN', '$DEV', '2026-03-17 11:00:00-07', '2026-03-17 11:00:00-07', 'miss');
        delete from public.time_segments where user_id = '$ERIN' and day = '2026-03-17';
        insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged)
        values ('$ORG', '$ERIN', '2026-03-17', '2026-03-17 09:20:00-07', '2026-03-17 12:20:00-07', 'verified', true, false),
               ('$ORG', '$ERIN', '2026-03-17', '2026-03-17 12:20:00-07', '2026-03-17 12:50:00-07', 'unverified', true, true);
        delete from public.dirty_days where day = '2026-03-17'" >/dev/null
[ "$(sql -c "select late_s from public.late_clock_ins where user_id = '$ERIN' and day = '2026-03-17'")" = "1200" ] \
  || fail "the late clock-in was not recorded"
ok "clocking in at 09:20 for a 09:00 shift is recorded as 20 minutes late"

# Not before 09:00 in Chicago -------------------------------------------------------------------
run_at '2026-03-18 13:59:00+00'
sleep 3
[ "$(digests manager@acme.test)" = "0" ] || fail "Max got a digest before 09:00 his time"
ok "nothing for Max at 08:59 Chicago"

# At 09:00 --------------------------------------------------------------------------------------------
run_at '2026-03-18 14:00:00+00'
wait_mail manager@acme.test 1
mail=$(first_mail manager@acme.test)
[ "${mail%%|*}" = "Daily digest: your team on Tue, Mar 17" ] || fail "unexpected subject: ${mail%%|*}"
case "$mail" in
  *"Erin Employee: 3:30 worked, 0:30 flagged, 1 missed check-in, 1 late clock-in"*) ;;
  *) fail "Erin's line is missing or wrong in: $mail" ;;
esac
case "$mail" in *"/team/$ERIN?date=2026-03-17"*) ;; *) fail "no link to Erin's day in: $mail" ;; esac
case "$mail" in *"Lucas Martin: 0:00 worked"*) ;; *) fail "Lucas (no time) is not listed: $mail" ;; esac
ok "at 09:00 Chicago Max gets '${mail%%|*}' with Erin's hours, flagged time, misses and late clock-in"

run_at '2026-03-18 14:15:00+00'
sleep 3
[ "$(digests manager@acme.test)" = "1" ] || fail "a repeat run sent another digest"
ok "a later run the same day sends nothing more (one a day)"

# Opt-out, as Max through the API ------------------------------------------------------------------
token=$(curl -s -X POST "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" \
  -H 'Content-Type: application/json' -d '{"email":"manager@acme.test","password":"password123"}' \
  | jq -r .access_token)
[ -n "$token" ] && [ "$token" != null ] || fail "Max could not sign in"
off=$(curl -s -X POST "$API_URL/rest/v1/rpc/set_daily_digest" -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"p_enabled": false}')
[ "$off" = "false" ] || fail "set_daily_digest answered $off"
# Erin worked on the Wednesday too.
sql -c "insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged)
        values ('$ORG', '$ERIN', '2026-03-18', '2026-03-18 09:00:00-07', '2026-03-18 10:00:00-07', 'verified', true, false)" >/dev/null
run_at '2026-03-19 14:00:00+00'
sleep 3
sql -c "delete from public.time_segments where user_id = '$ERIN' and day = '2026-03-18'" >/dev/null
[ "$(digests manager@acme.test)" = "1" ] || fail "Max got a digest after turning it off"
ok "after Max turns the digest off, the next day's is not sent"

sent=$(sql -c "select count(*) from public.email_outbox where template = 'digest' and sent_at is not null and attempts = 1")
[ "$sent" = "1" ] || fail "expected 1 digest outbox row marked sent after one attempt, found $sent"
ok "the outbox row is marked sent"
echo "all checks passed"
