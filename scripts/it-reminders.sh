#!/bin/bash
# Integration check for the timesheet reminder emails (#46, TS-17), end to end on a
# local stack: reminders_eval (the `reminders` cron job's function, here with a fixed
# clock) queues the email_outbox rows -> send_emails_kick calls the send-emails Edge
# Function through pg_net with the Vault key -> the mail lands in Mailpit. It walks
# the three reminders for Erin's week of Monday 16 March 2026:
#   2 days after submission  Max (manager)         "waiting for your approval"
#   5 days after submission  the owner (admin)     "has waited 5 days" (notify only)
#   last shift day, draft    Erin                  "Submit your timesheet" (Friday, one
#                                                  hour before her 17:00 shift ends)
#
# Needs a reset stack with this branch's migrations and an Edge runtime started
# since send-emails last changed (stack.sh down, then up). It puts the two Vault
# secrets in the stack's database itself (project_url, service_role_key). Local
# only: it clears reminders, timesheets, the outbox and Mailpit.
#   scripts/stack.sh up && scripts/stack.sh reset && scripts/it-reminders.sh
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

sql() { psql "$DB_URL" -v ON_ERROR_STOP=1 -At -q "$@"; }
fail() { echo "FAIL $*" >&2; exit 1; }
ok() { echo "ok  $*"; }

# The pg_net request ids of this run's send_emails_kick calls, and the latest one (#288).
KICKS=""
LAST_KICK=""
# Claimed rows this script made due again after a send-emails call that didn't deliver.
REQUEUED=0
# The send_emails job, as the cron runs it. No id when nothing is due.
kick() {
  LAST_KICK=$(sql -c "select internal.send_emails_kick()")
  KICKS="$KICKS $LAST_KICK"
}
# What the latest kick's send-emails call answered: pending (no answer yet), ok (200 and
# nothing failed) or failed (an error status, a pg_net error or timeout, or failed > 0).
last_call() {
  sql -c "select case
                   when r.id is null then 'pending'
                   when r.status_code = 200
                     and (case when r.content ~ '^\s*\{' then r.content::jsonb ->> 'failed' end) = '0'
                     then 'ok'
                   else 'failed'
                 end
          from (select 1) x left join net._http_response r on r.id = $LAST_KICK"
}
# The outbox rows, what send-emails answered each kick, the send_emails cron runs and
# the edge runtime's log, so a failed delivery shows its cause (#288).
diagnose() {
  {
    echo "-- now $(sql -c "select now()" 2>&1)"
    echo "-- email_outbox: to | template | created_at | send_after (next attempt) | sent_at | attempts | last_error"
    sql -F ' | ' -c "select to_email, template, created_at, send_after, sent_at, attempts, last_error
                     from public.email_outbox order by created_at" 2>&1
    echo "-- send-emails responses through pg_net: kick id | status | timed_out | error | body"
    local id
    for id in $KICKS; do
      sql -F ' | ' -c "select $id, coalesce(r.status_code::text, 'no response'), r.timed_out,
                              r.error_msg, left(r.content, 300)
                       from (select 1) x left join net._http_response r on r.id = $id" 2>&1
    done
    echo "-- pg_net queue: $(sql -c "select count(*) from net.http_request_queue" 2>&1) request(s) waiting"
    echo "-- send_emails cron runs: start | status | message"
    sql -F ' | ' -c "select d.start_time, d.status, d.return_message from cron.job_run_details d
                     join cron.job j on j.jobid = d.jobid where j.jobname = 'send_emails'
                     order by d.start_time desc limit 5" 2>&1
    local cfg="$ROOT/.stack/supabase/config.toml" project
    [ -f "$cfg" ] || cfg="$ROOT/supabase/config.toml"
    project=$(sed -n 's/^project_id = "\(.*\)"/\1/p' "$cfg")
    if command -v docker >/dev/null; then
      echo "-- edge runtime log (supabase_edge_runtime_$project, last 30 lines)"
      docker logs --tail 30 "supabase_edge_runtime_$project" 2>&1
    fi
  } >&2 || true
}

# Waits up to 40 s for mail to $1 in Mailpit to reach $2 messages.
# A send-emails call that claims a row and then doesn't deliver it (the edge worker
# aborted, Mailpit refused the connection) leaves the row in email_claim's backoff: the
# cron job retries it after a minute, which this wait would miss (#288). So when the last
# call has answered with a failure and the mail isn't there, the script does that retry
# itself, at most twice: it prints what happened, makes the unsent rows due and kicks.
wait_mail() {
  local n=0 retries=0
  for _ in $(seq 1 40); do
    n=$(curl -s "$MAILPIT_URL/api/v1/search?query=to:$1" | jq '.messages_count')
    [ "$n" = "$2" ] && return 0
    if [ -n "$LAST_KICK" ] && [ "$retries" -lt 2 ] && [ "$(last_call)" = "failed" ]; then
      echo "note: send-emails call $LAST_KICK did not deliver; retrying it as the send_emails job would (#288)" >&2
      diagnose
      retries=$((retries + 1))
      REQUEUED=$((REQUEUED + $(sql -c "with r as (
          update public.email_outbox set send_after = now()
          where sent_at is null and attempts between 1 and 4 returning 1)
        select count(*) from r")))
      kick
    fi
    sleep 1
  done
  diagnose
  fail "expected $2 mail(s) to $1 in Mailpit, found $n"
}
# The first message to $1: prints "subject|body text".
first_mail() {
  local id
  id=$(curl -s "$MAILPIT_URL/api/v1/search?query=to:$1" | jq -r '.messages[0].ID')
  curl -s "$MAILPIT_URL/api/v1/message/$id" | jq -r '[.Subject, (.Text | gsub("\n"; " "))] | join("|")'
}
# Runs the reminder evaluation at a fixed time, then the send_emails job.
run_at() {
  sql -c "select internal.reminders_eval('$1')" >/dev/null
  kick
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
  sql -c "delete from public.time_segments where user_id = '$ERIN' and day = '2026-03-17'" >/dev/null || true
}
trap cleanup EXIT

sql -c "delete from public.reminders_sent; delete from public.email_outbox;
        delete from public.timesheets; delete from public.notifications" >/dev/null
curl -s -X DELETE "$MAILPIT_URL/api/v1/messages" >/dev/null

# Erin worked on the Tuesday and submitted her week on 17 March at 15:00 UTC.
sql -c "insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged)
        values ('$ORG', '$ERIN', '2026-03-17', '2026-03-17 09:00:00-07', '2026-03-17 12:00:00-07', 'verified', true, false)" >/dev/null
SHEET=$(sql -c "insert into public.timesheets (org_id, user_id, period_start, status, submitted_at)
                values ('$ORG', '$ERIN', '2026-03-16', 'submitted', '2026-03-17 15:00:00+00') returning id")

# Manager, 2 days after submission -----------------------------------------------------------
run_at '2026-03-19 15:00:00+00'
wait_mail manager@acme.test 1
mail=$(first_mail manager@acme.test)
[ "${mail%%|*}" = "Erin Employee's timesheet is waiting for your approval" ] || fail "unexpected subject: ${mail%%|*}"
case "$mail" in *"/timesheets/$ERIN?week=2026-03-16"*) ;; *) fail "no review link in: $mail" ;; esac
ok "2 days after submission Max gets '${mail%%|*}' with the review link"

# Admins, 5 days after submission --------------------------------------------------------------
run_at '2026-03-22 15:00:00+00'
wait_mail admin@acme.test 1
mail=$(first_mail admin@acme.test)
[ "${mail%%|*}" = "Erin Employee's timesheet has waited 5 days for approval" ] || fail "unexpected subject: ${mail%%|*}"
case "$mail" in *"notice only"*) ;; *) fail "the escalation is not marked notify only: $mail" ;; esac
[ "$(sql -c "select status from public.timesheets where id = '$SHEET'")" = "submitted" ] \
  || fail "the escalation changed the timesheet"
ok "5 days after submission the owner gets '${mail%%|*}' (notify only, timesheet untouched)"

# A repeat run sends nothing more.
run_at '2026-03-23 15:00:00+00'
sleep 3
[ "$(curl -s "$MAILPIT_URL/api/v1/messages" | jq '.messages_count')" = "2" ] || fail "a repeat run sent more mail"
ok "a later run sends nothing again (once per timesheet)"

# Employee, last shift day, still a draft ---------------------------------------------------------
# Erin's seeded shifts are Monday to Friday 09:00-17:00 in Los Angeles, so the reminder is due
# on Friday 20 March at 16:00 PDT (23:00 UTC), not on the Sunday (#177).
sql -c "delete from public.timesheets; delete from public.reminders_sent" >/dev/null
run_at '2026-03-20 22:59:00+00'
sleep 2
[ "$(curl -s "$MAILPIT_URL/api/v1/search?query=to:erin@acme.test" | jq '.messages_count')" = "0" ] \
  || fail "Erin was reminded before 16:00 on her last shift day"
run_at '2026-03-20 23:00:00+00'
wait_mail erin@acme.test 1
mail=$(first_mail erin@acme.test)
[ "${mail%%|*}" = "Submit your timesheet for Mon, Mar 16 to Sun, Mar 22" ] || fail "unexpected subject: ${mail%%|*}"
case "$mail" in *"/my-timesheet"*) ;; *) fail "no timesheet link in: $mail" ;; esac
ok "at 16:00 Los Angeles on her last shift day (Friday) Erin gets '${mail%%|*}'"

# One attempt each, plus one for every claimed row wait_mail retried.
sent=$(sql -c "select count(*) filter (where sent_at is not null) || ' sent, '
                      || coalesce(sum(attempts), 0) || ' attempts' from public.email_outbox")
[ "$sent" = "3 sent, $((3 + REQUEUED)) attempts" ] \
  || fail "expected 3 outbox rows sent with $((3 + REQUEUED)) attempts in all, found $sent"
ok "all three outbox rows marked sent"
echo "all checks passed"
