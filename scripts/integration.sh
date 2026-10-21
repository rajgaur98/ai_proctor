#!/bin/bash
# Runs every integration check against this checkout's stack, each on a freshly
# reset database with the Vault secrets set (#191). CI runs it; locally it needs
# the stack up (`scripts/stack.sh up`) and resets it several times.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
S=scripts/stack.sh

fresh() {
  # A reset right after another one sometimes fails while containers restart.
  bash "$S" reset >/dev/null 2>&1 || { sleep 5; bash "$S" reset >/dev/null; }
  bash scripts/stack-secrets.sh >/dev/null
  # A reset doesn't empty Mailpit; the email checks count messages.
  local mailpit
  mailpit=$(bash "$S" env | grep -E '^MAILPIT_URL=' | cut -d= -f2- | tr -d '"')
  curl -s -X DELETE "$mailpit/api/v1/messages" >/dev/null || true
}

for check in it-rebuild-segments it-export-timesheet it-export-my-data it-send-emails it-reminders it-digest; do
  echo "== $check"
  fresh
  bash "scripts/$check.sh"
done

echo "== check-retention-purge"
fresh
eval "$(bash "$S" env | grep -E '^(API_URL|SERVICE_ROLE_KEY|ANON_KEY|DB_URL)=' | sed 's/^/export /')"
bash scripts/check-retention-purge.sh
