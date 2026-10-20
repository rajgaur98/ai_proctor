#!/bin/bash
# Integration check for the timesheet reminder emails (#46, TS-17), end to end on a
# local stack: reminders_eval (the `reminders` cron job's function, here with a fixed
# clock) queues the email_outbox rows -> send_emails_kick calls the send-emails Edge
# Function through pg_net with the Vault key -> the mail lands in Mailpit. It walks
# the three reminders for Erin's week of Monday 16 March 2026:
#   2 days after submission  Max (manager)         "waiting for your approval"
#   5 days after submission  the owner (admin)     "has waited 5 days" (notify only)
#   end of the week, draft   Erin                  "Submit your timesheet"
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

# Waits up to 40 s for mail to $1 in Mailpit to reach $2 messages.
wait_mail() {
  local n=0
  for _ in $(seq 1 40); do
    n=$(curl -s "$MAILPIT_URL/api/v1/search?query=to:$1" | jq '.messages_count')
    [ "$n" = "$2" ] && return 0
    sleep 1
  done
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

# Employee, end of week, still a draft ------------------------------------------------------------
sql -c "delete from public.timesheets; delete from public.reminders_sent" >/dev/null
run_at '2026-03-22 23:00:00+00'
wait_mail erin@acme.test 1
mail=$(first_mail erin@acme.test)
[ "${mail%%|*}" = "Submit your timesheet for Mon, Mar 16 to Sun, Mar 22" ] || fail "unexpected subject: ${mail%%|*}"
case "$mail" in *"/my-timesheet"*) ;; *) fail "no timesheet link in: $mail" ;; esac
ok "at 16:00 Los Angeles on the last day Erin gets '${mail%%|*}'"

sent=$(sql -c "select count(*) from public.email_outbox where sent_at is not null and attempts = 1")
[ "$sent" = "3" ] || fail "expected 3 outbox rows marked sent after one attempt, found $sent"
ok "all three outbox rows marked sent"
echo "all checks passed"
