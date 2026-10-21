#!/usr/bin/env bash
# Builds the debug bundle and drives it end to end against the local Supabase
# stack (`pnpm db:start`): launch, sign in, clock in, check-in card, server row.
# Needs the toolchain PATH from CLAUDE.md. See apps/agent/src-tauri/tests/e2e_bundle.rs.
set -euo pipefail
cd "$(dirname "$0")/.."

# Sign with the stable self-signed identity when this Mac has it (#108), so a
# rebuilt bundle keeps its macOS privacy grants and keychain access. Without it
# (CI, other machines) Tauri signs ad hoc as before.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]] &&
  security find-identity -v -p codesigning 2>/dev/null | grep -q '"AI Proctor Dev"'; then
  export APPLE_SIGNING_IDENTITY="AI Proctor Dev"
fi

pnpm --filter @ai-proctor/agent tauri build --debug

stack=$(pnpm --silent supabase status -o env)
eval "$(grep -E '^(API_URL|ANON_KEY|MAILPIT_URL)=' <<<"$stack")"
AI_PROCTOR_SUPABASE_URL=$API_URL \
AI_PROCTOR_SUPABASE_ANON_KEY=$ANON_KEY \
AI_PROCTOR_MAILPIT_URL=$MAILPIT_URL \
  cargo test -p ai-proctor-agent --test e2e_bundle -- --ignored --nocapture
