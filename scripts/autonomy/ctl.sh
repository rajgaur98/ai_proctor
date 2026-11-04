#!/bin/bash
# The autonomous-run switch. State lives in the main checkout's .claude/autonomy/
# (untracked), whichever worktree this runs from.
#
# Usage: scripts/autonomy/ctl.sh on|off|claim|status
#   on      mode on; the session that runs this becomes the owner (heartbeat.py
#           sees the command and records the session id)
#   claim   take over as owner (the wake-up does this when the owner is gone)
#   off     mode off, owner cleared
#   status  mode, owner and heartbeat age
set -euo pipefail

COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
DIR="${AI_PROCTOR_AUTONOMY_DIR:-$(dirname "$COMMON")/.claude/autonomy}"
mkdir -p "$DIR"

case "${1:-status}" in
  on)
    echo on > "$DIR/mode"
    echo '{"session_id": "pending"}' > "$DIR/owner.json"
    echo "AUTONOMY on · this session becomes the owner when this command returns"
    echo "ACTION: enable the scheduled task \"ai-proctor-wake\" and request keep-awake"
    ;;
  claim)
    [ "$(cat "$DIR/mode" 2>/dev/null)" = on ] || { echo "AUTONOMY off · nothing to claim"; exit 1; }
    echo '{"session_id": "pending"}' > "$DIR/owner.json"
    echo "AUTONOMY claimed · this session is the owner when this command returns"
    ;;
  off)
    echo off > "$DIR/mode"
    rm -f "$DIR/owner.json" "$DIR/stop_guard.json"
    echo "AUTONOMY off"
    echo "ACTION: disable the scheduled task \"ai-proctor-wake\""
    ;;
  status)
    python3 - "$DIR" <<'EOF'
import json, sys, time
d = sys.argv[1]
try:
    mode = open(f"{d}/mode").read().strip()
except OSError:
    mode = "off"
try:
    o = json.load(open(f"{d}/owner.json"))
except (OSError, ValueError):
    o = {}
hb = o.get("heartbeat_at")
age = f"{int((time.time() - hb) / 60)} min ago" if hb else "never"
print(f"AUTONOMY {mode} · owner {o.get('session_id', 'none')} · heartbeat {age} · calls {o.get('calls', 0)}"
      + (" · stuck" if o.get("stuck") else ""))
EOF
    ;;
  *) echo "usage: $0 on|off|claim|status" >&2; exit 2 ;;
esac
