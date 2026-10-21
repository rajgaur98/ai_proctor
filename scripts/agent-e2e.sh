#!/usr/bin/env bash
# Builds the debug bundle and drives it end to end against this checkout's local
# Supabase stack (`pnpm db:start` in the main checkout, `scripts/stack.sh up` in a
# worktree): launch, sign in, clock in, check-in card, server row.
# Needs the toolchain PATH from CLAUDE.md. See apps/agent/src-tauri/tests/e2e_bundle.rs.
#
# AI_PROCTOR_E2E_LAUNCH picks how the app starts (#227):
#   bundle (default)  through LaunchServices (`open -n`), so the bundle's own Screen
#                     Recording and Camera grants apply, and the check-in's captures
#                     must reach Storage. Grant both to the bundle once first (#226).
#   direct            the binary started from the test, with the shell's permissions;
#                     no capture checks. For Macs where nothing has been granted.
set -euo pipefail
cd "$(dirname "$0")/.."

export AI_PROCTOR_E2E_LAUNCH="${AI_PROCTOR_E2E_LAUNCH:-bundle}"
case "$AI_PROCTOR_E2E_LAUNCH" in
  bundle | direct) ;;
  *)
    echo "AI_PROCTOR_E2E_LAUNCH=$AI_PROCTOR_E2E_LAUNCH: expected bundle or direct" >&2
    exit 2
    ;;
esac

# Sign with the stable self-signed identity when this Mac has it (#108), so a
# rebuilt bundle keeps its macOS privacy grants and keychain access. Without it
# (CI, other machines) Tauri signs ad hoc as before.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]] &&
  security find-identity -v -p codesigning 2>/dev/null | grep -q '"AI Proctor Dev"'; then
  export APPLE_SIGNING_IDENTITY="AI Proctor Dev"
fi
if [[ "$AI_PROCTOR_E2E_LAUNCH" == bundle && -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "warning: no \"AI Proctor Dev\" signing identity, so the bundle is ad hoc signed and" \
    "loses its grants on every rebuild (#108). AI_PROCTOR_E2E_LAUNCH=direct skips captures." >&2
fi

pnpm --filter @ai-proctor/agent tauri build --debug

# This checkout's stack: the default ports in the main checkout, the worktree's own
# port block anywhere else (#118).
stack=$(bash scripts/stack.sh env || true)
eval "$(grep -E '^(API_URL|ANON_KEY|MAILPIT_URL|SERVICE_ROLE_KEY)=' <<<"$stack" || true)"
if [[ -z "${API_URL:-}" ]]; then
  echo "local stack not running: pnpm db:start (main checkout) or scripts/stack.sh up" >&2
  exit 1
fi
AI_PROCTOR_SUPABASE_URL=$API_URL \
AI_PROCTOR_SUPABASE_ANON_KEY=$ANON_KEY \
AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY \
AI_PROCTOR_MAILPIT_URL=$MAILPIT_URL \
  cargo test -p ai-proctor-agent --test e2e_bundle -- --ignored --nocapture
