#!/usr/bin/env python3
"""PreToolUse/PostToolUse hook: keeps the autonomous run's owner file current.

While autonomous mode is on:
  * the session that runs `scripts/autonomy/ctl.sh on` or `ctl.sh claim` becomes
    the owner (the hook sees the command and the session id; a shell can't);
  * every tool call by the owner refreshes `heartbeat_at` and counts toward
    `calls`, which the Stop hook uses to tell a working session from a stuck one.

Never blocks a tool call and never fails one: any error exits 0.
"""

import json
import re
import sys
import time

try:
    import lib

    if lib.mode_on():
        hook = json.load(sys.stdin)
        sid = hook.get("session_id")
        now = time.time()
        owner = lib.read_owner()
        cmd = (hook.get("tool_input") or {}).get("command") or ""
        claiming = (
            hook.get("hook_event_name") == "PostToolUse"
            and hook.get("tool_name") == "Bash"
            and re.search(r"scripts/autonomy/ctl\.sh\s+(on|claim)\b", cmd)
        )
        if sid and claiming:
            lib.write_owner({"session_id": sid, "claimed_at": now, "heartbeat_at": now,
                             "calls": 0})
        elif sid and owner.get("session_id") == sid:
            owner["heartbeat_at"] = now
            owner["calls"] = owner.get("calls", 0) + 1
            lib.write_owner(owner)
except Exception:
    pass
sys.exit(0)
