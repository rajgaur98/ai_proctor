#!/bin/bash
# Moves an issue's card on the "AI Proctor" project board (adds it if missing).
# Usage: scripts/autonomy/board.sh <issue-number> backlog|ready|progress|review|done
set -euo pipefail
export GH_TOKEN="${GH_TOKEN:-$(gh auth token --user rajgaur98)}"
P=PVT_kwHOAx2_sM4Bnnh_
F=PVTSSF_lAHOAx2_sM4Bnnh_zhmLRr8
case "$2" in
  backlog) O=f75ad846 ;; ready) O=47fc9ee4 ;; progress) O=98236657 ;;
  review) O=0603351b ;; done) O=57bc148f ;; *) echo "unknown status $2" >&2; exit 2 ;;
esac
ITEM=$(gh project item-list 1 --owner rajgaur98 --limit 300 --format json \
  --jq ".items[] | select(.content.number == $1) | .id")
if [ -z "$ITEM" ]; then
  ITEM=$(gh project item-add 1 --owner rajgaur98 \
    --url "https://github.com/rajgaur98/ai_proctor/issues/$1" --format json --jq .id)
fi
gh project item-edit --id "$ITEM" --project-id "$P" --field-id "$F" --single-select-option-id "$O" >/dev/null
echo "#$1 -> $2"
