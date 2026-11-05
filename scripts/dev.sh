#!/bin/bash
# The everyday local commands, with their flags and env built in (#347), for the
# main checkout and worktrees alike (each through its own stack, scripts/stack.sh).
#
# Usage: scripts/dev.sh <command>
#   update       main checkout only: pull main, install, migrate, then app
#   migrate      apply new migrations keeping the data, set the Vault secrets, and
#                restart the stack so new and changed Edge Functions are served
#   reset        rebuild the database from migrations + seed, set the Vault secrets
#   dash         run the dashboard on this checkout's port (writes .env.local first)
#   app-build    build the debug .app: signed with "AI Proctor Dev" when this Mac
#                has it (#108), this stack's URL and anon key compiled in (the
#                watchdog's copy of the agent never sees `open --env` values)
#   app          app-build, then app-restart
#   app-restart  restart the .app through its watchdog, or start it if none runs.
#                Dev knobs, e.g. `CHECKIN_S=30 PERMISSIONS=1 scripts/dev.sh app-restart`,
#                start it without the watchdog so the knobs reach it
#   app-it       agent <-> local Supabase integration tests (they expect the seeded
#                state: after manual use, e.g. Erin left clocked in, `reset` first)
#   logs         follow the agent's newest log
#   sign-check   print the .app's designated requirement (stable = certificate leaf)
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"

STACK="$ROOT/scripts/stack.sh"
APP="$ROOT/target/debug/bundle/macos/AI Proctor.app"
LABEL=com.aiproctor.agent
JOB="gui/$(id -u)/$LABEL"

# This checkout's stack env (API_URL, ANON_KEY, WEB_PORT, ...); fails when it's down.
stack_env() {
  eval "$("$STACK" env | grep -E '^(API_URL|ANON_KEY|WEB_PORT)=')"
  [ -n "${API_URL:-}" ] || { echo "stack not running: scripts/stack.sh up" >&2; exit 1; }
}

secrets() { STACK_SH="$STACK" bash "$ROOT/scripts/stack-secrets.sh"; }

migrate() {
  "$STACK" down
  "$STACK" up >/dev/null
  "$STACK" migrate
  secrets
}

app_build() {
  stack_env
  if [ -z "${APPLE_SIGNING_IDENTITY:-}" ] &&
    security find-identity -v -p codesigning 2>/dev/null | grep -q '"AI Proctor Dev"'; then
    export APPLE_SIGNING_IDENTITY="AI Proctor Dev"
  fi
  if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
    echo "warning: no \"AI Proctor Dev\" signing identity: the .app is ad hoc signed and" \
      "loses its macOS grants and sign-in on every rebuild (#108)" >&2
  fi
  AI_PROCTOR_SUPABASE_URL="$API_URL" AI_PROCTOR_SUPABASE_ANON_KEY="$ANON_KEY" \
    pnpm --filter @ai-proctor/agent tauri build --debug
}

app_restart() {
  [ -d "$APP" ] || { echo "no app at $APP: scripts/dev.sh app-build" >&2; exit 1; }
  local knobs=()
  [ -n "${CHECKIN_S:-}" ] && knobs+=(--env "AI_PROCTOR_DEV_CHECKIN_S=$CHECKIN_S")
  [ "${PERMISSIONS:-}" = 1 ] && knobs+=(--env AI_PROCTOR_DEV_REQUEST_PERMISSIONS=1)
  if [ ${#knobs[@]} -gt 0 ]; then
    # The watchdog's copy wouldn't get the knobs: stop it, and start this one
    # without it (AI_PROCTOR_WATCHDOG=off removes the job; a later plain
    # app-restart puts it back).
    launchctl bootout "$JOB" 2>/dev/null || true
    pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true
    sleep 1
    open -n "$APP" --env AI_PROCTOR_WATCHDOG=off "${knobs[@]}"
    echo "started without the watchdog: ${knobs[*]}"
  elif launchctl print "$JOB" >/dev/null 2>&1; then
    launchctl kickstart -k "$JOB"
    echo "restarted through the watchdog ($LABEL)"
  else
    pkill -f "$APP/Contents/MacOS/" 2>/dev/null || true
    sleep 1
    open -n "$APP"
    echo "started (it installs its watchdog and hands over to it)"
  fi
}

case "${1:-}" in
  update)
    [ "$(basename "$ROOT")" = ai_proctor ] && [ "$(git branch --show-current)" = main ] || {
      echo "update runs in the main checkout on main" >&2
      exit 1
    }
    git pull --ff-only
    pnpm install --frozen-lockfile
    migrate
    app_build
    app_restart
    echo "done. The dashboard hot-reloads; restart scripts/dev.sh dash if dependencies changed."
    ;;
  migrate) migrate ;;
  reset)
    "$STACK" reset
    secrets
    ;;
  dash)
    stack_env
    [ -f apps/web/.env.local ] && grep -q "$API_URL" apps/web/.env.local || "$STACK" dotenv
    exec pnpm --filter @ai-proctor/web dev --port "$WEB_PORT" --strictPort
    ;;
  app-build) app_build ;;
  app)
    app_build
    app_restart
    ;;
  app-restart) app_restart ;;
  app-it)
    exec "$STACK" run bash -c 'cargo test -p agent-core --test sync_supabase --test auth_supabase &&
      cargo test -p ai-proctor-agent --test sign_in_supabase'
    ;;
  # The newest file: the log rolls over at UTC midnight, not local midnight.
  logs) exec tail -f "$(ls -t "$HOME"/Library/Logs/com.aiproctor.agent/agent.*.log | head -1)" ;;
  sign-check) codesign -d -r- "$APP" 2>&1 | grep designated ;;
  *)
    sed -n '2,21p' "$0"
    exit 2
    ;;
esac
