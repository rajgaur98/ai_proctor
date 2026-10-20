#!/bin/bash
# Integration check for the retention-purge Edge Function (#51): an expired capture
# is deleted from Storage through the function and its check-in is marked; a recent
# one is left alone; callers other than the service role are refused.
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
       delete from public.devices where id = '$DEVICE';
       delete from public.retention_runs where at > now() - interval '1 hour';
       delete from public.audit_log where action = 'retention.purged' and at > now() - interval '1 hour';" > /dev/null || true
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

# A second run finds nothing for these.
check "second run deletes no captures" "$(purge | sed -n 's/.*"captures":\([0-9]*\).*/\1/p')" 0
echo "all checks passed"
