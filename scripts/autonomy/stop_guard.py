#!/usr/bin/env python3
"""Claude Code Stop hook: keep the autonomous run's owner working while there is
something it can act on (scripts/autonomy/next.py).

Mode is the local switch `.claude/autonomy/mode` in the main checkout, set with
`scripts/autonomy/ctl.sh on|off`. The owner is the session that ran `ctl.sh on`
or `ctl.sh claim` (heartbeat.py records it).

It blocks the stop only when all of these hold:
  * mode is on and this session is the owner (other sessions stop freely);
  * some issue or PR is actionable: needs-work, pr-failing, pr-conflict,
    behind-main or ready-to-merge. Waiting on CI or on a stacked base is not:
    the session stops and the 15-minute wake-up looks again;
  * the session isn't stuck: after MAX_IDLE_BLOCKS blocks in a row with fewer
    than MIN_CALLS tool calls between them and no change on GitHub, it lets
    the stop through and records the state as stuck, so the wake-up leaves that
    exact state alone for an hour.
GitHub unreachable or any error: lets the stop through (never traps a session).
"""

import json
import sys
import time

import lib

MAX_IDLE_BLOCKS = 4
MIN_CALLS = 3


def allow():
    sys.exit(0)


def decide(owner, sid, rows, now):
    """Returns (block_reason or None, updated owner)."""
    if owner.get("session_id") != sid:
        return None, owner
    actionable = [r for r in rows if r["state"] in lib.ACTIONABLE]
    if not actionable:
        owner.pop("guard", None)
        return None, owner
    fp = lib.fingerprint(rows)
    guard = owner.get("guard") or {}
    calls = owner.get("calls", 0)
    idle = guard.get("fingerprint") == fp and calls - guard.get("calls", 0) < MIN_CALLS
    blocks = guard.get("blocks", 0) + 1 if idle else 1
    if blocks > MAX_IDLE_BLOCKS:
        owner.pop("guard", None)
        owner["stuck"] = {"fingerprint": fp, "at": now}
        return None, owner
    owner["guard"] = {"fingerprint": fp, "calls": calls, "blocks": blocks}
    import next as nxt

    listed = "\n".join(f"- {nxt.line(r)}" for r in actionable[:6])
    reason = (
        f"Autonomous mode is on and {len(actionable)} items are actionable:\n{listed}\n"
        "Don't stop: take the first one (`scripts/autonomy/next.py` has the full list). "
        "If one truly needs Raj, write the question under 'Blocked on Raj' in "
        "docs/progress.md, label the issue `blocked`, and move on. Waiting on CI is not "
        "a reason to keep going: once only waiting items are left this hook lets you stop "
        "and the wake-up resumes the run. To end the run: `scripts/autonomy/ctl.sh off`."
    )
    return reason, owner


def main():
    if not lib.mode_on():
        allow()
    try:
        sid = json.load(sys.stdin).get("session_id")
    except Exception:
        allow()
    owner = lib.read_owner()
    if owner.get("session_id") != sid:
        allow()
    try:
        rows = lib.collect()
    except Exception:
        allow()
    reason, owner = decide(owner, sid, rows, time.time())
    lib.write_owner(owner)
    if reason:
        print(json.dumps({"decision": "block", "reason": reason}))
    allow()


if __name__ == "__main__":
    main()
