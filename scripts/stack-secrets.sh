#!/bin/bash
# Puts the two Vault secrets segments_kick (pg_cron) needs into this stack's
# database: project_url and service_role_key (#41). Run it after every
# `stack.sh reset` / `pnpm db:reset` (a reset rebuilds the database, Vault
# included); until then segments_kick does nothing.
#
#   project_url       http://kong:8000, the API as the database container sees it
#                     (pg_net runs inside Docker, so 127.0.0.1 would be itself)
#   service_role_key  the stack's service-role key, which rebuild-segments checks
#
# Which stack: this worktree's, through scripts/stack.sh (override with STACK_SH);
# without stack.sh, the default `pnpm supabase` stack of the main checkout.
# Production sets both once at deploy (M6), in the Supabase dashboard's Vault.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:$PATH"

STACK_SH=${STACK_SH:-$ROOT/scripts/stack.sh}
if [ -x "$STACK_SH" ]; then
  eval "$("$STACK_SH" env | grep -E '^(DB_URL|SERVICE_ROLE_KEY)=')"
else
  eval "$(pnpm --silent supabase status -o env 2>/dev/null | grep -E '^(DB_URL|SERVICE_ROLE_KEY)=')"
fi
[ -n "${DB_URL:-}" ] && [ -n "${SERVICE_ROLE_KEY:-}" ] || {
  echo "stack not running: scripts/stack.sh up" >&2
  exit 1
}
command -v psql >/dev/null || { echo "psql not found (brew install libpq)" >&2; exit 1; }

PROJECT_URL=${PROJECT_URL:-http://kong:8000}
# Values go in through stdin, not the command line.
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -o /dev/null -f - <<SQL
select vault.create_secret('$PROJECT_URL', 'project_url')
where not exists (select 1 from vault.secrets where name = 'project_url');
select vault.update_secret(id, '$PROJECT_URL') from vault.secrets where name = 'project_url';
select vault.create_secret('$SERVICE_ROLE_KEY', 'service_role_key')
where not exists (select 1 from vault.secrets where name = 'service_role_key');
select vault.update_secret(id, '$SERVICE_ROLE_KEY') from vault.secrets where name = 'service_role_key';
SQL
echo "Vault secrets set for ${DB_URL##*@} (project_url=$PROJECT_URL)"
