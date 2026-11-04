#!/bin/bash
# Local checks before a push, scoped to what the branch changed. Prints every
# command with its exit code and a final PREPUSH line; exits 1 if any failed.
#
# Usage: scripts/autonomy/prepush.sh [base]
#   base defaults to the open PR's base branch, else main. Changes are counted
#   from the merge base with origin/<base>, plus anything uncommitted.
#
# Generated-file checks match CI's (contracts:gen, core:gen, core:fn --check).
# Migrations need a running stack for pgTAP and database.types.ts, so they are
# listed as a NOTE with the command to run, not run here.
set -uo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"
export GH_TOKEN="${GH_TOKEN:-$(gh auth token --user rajgaur98 2>/dev/null)}"

BASE="${1:-$(gh pr view --json baseRefName --jq .baseRefName 2>/dev/null || true)}"
BASE="${BASE:-main}"
git fetch -q origin "$BASE" 2>/dev/null || true
MB=$(git merge-base HEAD "origin/$BASE")
CHANGED=$( { git diff --name-only "$MB"; git ls-files --others --exclude-standard; } | sort -u)
echo "PREPUSH base=$BASE merge-base=${MB:0:9} files=$(printf '%s\n' "$CHANGED" | grep -c .)"

FAILED=()
run() {
  echo "\$ $*"
  "$@" > /tmp/prepush.$$ 2>&1
  local rc=$?
  if [ $rc -ne 0 ]; then
    tail -40 /tmp/prepush.$$
    FAILED+=("$*")
  fi
  echo "  exit $rc"
  rm -f /tmp/prepush.$$
}
changed() { printf '%s\n' "$CHANGED" | grep -qE "$1"; }

if changed '\.(ts|tsx|js|mjs|cjs|json|jsonc|css|html)$|^biome\.json'; then
  run pnpm lint
fi
if changed '^(apps/web|apps/agent/src|packages)/|^pnpm-lock\.yaml$|^turbo\.json$|^tsconfig'; then
  run pnpm exec turbo run typecheck test --filter="...[$MB]"
fi
if changed '^packages/contracts/src/'; then
  run pnpm contracts:gen
  run git diff --exit-code packages/contracts/generated
fi
if changed '^packages/core/(src|vectors)/'; then
  run pnpm core:gen
  run git diff --exit-code supabase/tests/database/status_vectors.test.sql
  run pnpm core:fn --check
fi
if changed '\.rs$|Cargo\.(toml|lock)$|^rust-toolchain\.toml$|^packages/contracts/generated/'; then
  run cargo fmt --all --check
  run cargo clippy --workspace --all-targets --locked -- -D warnings
  run cargo test --workspace --locked
fi
if changed '^supabase/functions/' && command -v deno >/dev/null; then
  run deno check --node-modules-dir=none --no-lock supabase/functions/*/index.ts
fi
if changed '^scripts/autonomy/'; then
  run python3 -m unittest discover -s scripts/autonomy -p 'test_*.py'
fi
if changed '^supabase/(migrations|tests)/'; then
  if [ "$(basename "$ROOT")" = ai_proctor ]; then
    echo "NOTE migrations changed: pnpm db:reset && pnpm db:test && pnpm db:types (commit database.types.ts)"
  else
    echo "NOTE migrations changed: scripts/stack.sh reset && scripts/stack.sh test && scripts/stack.sh types (commit database.types.ts)"
  fi
fi

if [ ${#FAILED[@]} -eq 0 ]; then
  echo "PREPUSH ok"
else
  printf 'PREPUSH failed · %s\n' "$(IFS='; '; echo "${FAILED[*]}")"
  exit 1
fi
