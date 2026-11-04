#!/usr/bin/env python3
"""One-line merge verdict for a PR.

    scripts/autonomy/gate.py <pr>

    GATE ok · ci=success · base=main · closes=#123
    GATE blocked · ci=pending · behind-main=3 · conflict · stacked-on=#120 · draft

Exit 0 when the PR may merge into main, 1 when it may not, 2 when GitHub
couldn't be read. The gate: not a draft; every check on the head commit passed
and `CI OK` concluded success; no conflict; based on main (a stacked PR waits
for the PR below it); the head contains main's tip (CLAUDE.md: two PRs green
alone can break main together); and an issue branch says `Closes #<n>`.
"""

import re
import sys

import lib


def verdict(p, behind, open_base_pr):
    problems = []
    if p.get("state", "OPEN") != "OPEN":
        return False, f"GATE blocked · state={p['state'].lower()}"
    if p.get("isDraft"):
        problems.append("draft")
    ci = lib.ci_state(p)
    if ci != "success":
        problems.append(f"ci={ci}")
    if p.get("mergeable") == "CONFLICTING":
        problems.append("conflict")
    elif p.get("mergeable") == "UNKNOWN":
        problems.append("mergeable=unknown")
    if p["baseRefName"] != "main":
        problems.append(f"stacked-on=#{open_base_pr}" if open_base_pr else f"base={p['baseRefName']}")
    elif behind:
        problems.append(f"behind-main={behind}")
    closes = sorted(int(n) for n in lib.CLOSES.findall(p.get("body") or ""))
    if re.match(r"\d+-", p["headRefName"]) and not closes:
        problems.append("no-closes")
    if problems:
        return False, "GATE blocked · " + " · ".join(problems)
    tail = f" · closes={','.join(f'#{n}' for n in closes)}" if closes else ""
    return True, f"GATE ok · ci=success · base=main{tail}"


def check(number):
    p = lib.pr(number)
    behind = lib.behind_by("main", p["headRefOid"]) if p["baseRefName"] == "main" else None
    base_pr = None
    if p["baseRefName"] != "main":
        base_pr = next((o["number"] for o in lib.open_prs()
                        if o["headRefName"] == p["baseRefName"]), None)
    ok, line = verdict(p, behind, base_pr)
    return ok, line, p


def main(argv):
    if len(argv) != 1 or not argv[0].isdigit():
        print("usage: gate.py <pr>", file=sys.stderr)
        return 2
    try:
        ok, line, _ = check(int(argv[0]))
    except lib.GitHubError as e:
        print(f"GATE error · {e}")
        return 2
    print(line)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
