#!/usr/bin/env python3
"""What the autonomous run does next: one line per open milestone issue (and per
open PR that belongs to none), read from GitHub.

    scripts/autonomy/next.py               # summary line, then one line per item
    scripts/autonomy/next.py --json        # the rows as JSON
    scripts/autonomy/next.py --wake-check  # one WAKE line for the wake-up task

States (lib.ACTIONABLE keeps the owner working; lib.WAITING lets it stop):
  needs-work, pr-failing, pr-conflict, behind-main, ready-to-merge
  pr-in-ci, waiting-on-base
  blocked

Exit codes: 0 ok, 2 GitHub couldn't be read.
"""

import json
import sys
import time

import lib


def summary(rows):
    act = sum(r["state"] in lib.ACTIONABLE for r in rows)
    wait = sum(r["state"] in lib.WAITING for r in rows)
    blocked = sum(r["state"] == "blocked" for r in rows)
    return act, wait, blocked


def line(r):
    who = f"#{r['issue']}" if r.get("issue") else f"PR #{r['pr']}"
    pr = f" · PR #{r['pr']}" if r.get("issue") and r.get("pr") else ""
    return f"{who} {r['state']}{pr} · {r['next']} · {r['title']}"


def wake_check(rows, now=None):
    """WAKE yes|no line. The session reading it checks the owner with the app's
    session list (isRunning) before acting: this script can't see sessions."""
    now = now or time.time()
    if not lib.mode_on():
        return "WAKE no · mode off"
    owner = lib.read_owner()
    act, wait, _ = summary(rows)
    if lib.owner_live(owner, now):
        age = int((now - owner["heartbeat_at"]) / 60)
        return f"WAKE no · owner {owner['session_id']} live (heartbeat {age} min ago)"
    if not act:
        return f"WAKE no · nothing actionable ({wait} waiting)"
    stuck = owner.get("stuck") or {}
    if stuck.get("fingerprint") == lib.fingerprint(rows) and now - stuck.get("at", 0) < 3600:
        return "WAKE no · owner gave up on this exact state less than an hour ago"
    first = next(r for r in rows if r["state"] in lib.ACTIONABLE)
    return f"WAKE yes · owner={owner.get('session_id') or 'none'} · {act} actionable · first: {line(first)}"


def main(argv):
    try:
        rows = lib.collect()
    except (lib.GitHubError, OSError, ValueError) as e:
        print(f"NEXT error · {e}")
        return 2
    if "--json" in argv:
        print(json.dumps(rows, indent=2))
    elif "--wake-check" in argv:
        print(wake_check(rows))
    else:
        act, wait, blocked = summary(rows)
        print(f"NEXT actionable={act} waiting={wait} blocked={blocked}")
        order = {s: i for i, s in enumerate(
            ["ready-to-merge", "pr-failing", "pr-conflict", "behind-main", "needs-work",
             "pr-in-ci", "waiting-on-base", "blocked"])}
        for r in sorted(rows, key=lambda r: (order[r["state"]], r.get("issue") or 10**6)):
            print(line(r))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
