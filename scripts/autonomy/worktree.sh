#!/bin/bash
# One worktree per issue, next to the main checkout (../ai_proctor-<issue>).
#
# Usage: scripts/autonomy/worktree.sh up <issue> [base] [--stack]
#        scripts/autonomy/worktree.sh down <issue> [--force]
#   up    branch <issue>-<slug of the issue title> off origin/<base> (default
#         main; a stacked issue names the branch below it), pnpm install, board
#         card to "progress". --stack also starts the worktree's own Supabase
#         stack (scripts/stack.sh up) and writes apps/web/.env.local.
#         An existing branch for the issue (local or on origin) is reused.
#   down  stops the worktree's stack, removes the worktree, deletes the local
#         branch if it is merged. Refuses a dirty worktree unless --force.
set -euo pipefail

MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
HERE=$(cd "$(dirname "$0")" && pwd)
export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:$PATH"
export GH_TOKEN="${GH_TOKEN:-$(gh auth token --user rajgaur98)}"

CMD="${1:-}"; N="${2:-}"
[[ "$CMD" =~ ^(up|down)$ && "$N" =~ ^[0-9]+$ ]] || { sed -n '2,12p' "$0" >&2; exit 2; }
WT="$(dirname "$MAIN")/ai_proctor-$N"
shift 2

if [ "$CMD" = up ]; then
  BASE=main; STACK=0
  for a in "$@"; do
    if [ "$a" = --stack ]; then STACK=1; else BASE="$a"; fi
  done
  if [ -d "$WT" ]; then
    echo "WORKTREE exists · $WT · branch $(git -C "$WT" branch --show-current)"
    exit 0
  fi
  git -C "$MAIN" fetch -q origin
  BRANCH=$(git -C "$MAIN" for-each-ref --format='%(refname:lstrip=-1)' \
    "refs/heads/$N-*" "refs/remotes/origin/$N-*" | head -1)
  if [ -n "$BRANCH" ]; then
    if git -C "$MAIN" show-ref -q "refs/heads/$BRANCH"; then
      git -C "$MAIN" worktree add -q "$WT" "$BRANCH"
    else
      git -C "$MAIN" worktree add -q --track -b "$BRANCH" "$WT" "origin/$BRANCH"
    fi
  else
    TITLE=$(gh issue view "$N" --repo rajgaur98/ai_proctor --json title --jq .title)
    SLUG=$(printf '%s' "$TITLE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g' | cut -c1-40 | sed -E 's/-$//')
    BRANCH="$N-$SLUG"
    git -C "$MAIN" worktree add -q -b "$BRANCH" "$WT" "origin/$BASE"
  fi
  (cd "$WT" && pnpm install --frozen-lockfile --silent)
  if [ "$STACK" = 1 ]; then
    (cd "$WT" && scripts/stack.sh up >/dev/null && scripts/stack.sh dotenv >/dev/null)
    echo "STACK up · $(cd "$WT" && scripts/stack.sh ports | head -1)"
  fi
  "$HERE/board.sh" "$N" progress >/dev/null && echo "BOARD #$N progress"
  echo "WORKTREE up · $WT · branch $BRANCH · base $BASE"
else
  FORCE=0; [ "${1:-}" = --force ] && FORCE=1
  [ -d "$WT" ] || { echo "WORKTREE none · $WT"; exit 0; }
  if [ "$FORCE" = 0 ] && [ -n "$(git -C "$WT" status --porcelain)" ]; then
    echo "WORKTREE dirty · $WT · commit or pass --force"; exit 1
  fi
  BRANCH=$(git -C "$WT" branch --show-current)
  if [ -f "$WT/.stack/block" ]; then
    (cd "$WT" && scripts/stack.sh down >/dev/null 2>&1) && echo "STACK down"
  fi
  if [ "$FORCE" = 1 ]; then
    git -C "$MAIN" worktree remove --force "$WT"
  else
    git -C "$MAIN" worktree remove "$WT"
  fi
  git -C "$MAIN" fetch -q origin main
  if git -C "$MAIN" merge-base --is-ancestor "$BRANCH" origin/main 2>/dev/null; then
    git -C "$MAIN" branch -q -D "$BRANCH" && echo "BRANCH $BRANCH deleted (merged)"
  else
    echo "BRANCH $BRANCH kept (not merged into main)"
  fi
  echo "WORKTREE down · $WT"
fi
