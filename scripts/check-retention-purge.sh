#!/bin/bash
# Integration check for the retention-purge Edge Function (#51): an expired capture
# is deleted from Storage through the function and its check-in is marked; a recent
# one is left alone; callers other than the service role are refused. Expired
# timesheet rows (#130) go the same way and are counted in the reply. So do old alerts
# and sent email (#185); an old email still waiting to go out is kept.
# Needs a stack that serves the function (stack.sh down, then up, after adding it).
#
#   eval "$(scripts/stack.sh env | grep -E '^(API_URL|SERVICE_ROLE_KEY|ANON_KEY|DB_URL)=')"
#   bash scripts/check-retention-purge.sh
#
# Uses the seed org and Erin; removes everything it adds.
set -euo pipefail

: "${API_URL:?set API_URL, SERVICE_ROLE_KEY, ANON_KEY and DB_URL (see the header)}"
: "${SERVICE_ROLE_KEY:?}" "${ANON_KEY:?}" "${DB_URL:?}"

ORG=00000000-0000-4000-8000-000000000001
USER=00000000-0000-4000-8000-0000000000c1
DEVICE=00000000-0000-4000-8000-0000000000e9
OLD=00000000-0000-4000-8000-00000000f901
NEW=00000000-0000-4000-8000-00000000f902
OLD_ENTRY=00000000-0000-4000-8000-00000000f903
NEW_ENTRY=00000000-0000-4000-8000-00000000f904
OLD_ALERT=00000000-0000-4000-8000-00000000f905
OLD_MAIL=00000000-0000-4000-8000-00000000f906
PENDING_MAIL=00000000-0000-4000-8000-00000000f907
OLD_PATH="$ORG/$USER/$(date -u -v-35d +%F 2>/dev/null || date -u -d '35 days ago' +%F)/$OLD/screen-1.webp"
NEW_PATH="$ORG/$USER/$(date -u +%F)/$NEW/screen-1.webp"

sql() { psql "$DB_URL" -X -q -t -A -c "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }
check() { [ "$2" = "$3" ] && echo "ok: $1" || fail "$1 (got '$2', want '$3')"; }
http() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

cleanup() {
  curl -s -X DELETE "$API_URL/storage/v1/object/captures" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -H 'Content-Type: application/json' -d "{\"prefixes\": [\"$OLD_PATH\", \"$NEW_PATH\"]}" > /dev/null || true
  sql "delete from public.checkin_events where id in ('$OLD', '$NEW');
       delete from public.manual_entries where id in ('$OLD_ENTRY', '$NEW_ENTRY');
       delete from public.alerts where id = '$OLD_ALERT';
       delete from public.email_outbox where id in ('$OLD_MAIL', '$PENDING_MAIL');
       delete from public.dirty_days where user_id = '$USER' and day < current_date - interval '1 year';
       delete from public.devices where id = '$DEVICE';
       delete from public.retention_runs where at > now() - interval '1 hour';" > /dev/null || true
  # audit_log is append-only (#53): its retention.purged rows stay.
}
trap cleanup EXIT

upload() {
  printf 'RIFF....WEBPfake' | curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/storage/v1/object/captures/$1" \
    -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'Content-Type: image/webp' --data-binary @-
}
fetch() { http "$API_URL/storage/v1/object/captures/$1" -H "Authorization: Bearer $SERVICE_ROLE_KEY"; }
purge() {
  curl -s -X POST "$API_URL/functions/v1/retention-purge" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -H 'Content-Type: application/json' -d '{}'
}

# Fixtures: Erin's device, one check-in 35 days old (30-day default) and one from today.
sql "insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
     values ('$DEVICE', '$ORG', '$USER', 'macos', '26.0', '0.1.0', 'retention-check');
     insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome, object_keys) values
       ('$OLD', '$ORG', '$USER', '$DEVICE', now() - interval '35 days', 'pass', '{screen-1.webp}'),
       ('$NEW', '$ORG', '$USER', '$DEVICE', now(), 'pass', '{screen-1.webp}');" > /dev/null
# Two manual entries (a timesheet table): one ended 4 years ago (3-year default), one 2 years ago.
sql "insert into public.manual_entries (id, org_id, user_id, start_at, end_at, reason, status, decided_at) values
       ('$OLD_ENTRY', '$ORG', '$USER', now() - interval '4 years 1 hour', now() - interval '4 years', 'retention check', 'approved', now()),
       ('$NEW_ENTRY', '$ORG', '$USER', now() - interval '2 years 1 hour', now() - interval '2 years', 'retention check', 'approved', now());" > /dev/null
# An alert and a sent email 13 months old (12-month default), and an unsent one that old.
sql "insert into public.email_outbox (id, org_id, to_email, template, created_at, sent_at, attempts) values
       ('$OLD_MAIL', '$ORG', 'retention@example.test', 'alert', now() - interval '13 months', now() - interval '13 months', 1),
       ('$PENDING_MAIL', '$ORG', 'retention@example.test', 'alert', now() - interval '13 months', null, 0);
     insert into public.alerts (id, org_id, user_id, recipient_id, kind, episode, triggered_at, email_id)
     values ('$OLD_ALERT', '$ORG', '$USER', '$USER', 'offline', 'retention-check', now() - interval '13 months', '$OLD_MAIL');" > /dev/null
check "old capture uploaded" "$(upload "$OLD_PATH")" 200
check "recent capture uploaded" "$(upload "$NEW_PATH")" 200

# Refused callers.
check "no credentials: refused" "$(http -X POST "$API_URL/functions/v1/retention-purge")" 401
check "anon key: refused" "$(http -X POST "$API_URL/functions/v1/retention-purge" -H "Authorization: Bearer $ANON_KEY")" 401
check "GET: refused" "$(http "$API_URL/functions/v1/retention-purge" -H "Authorization: Bearer $SERVICE_ROLE_KEY")" 405
check "nothing deleted yet" "$(fetch "$OLD_PATH")" 200

# The run.
RESULT=$(purge)
echo "reply: $RESULT"
check "no errors" "$(echo "$RESULT" | sed -n 's/.*"errors":\[\(.*\)\].*/\1/p')" ""
check "expired file deleted from Storage" "$(fetch "$OLD_PATH")" 400
check "recent file kept" "$(fetch "$NEW_PATH")" 200
check "expired check-in marked" "$(sql "select captures_purged_at is not null from public.checkin_events where id = '$OLD'")" t
check "recent check-in untouched" "$(sql "select captures_purged_at is null from public.checkin_events where id = '$NEW'")" t
check "files counted" "$(sql "select sum(deleted) from public.retention_runs where org_id = '$ORG' and category = 'captures' and at > now() - interval '1 hour'")" 1
check "expired manual entry deleted" "$(sql "select count(*) from public.manual_entries where id = '$OLD_ENTRY'")" 0
check "recent manual entry kept" "$(sql "select count(*) from public.manual_entries where id = '$NEW_ENTRY'")" 1
check "reply counts the entry" "$(echo "$RESULT" | sed -n 's/.*"manual_entries":\([0-9]*\).*/\1/p')" 1
check "entry counted in the org's log" "$(sql "select sum(deleted) from public.retention_runs where org_id = '$ORG' and category = 'manual_entries' and at > now() - interval '1 hour'")" 1
check "old alert deleted" "$(sql "select count(*) from public.alerts where id = '$OLD_ALERT'")" 0
check "old sent email deleted" "$(sql "select count(*) from public.email_outbox where id = '$OLD_MAIL'")" 0
check "old unsent email kept" "$(sql "select count(*) from public.email_outbox where id = '$PENDING_MAIL'")" 1
check "reply counts the alert" "$(echo "$RESULT" | sed -n 's/.*"alerts":\([0-9]*\).*/\1/p')" 1

# A second run finds nothing for these.
SECOND=$(purge)
check "second run deletes no captures" "$(echo "$SECOND" | sed -n 's/.*"captures":\([0-9]*\).*/\1/p')" 0
check "second run deletes no entries" "$(echo "$SECOND" | sed -n 's/.*"manual_entries":\([0-9]*\).*/\1/p')" ""
echo "all checks passed"
