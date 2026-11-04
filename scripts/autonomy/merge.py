#!/usr/bin/env python3
"""Merge a PR into main through the gate, then do the bookkeeping.

    scripts/autonomy/merge.py <pr> [--dry-run]

1. gate.py must read `GATE ok`; otherwise it prints the gate line and exits 1.
2. Merges with a merge commit (the repo's style), never `--admin`.
3. Moves every issue the PR closes to Done on the board.
4. Stacked PRs that were based on the merged branch are retargeted to main and
   get main merged into them on GitHub (update-branch), so the stack carries on
   without a local checkout. A worktree holding such a branch must pull.

Prints one line per step; exit 0 when merged, 1 when the gate blocked, 2 on a
GitHub error.
"""

import os
import subprocess
import sys

import gate
import lib

HERE = os.path.dirname(os.path.abspath(__file__))


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    dry = "--dry-run" in argv
    if len(args) != 1 or not args[0].isdigit():
        print("usage: merge.py <pr> [--dry-run]", file=sys.stderr)
        return 2
    n = int(args[0])
    try:
        ok, line, p = gate.check(n)
        print(line)
        if not ok:
            return 1
        closes = sorted({int(x) for x in lib.CLOSES.findall(p.get("body") or "")})
        children = [o for o in lib.open_prs() if o["baseRefName"] == p["headRefName"]]
        if dry:
            print(f"DRY-RUN would merge #{n}, move {closes or 'no issues'} to Done, "
                  f"retarget {[c['number'] for c in children] or 'no stacked PRs'}")
            return 0
        lib.gh("pr", "merge", str(n), "--repo", lib.REPO, "--merge",
               "--match-head-commit", p["headRefOid"])
        print(f"MERGED #{n}")
    except lib.GitHubError as e:
        print(f"MERGE error · {e}")
        return 2

    for i in closes:
        out = subprocess.run([os.path.join(HERE, "board.sh"), str(i), "done"],
                             capture_output=True, text=True)
        print(f"BOARD #{i} done" if out.returncode == 0 else f"BOARD #{i} failed · {out.stderr.strip()[:120]}")

    for c in children:
        try:
            lib.gh("pr", "edit", str(c["number"]), "--repo", lib.REPO, "--base", "main")
            lib.gh("api", "-X", "PUT", f"repos/{lib.REPO}/pulls/{c['number']}/update-branch",
                   "-f", f"expected_head_sha={c['headRefOid']}")
            print(f"RESTACKED #{c['number']} · base=main · main merged in on GitHub · "
                  f"pull {c['headRefName']} in its worktree")
        except lib.GitHubError as e:
            print(f"RESTACK #{c['number']} failed · {e} · merge main into {c['headRefName']} by hand")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
