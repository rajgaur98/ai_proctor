#!/usr/bin/env python3
"""Claude Code Stop hook: in autonomous mode, don't let a session end while
unblocked milestone work remains (docs/progress.md, "Now / Next").

Mode is a local, untracked switch: `.claude/autonomy/mode` containing `on`.
Anything else (or no file) means off, and the hook does nothing.

When on, it lists the open sub-issues of the milestone epics (#1-#7) that are not
labelled `blocked`. If any remain, it blocks the stop and tells the session what's
next. It lets the session stop when:
  * nothing unblocked remains;
  * GitHub can't be reached (fail open, never trap a session);
  * it has blocked 8 times in a row with no new commit on any branch (the session
    is stuck; better to stop and be woken by the scheduled check).
"""

import json
import os
import subprocess
import sys
import time

REPO = "rajgaur98/ai_proctor"
EPICS = [1, 2, 3, 4, 5, 6, 7]
MAX_IDLE_BLOCKS = 8

root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
state_dir = os.path.join(root, ".claude", "autonomy")
mode_file = os.path.join(state_dir, "mode")
state_file = os.path.join(state_dir, "stop_guard.json")


def allow():
    sys.exit(0)


def run(*args):
    env = dict(os.environ)
    token = subprocess.run(
        ["gh", "auth", "token", "--user", "rajgaur98"], capture_output=True, text=True
    ).stdout.strip()
    if token:
        env["GH_TOKEN"] = token
    return subprocess.run(args, capture_output=True, text=True, env=env, timeout=30, cwd=root)


try:
    with open(mode_file) as f:
        if f.read().strip() != "on":
            allow()
except OSError:
    allow()

try:
    sys.stdin.read()  # hook input; not needed
except Exception:
    pass

# Open, unblocked milestone issues.
remaining = []
try:
    for epic in EPICS:
        out = run("gh", "api", f"repos/{REPO}/issues/{epic}/sub_issues?per_page=100")
        if out.returncode != 0:
            allow()
        for issue in json.loads(out.stdout):
            labels = {l["name"] for l in issue.get("labels", [])}
            if issue["state"] == "open" and "blocked" not in labels:
                remaining.append((issue["number"], issue["title"]))
except Exception:
    allow()

if not remaining:
    allow()

# Stuck detection: newest commit time on any local branch.
head = run("git", "for-each-ref", "--sort=-committerdate", "--count=1",
           "--format=%(committerdate:unix)", "refs/heads").stdout.strip()
try:
    with open(state_file) as f:
        state = json.load(f)
except (OSError, ValueError):
    state = {}
blocks = state.get("blocks", 0) + 1 if state.get("head") == head else 1
if blocks > MAX_IDLE_BLOCKS:
    os.makedirs(state_dir, exist_ok=True)
    with open(state_file, "w") as f:
        json.dump({"head": head, "blocks": 0, "gave_up_at": time.time()}, f)
    allow()
os.makedirs(state_dir, exist_ok=True)
with open(state_file, "w") as f:
    json.dump({"head": head, "blocks": blocks}, f)

remaining.sort()
listed = "; ".join(f"#{n} {t}" for n, t in remaining[:5])
reason = (
    f"Autonomous mode is on and {len(remaining)} unblocked milestone issues are open "
    f"(next by number: {listed}). Don't stop: read the 'Now / Next' block in "
    "docs/progress.md on origin/main and continue with the next issue in milestone "
    "order. If something truly needs Raj, write the question under 'Blocked on Raj' "
    "in docs/progress.md, label the issue `blocked`, and move on. To end the run, "
    "Raj (or you, when everything is done) writes `off` to .claude/autonomy/mode."
)
print(json.dumps({"decision": "block", "reason": reason}))
