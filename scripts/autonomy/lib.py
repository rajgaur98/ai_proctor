"""Shared helpers for the autonomy scripts: GitHub reads, the mode switch, the
owner file, and the per-issue state rules that next.py, gate.py and the Stop
hook all agree on.

Everything that decides a state is a pure function over plain dicts, so the
tests in test_autonomy.py run without GitHub.
"""

import json
import os
import re
import subprocess
import time

REPO = "rajgaur98/ai_proctor"
EPICS = [1, 2, 3, 4, 5, 6, 7]
REQUIRED_CHECK = "CI OK"
# A session whose heartbeat is newer than this is live. A foreground command
# can run 10 minutes without a tool call finishing, so it has to be longer.
LIVE_S = 12 * 60

ROOT = os.environ.get("CLAUDE_PROJECT_DIR") or subprocess.run(
    ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
).stdout.strip() or os.getcwd()


def _main_checkout():
    """The main checkout's folder, from any worktree: the switch and the owner
    file live there, so every worktree and session sees one autonomous run."""
    common = subprocess.run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        capture_output=True, text=True, cwd=ROOT,
    ).stdout.strip()
    return os.path.dirname(common) if common else ROOT


STATE_DIR = os.environ.get("AI_PROCTOR_AUTONOMY_DIR") or os.path.join(
    _main_checkout(), ".claude", "autonomy")
MODE_FILE = os.path.join(STATE_DIR, "mode")
OWNER_FILE = os.path.join(STATE_DIR, "owner.json")

# What a state asks of the run. Actionable states keep the owner working;
# waiting states let it stop until the wake-up looks again.
ACTIONABLE = {"needs-work", "pr-failing", "pr-conflict", "behind-main", "ready-to-merge"}
WAITING = {"pr-in-ci", "waiting-on-base"}


class GitHubError(Exception):
    pass


def _token():
    if os.environ.get("GH_TOKEN"):
        return os.environ["GH_TOKEN"]
    tok = subprocess.run(
        ["gh", "auth", "token", "--user", "rajgaur98"], capture_output=True, text=True
    ).stdout.strip()
    if tok:
        os.environ["GH_TOKEN"] = tok
    return tok


def gh(*args, timeout=30):
    """Run `gh` as rajgaur98 and return parsed JSON (or None for empty output)."""
    _token()
    out = subprocess.run(
        ["gh", *args], capture_output=True, text=True, timeout=timeout, cwd=ROOT
    )
    if out.returncode != 0:
        raise GitHubError(f"gh {' '.join(args[:3])}: {out.stderr.strip()[:200]}")
    return json.loads(out.stdout) if out.stdout.strip() else None


# ---------------------------------------------------------------- mode/owner


def mode_on():
    try:
        with open(MODE_FILE) as f:
            return f.read().strip() == "on"
    except OSError:
        return False


def read_owner():
    try:
        with open(OWNER_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_owner(owner):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = OWNER_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(owner, f)
    os.replace(tmp, OWNER_FILE)


def owner_live(owner, now=None):
    now = now or time.time()
    sid = owner.get("session_id")
    return bool(sid) and sid != "pending" and now - owner.get("heartbeat_at", 0) < LIVE_S


# ---------------------------------------------------------------- GitHub reads

PR_FIELDS = (
    "number,title,state,headRefName,headRefOid,baseRefName,body,isDraft,"
    "mergeable,statusCheckRollup"
)


def open_issues(epics=EPICS):
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(len(epics)) as pool:
        pages = list(pool.map(
            lambda e: (e, gh("api", f"repos/{REPO}/issues/{e}/sub_issues?per_page=100") or []),
            epics))
    issues = []
    for epic, page in pages:
        for it in page:
            if it["state"] != "open":
                continue
            issues.append({
                "number": it["number"],
                "title": it["title"],
                "labels": [l["name"] for l in it.get("labels", [])],
                "epic": epic,
            })
    return sorted(issues, key=lambda i: i["number"])


def open_prs():
    return gh("pr", "list", "--repo", REPO, "--state", "open", "--limit", "100",
              "--json", PR_FIELDS) or []


def pr(number):
    return gh("pr", "view", str(number), "--repo", REPO, "--json", PR_FIELDS)


def behind_by(base, head_sha):
    """Commits on `base` that the PR head doesn't contain."""
    cmp = gh("api", f"repos/{REPO}/compare/{head_sha}...{base}", "--jq",
             "{behind: .ahead_by}")
    return cmp["behind"]


def remote_branches():
    _token()
    out = subprocess.run(
        ["gh", "api", f"repos/{REPO}/branches?per_page=100", "--paginate", "--jq", ".[].name"],
        capture_output=True, text=True, timeout=30, cwd=ROOT,
    )
    if out.returncode != 0:
        raise GitHubError(f"gh api branches: {out.stderr.strip()[:200]}")
    return out.stdout.split()


# ---------------------------------------------------------------- pure rules

CLOSES = re.compile(r"(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b")


def issue_numbers_of(pr_):
    """Issues a PR is for: `Closes #n` in the body, else the branch's `<n>-` prefix."""
    nums = {int(n) for n in CLOSES.findall(pr_.get("body") or "")}
    m = re.match(r"(\d+)-", pr_.get("headRefName", ""))
    if m:
        nums.add(int(m.group(1)))
    return nums


def ci_state(pr_):
    """success | failure | pending | missing, from the PR head's check rollup.

    A failed job counts at once, before `CI OK` (which waits for every job)
    reports it, so the owner can start fixing early.
    """
    rollup = pr_.get("statusCheckRollup") or []
    for c in rollup:
        concl = (c.get("conclusion") or c.get("state") or "").upper()
        if concl in ("FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "ACTION_REQUIRED"):
            return "failure"
    for c in rollup:
        if (c.get("name") or c.get("context")) == REQUIRED_CHECK:
            if (c.get("conclusion") or "").upper() == "SUCCESS":
                return "success"
            return "pending"
    return "missing" if not rollup else "pending"


def pr_state(pr_, open_heads, behind):
    """State of one open PR.

    open_heads: head branch names of all open PRs (a stacked PR waits while its
    base is one of them). behind: commits on main the head lacks (None if the PR
    isn't based on main or it wasn't read).
    """
    if pr_.get("isDraft"):
        return "needs-work"
    ci = ci_state(pr_)
    if ci == "failure":
        return "pr-failing"
    if pr_.get("mergeable") == "CONFLICTING":
        return "pr-conflict"
    if ci in ("pending", "missing"):
        return "pr-in-ci"
    if pr_["baseRefName"] != "main":
        return "waiting-on-base" if pr_["baseRefName"] in open_heads else "needs-work"
    if behind:
        return "behind-main"
    return "ready-to-merge"


NEXT_ACTION = {
    "needs-work": "build it",
    "pr-failing": "fix the failing checks",
    "pr-conflict": "merge the base in and resolve conflicts",
    "behind-main": "merge main into the branch, rerun checks, push",
    "ready-to-merge": "scripts/autonomy/merge.py {pr}",
    "pr-in-ci": "wait for CI",
    "waiting-on-base": "wait for #{base_pr} to merge",
    "blocked": "skip (Blocked on Raj)",
}


def rows(issues, prs, behind_of, branches=()):
    """One row per open issue, plus one per open PR that belongs to no listed issue.

    behind_of(pr) -> int|None is called only for PRs based on main with green CI.
    """
    heads = {p["headRefName"]: p for p in prs}
    by_issue = {}
    for p in prs:
        for n in issue_numbers_of(p):
            by_issue.setdefault(n, []).append(p)
    out = []
    seen_prs = set()

    def pr_row(p, issue=None):
        seen_prs.add(p["number"])
        behind = None
        if (not p.get("isDraft") and p["baseRefName"] == "main"
                and ci_state(p) == "success" and p.get("mergeable") != "CONFLICTING"):
            behind = behind_of(p)
        st = pr_state(p, heads.keys(), behind)
        base_pr = heads.get(p["baseRefName"], {}).get("number")
        return {
            "issue": issue["number"] if issue else None,
            "title": issue["title"] if issue else p["title"],
            "state": st,
            "pr": p["number"],
            "base": p["baseRefName"],
            "base_pr": base_pr,
            "behind": behind,
            "next": NEXT_ACTION[st].format(pr=p["number"], base_pr=base_pr),
        }

    for it in issues:
        n = it["number"]
        if "blocked" in it["labels"]:
            out.append({"issue": n, "title": it["title"], "state": "blocked", "pr": None,
                        "next": NEXT_ACTION["blocked"]})
            continue
        linked = sorted(by_issue.get(n, []), key=lambda p: p["number"])
        if not linked:
            branch = next((b for b in branches if b.startswith(f"{n}-")), None)
            out.append({"issue": n, "title": it["title"], "state": "needs-work", "pr": None,
                        "branch": branch,
                        "next": f"continue on {branch}" if branch else "build it"})
            continue
        out.extend(pr_row(p, it) for p in linked)
    for p in sorted(prs, key=lambda p: p["number"]):
        if p["number"] not in seen_prs:
            out.append(pr_row(p))
    return out


def fingerprint(rows_):
    """Changes whenever any issue or PR moves: used to tell 'stuck' from 'busy'."""
    return "|".join(f"{r.get('issue')}:{r.get('pr')}:{r['state']}" for r in rows_)


def collect(epics=EPICS):
    """Read GitHub and return rows. Raises GitHubError when it can't."""
    issues = open_issues(epics)
    prs = open_prs()
    try:
        branches = remote_branches()
    except GitHubError:
        branches = []
    return rows(issues, prs, lambda p: behind_by("main", p["headRefOid"]), branches)
