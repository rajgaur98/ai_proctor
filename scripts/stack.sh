#!/bin/bash
# One local Supabase stack per git worktree (#118), so parallel work never resets
# someone else's database. The main checkout (folder `ai_proctor`) keeps the
# default ports and runs from supabase/ as usual; every other worktree gets its
# own project id and port block, from a config generated into .stack/ (ignored).
#
# Usage: scripts/stack.sh up|down|env|reset|test|dotenv|ports
#   up      start this worktree's stack (lean: no Studio, imgproxy, analytics)
#   down    stop it (data kept)
#   env     print API_URL, ANON_KEY, MAILPIT_URL, ... and WEB_PORT
#   reset   rebuild the database from this worktree's migrations + seed
#   test    run the pgTAP tests against it
#   dotenv  write apps/web/.env.local for this stack
#   ports   print the port block
#   run CMD run CMD with this stack's env exported (AI_PROCTOR_SUPABASE_URL,
#           AI_PROCTOR_SUPABASE_ANON_KEY, AI_PROCTOR_MAILPIT_URL, MAILPIT_URL,
#           WEB_PORT), e.g. `scripts/stack.sh run pnpm --filter @ai-proctor/web e2e`
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
NAME=$(basename "$ROOT")
cd "$ROOT"
export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:$PATH"

if [ "$NAME" = "ai_proctor" ]; then
  K=0
else
  K=$((1 + $(printf '%s' "$NAME" | cksum | cut -d' ' -f1) % 40))
fi
BASE=$((54320 + K * 20))
WEB_PORT=$(( K == 0 ? 5173 : 6200 + K ))
INSPECTOR=$((8083 + K))

if [ "$K" -eq 0 ]; then
  WORKDIR="$ROOT"
else
  WORKDIR="$ROOT/.stack"
  mkdir -p "$WORKDIR/supabase"
  # Copied on every call (the CLI won't follow links out of its project folder);
  # after editing an Edge Function, restart the stack's edge runtime.
  rsync -a --delete --exclude config.toml --exclude .temp --exclude .branches \
    "$ROOT/supabase/" "$WORKDIR/supabase/"
  # Same settings, own id and ports; invite links may also return to this
  # worktree's dashboard port.
  sed -E \
    -e "s/^project_id = .*/project_id = \"ai_proctor_w$K\"/" \
    -e "/^\[api\]/,/^\[/ s/^port = 54321/port = $((BASE + 1))/" \
    -e "s/^port = 54322/port = $((BASE + 2))/" \
    -e "s/^shadow_port = 54320/shadow_port = $BASE/" \
    -e "s/^port = 54329/port = $((BASE + 9))/" \
    -e "s/^port = 54323/port = $((BASE + 3))/" \
    -e "s/^port = 54324/port = $((BASE + 4))/" \
    -e "s/^port = 54327/port = $((BASE + 7))/" \
    -e "s/^inspector_port = 8083/inspector_port = $INSPECTOR/" \
    -e "s#\"http://localhost:5173/\*\*\"#\"http://localhost:5173/**\", \"http://localhost:$WEB_PORT\", \"http://localhost:$WEB_PORT/**\"#" \
    "$ROOT/supabase/config.toml" > "$WORKDIR/supabase/config.toml"
fi

sb() { pnpm --silent supabase --workdir "$WORKDIR" "$@"; }

case "${1:-}" in
  up)
    if [ "$K" -eq 0 ]; then
      sb start
    else
      sb start -x studio,imgproxy,vector,logflare,supavisor
    fi
    ;;
  down) sb stop ;;
  env)
    sb status -o env 2>/dev/null | grep -E '^[A-Z_]+='
    echo "WEB_PORT=$WEB_PORT"
    ;;
  reset) sb db reset ;;
  test) sb test db ;;
  dotenv)
    eval "$(sb status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY)=')"
    [ -n "${API_URL:-}" ] || { echo "stack not running: scripts/stack.sh up" >&2; exit 1; }
    printf 'VITE_SUPABASE_URL=%s\nVITE_SUPABASE_ANON_KEY=%s\n' "$API_URL" "$ANON_KEY" \
      > "$ROOT/apps/web/.env.local"
    echo "wrote apps/web/.env.local for $API_URL (dashboard port $WEB_PORT)"
    ;;
  run)
    shift
    eval "$(sb status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|MAILPIT_URL)=')"
    [ -n "${API_URL:-}" ] || { echo "stack not running: scripts/stack.sh up" >&2; exit 1; }
    export AI_PROCTOR_SUPABASE_URL="$API_URL" AI_PROCTOR_SUPABASE_ANON_KEY="$ANON_KEY"
    export AI_PROCTOR_MAILPIT_URL="$MAILPIT_URL" MAILPIT_URL WEB_PORT
    exec "$@"
    ;;
  ports)
    echo "worktree=$NAME block=$K api=$((BASE + 1)) db=$((BASE + 2)) mail=$((BASE + 4)) web=$WEB_PORT"
    ;;
  *)
    sed -n '2,18p' "$0"
    exit 2
    ;;
esac
