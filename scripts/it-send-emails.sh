#!/bin/bash
# Integration check for manager alert email (#50), end to end on a local stack:
# an agent (Erin, through the real sync RPCs) misses three check-ins -> alert_eval
# raises the alert -> email_outbox -> send_emails_kick calls the send-emails Edge
# Function through pg_net with the Vault key -> the mail lands in Mailpit.
# Then a second streak inside the hour is held (no second email), and once the hour
# is over it goes out as the next email. Also checks the function refuses other callers.
#
# Needs a reset stack with this branch's migrations and an Edge runtime started
# since send-emails last changed (stack.sh down, then up). It puts the two Vault
# secrets in the stack's database itself (project_url, service_role_key), as the
# send_emails cron job reads them. Local only: it clears alerts, the outbox and
# Mailpit, and signs in as the seed users.
#   scripts/stack.sh up && scripts/stack.sh reset && scripts/it-send-emails.sh
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

sql() { psql "$DB_URL" -v ON_ERROR_STOP=1 -At -q "$@"; }
fail() { echo "FAIL $*" >&2; exit 1; }
ok() { echo "ok  $*"; }

# Waits up to 40 s for `to:manager@acme.test` mail in Mailpit to reach $1 messages.
wait_mail() {
  local want=$1 n=0
  for _ in $(seq 1 40); do
    n=$(curl -s "$MAILPIT_URL/api/v1/search?query=to:manager@acme.test" | jq '.messages_count')
    [ "$n" = "$want" ] && return 0
    sleep 1
  done
  fail "expected $want mail(s) to manager@acme.test in Mailpit, found $n"
}
mails() { curl -s "$MAILPIT_URL/api/v1/search?query=to:manager@acme.test" | jq '.messages_count'; }

# The Vault secrets send_emails_kick reads (values via stdin, not the command line).
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -o /dev/null -f - <<SQL
select vault.create_secret('http://kong:8000', 'project_url')
where not exists (select 1 from vault.secrets where name = 'project_url');
select vault.update_secret(id, 'http://kong:8000') from vault.secrets where name = 'project_url';
select vault.create_secret('$SERVICE_ROLE_KEY', 'service_role_key')
where not exists (select 1 from vault.secrets where name = 'service_role_key');
select vault.update_secret(id, '$SERVICE_ROLE_KEY') from vault.secrets where name = 'service_role_key';
SQL

sql -c "delete from public.alerts; delete from public.email_outbox" >/dev/null
curl -s -X DELETE "$MAILPIT_URL/api/v1/messages" >/dev/null

# Not callable by anyone but the cron job.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/functions/v1/send-emails" \
  -H "Authorization: Bearer $ANON_KEY" -H 'Content-Type: application/json' -d '{}')
[ "$code" = "401" ] || fail "send-emails answered $code to the anon key (want 401)"
ok "send-emails refuses a caller without the service-role key"

# Erin's agent ----------------------------------------------------------------------------
token=$(curl -s -X POST "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" \
  -H 'Content-Type: application/json' -d '{"email":"erin@acme.test","password":"password123"}' \
  | jq -r .access_token)
[ -n "$token" ] && [ "$token" != null ] || fail "Erin could not sign in"
rpc() {
  curl -s -X POST "$API_URL/rest/v1/rpc/$1" -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$2"
}
device=$(rpc register_device "{\"platform\":\"macos\",\"os_version\":\"26.0\",\"agent_version\":\"0.1.0\",\"hardware_hash\":\"it-send-emails-$(date +%s)\"}" | jq -r .device_id)
[ -n "$device" ] && [ "$device" != null ] || fail "register_device failed"
seq=0
send() { # type payload-json
  seq=$((seq + 1))
  local at body
  at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  body=$(jq -n --arg d "$device" --arg id "$(uuidgen)" --argjson seq "$seq" --arg type "$1" \
    --arg at "$at" --argjson p "$2" \
    '{device_id: $d, events: [{id: $id, seq: $seq, type: $type, at: $at, mono_ms: $seq, payload: $p}]}')
  local out
  out=$(rpc agent_events "$body")
  [ "${ALLOW_REJECT:-}" = 1 ] || [ "$(echo "$out" | jq '.rejected | length')" = "0" ] \
    || fail "event $1 rejected: $out"
}
miss() {
  local t
  t=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  send checkin "{\"scheduled_at\":\"$t\",\"shown_at\":\"$t\",\"outcome\":\"miss\",\"wrong_clicks\":0,\"idle_s_at_show\":420,\"device_state\":\"active\",\"object_keys\":[],\"flags\":[]}"
  sleep 1
}
pass() {
  local t
  t=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  send checkin "{\"scheduled_at\":\"$t\",\"shown_at\":\"$t\",\"responded_at\":\"$t\",\"outcome\":\"pass\",\"response_ms\":3000,\"wrong_clicks\":0,\"object_keys\":[],\"flags\":[]}"
  sleep 1
}

# Starts a fresh shift (a new clock session), as the first check-in of a shift.
ALLOW_REJECT=1 send clock_out '{"reason":"manual"}'
send clock_in '{"reason":"manual"}'
miss; miss; miss

# Alert and email ----------------------------------------------------------------------------
sql -c "select internal.alert_eval()" >/dev/null
n=$(sql -c "select count(*) from public.alerts a join public.users u on u.id = a.recipient_id
            where a.kind = 'consecutive_misses' and u.email = 'manager@acme.test'")
[ "$n" = "1" ] || fail "expected 1 consecutive_misses alert for the manager, found $n"
ok "three misses in a row raised one alert for Max Manager"

sql -c "select internal.send_emails_kick()" >/dev/null
wait_mail 1
subject=$(curl -s "$MAILPIT_URL/api/v1/search?query=to:manager@acme.test" | jq -r '.messages[0].Subject')
[ "$subject" = "Erin Employee: Missed check-ins in a row" ] || fail "unexpected subject: $subject"
sent=$(sql -c "select count(*) from public.email_outbox where sent_at is not null and attempts = 1")
[ "$sent" = "1" ] || fail "outbox row not marked sent after one attempt"
ok "send_emails_kick -> send-emails -> Mailpit: '$subject', outbox row marked sent"

# Batching -------------------------------------------------------------------------------------
pass; miss; miss; miss
sql -c "select internal.alert_eval()" >/dev/null
[ "$(sql -c "select count(*) from public.alerts where kind = 'consecutive_misses'")" = "2" ] \
  || fail "the second streak did not raise a second alert"
sql -c "select internal.send_emails_kick()" >/dev/null
sleep 5
[ "$(mails)" = "1" ] || fail "a second email went out inside the hour"
[ "$(sql -c "select count(*) from public.alerts where email_id is null")" = "1" ] || fail "the second alert is not being held"
ok "a second alert for the same employee and kind inside the hour is held (still 1 email)"

sql -c "update public.email_outbox set created_at = now() - interval '61 minutes'" >/dev/null
sql -c "select internal.alert_eval()" >/dev/null
sql -c "select internal.send_emails_kick()" >/dev/null
wait_mail 2
ok "after the hour the held alert goes out as the next email (2 emails total)"

send clock_out '{"reason":"manual"}'
echo "all checks passed"
