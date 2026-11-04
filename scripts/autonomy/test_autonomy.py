"""Unit tests for the autonomy scripts' rules (no GitHub, no git writes).

    python3 -m unittest discover -s scripts/autonomy -p 'test_*.py'
"""

import json
import os
import sys
import tempfile
import time
import unittest

STATE = tempfile.mkdtemp()
os.environ["AI_PROCTOR_AUTONOMY_DIR"] = STATE
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gate  # noqa: E402
import lib  # noqa: E402
import next as nxt  # noqa: E402
import stop_guard  # noqa: E402


def check(name, conclusion, status="COMPLETED"):
    return {"__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion}


GREEN = [check("Lint", "SUCCESS"), check("Rust test (macOS)", "SKIPPED"), check("CI OK", "SUCCESS")]


def pr(n, head, base="main", checks=GREEN, body="", draft=False, mergeable="MERGEABLE"):
    return {"number": n, "title": f"PR {n}", "state": "OPEN", "headRefName": head,
            "headRefOid": f"sha{n}", "baseRefName": base, "body": body, "isDraft": draft,
            "mergeable": mergeable, "statusCheckRollup": checks}


def issue(n, labels=()):
    return {"number": n, "title": f"Issue {n}", "labels": list(labels), "epic": 1}


class CiState(unittest.TestCase):
    def test_green(self):
        self.assertEqual(lib.ci_state(pr(1, "1-a")), "success")

    def test_a_failed_job_counts_before_ci_ok_reports(self):
        p = pr(1, "1-a", checks=[check("Lint", "FAILURE"), check("CI OK", None, "IN_PROGRESS")])
        self.assertEqual(lib.ci_state(p), "failure")

    def test_cancelled_is_failure(self):
        self.assertEqual(lib.ci_state(pr(1, "1-a", checks=[check("Lint", "CANCELLED")])), "failure")

    def test_pending_and_missing(self):
        self.assertEqual(lib.ci_state(pr(1, "1-a", checks=[check("Lint", None, "IN_PROGRESS")])), "pending")
        self.assertEqual(lib.ci_state(pr(1, "1-a", checks=[])), "missing")


class IssueLinks(unittest.TestCase):
    def test_closes_and_branch_prefix(self):
        self.assertEqual(lib.issue_numbers_of(pr(1, "12-x", body="Closes #12\nfixes #14")), {12, 14})
        self.assertEqual(lib.issue_numbers_of(pr(1, "docs-progress")), set())


class Rows(unittest.TestCase):
    def states(self, issues, prs, behind=0, branches=()):
        return {(r["issue"], r["pr"]): r["state"]
                for r in lib.rows(issues, prs, lambda p: behind, branches)}

    def test_each_state(self):
        prs = [
            pr(101, "1-a"),                                              # ready
            pr(102, "2-b", checks=[check("Lint", "FAILURE")]),           # failing
            pr(103, "3-c", mergeable="CONFLICTING"),                     # conflict
            pr(104, "4-d", checks=[check("CI OK", None, "QUEUED")]),     # in CI
            pr(105, "5-e", base="1-a"),                                  # stacked on 101
            pr(106, "6-f", draft=True),                                  # draft
        ]
        issues = [issue(i) for i in range(1, 9)] + [issue(9, ["blocked"])]
        s = self.states(issues, prs)
        self.assertEqual(s[(1, 101)], "ready-to-merge")
        self.assertEqual(s[(2, 102)], "pr-failing")
        self.assertEqual(s[(3, 103)], "pr-conflict")
        self.assertEqual(s[(4, 104)], "pr-in-ci")
        self.assertEqual(s[(5, 105)], "waiting-on-base")
        self.assertEqual(s[(6, 106)], "needs-work")
        self.assertEqual(s[(7, None)], "needs-work")
        self.assertEqual(s[(9, None)], "blocked")

    def test_behind_main(self):
        self.assertEqual(self.states([issue(1)], [pr(101, "1-a")], behind=2)[(1, 101)], "behind-main")

    def test_stacked_base_already_merged_needs_retarget(self):
        # Base branch no longer has an open PR: the PR must be retargeted.
        self.assertEqual(self.states([issue(5)], [pr(105, "5-e", base="1-a")])[(5, 105)], "needs-work")

    def test_pr_without_issue_gets_its_own_row(self):
        s = self.states([], [pr(200, "docs-progress")])
        self.assertEqual(s[(None, 200)], "ready-to-merge")

    def test_branch_without_pr_is_named(self):
        r = lib.rows([issue(7)], [], lambda p: 0, ["7-thing"])[0]
        self.assertEqual(r["next"], "continue on 7-thing")


class Gate(unittest.TestCase):
    def test_ok(self):
        ok, line = gate.verdict(pr(1, "12-x", body="Closes #12"), 0, None)
        self.assertTrue(ok)
        self.assertEqual(line, "GATE ok · ci=success · base=main · closes=#12")

    def test_blocked_lists_every_problem(self):
        p = pr(1, "12-x", checks=[check("CI OK", None, "IN_PROGRESS")], draft=True,
               mergeable="CONFLICTING")
        ok, line = gate.verdict(p, 3, None)
        self.assertFalse(ok)
        self.assertEqual(line, "GATE blocked · draft · ci=pending · conflict · behind-main=3 · no-closes")

    def test_stacked(self):
        ok, line = gate.verdict(pr(2, "13-y", base="12-x", body="Closes #13"), None, 1)
        self.assertEqual((ok, line), (False, "GATE blocked · stacked-on=#1"))

    def test_merged(self):
        p = dict(pr(1, "12-x", body="Closes #12"), state="MERGED")
        self.assertEqual(gate.verdict(p, 0, None), (False, "GATE blocked · state=merged"))


ACT = [{"issue": 1, "pr": None, "state": "needs-work", "title": "t", "next": "build it"}]
WAIT = [{"issue": 2, "pr": 5, "state": "pr-in-ci", "title": "t", "next": "wait for CI"}]


class StopGuard(unittest.TestCase):
    def test_other_sessions_stop_freely(self):
        reason, _ = stop_guard.decide({"session_id": "A"}, "B", ACT, 0)
        self.assertIsNone(reason)

    def test_only_waiting_lets_the_owner_stop(self):
        reason, _ = stop_guard.decide({"session_id": "A"}, "A", WAIT, 0)
        self.assertIsNone(reason)

    def test_blocks_while_working_and_gives_up_when_idle(self):
        owner = {"session_id": "A", "calls": 0}
        for _ in range(stop_guard.MAX_IDLE_BLOCKS):
            reason, owner = stop_guard.decide(owner, "A", ACT, 100)
            self.assertIsNotNone(reason)
        reason, owner = stop_guard.decide(owner, "A", ACT, 100)
        self.assertIsNone(reason)
        self.assertEqual(owner["stuck"]["at"], 100)

    def test_tool_calls_between_stops_reset_the_count(self):
        owner = {"session_id": "A", "calls": 0}
        for i in range(stop_guard.MAX_IDLE_BLOCKS * 3):
            owner["calls"] += stop_guard.MIN_CALLS
            reason, owner = stop_guard.decide(owner, "A", ACT, 0)
            self.assertIsNotNone(reason, i)


class WakeCheck(unittest.TestCase):
    def setUp(self):
        with open(lib.MODE_FILE, "w") as f:
            f.write("on")

    def tearDown(self):
        for f in (lib.MODE_FILE, lib.OWNER_FILE):
            if os.path.exists(f):
                os.remove(f)

    def test_mode_off(self):
        os.remove(lib.MODE_FILE)
        self.assertEqual(nxt.wake_check(ACT), "WAKE no · mode off")

    def test_live_owner(self):
        now = time.time()
        lib.write_owner({"session_id": "A", "heartbeat_at": now - 60})
        self.assertTrue(nxt.wake_check(ACT, now).startswith("WAKE no · owner A live"))

    def test_stale_owner_with_work(self):
        now = time.time()
        lib.write_owner({"session_id": "A", "heartbeat_at": now - lib.LIVE_S - 1})
        self.assertTrue(nxt.wake_check(ACT, now).startswith("WAKE yes · owner=A · 1 actionable"))

    def test_nothing_actionable(self):
        self.assertEqual(nxt.wake_check(WAIT), "WAKE no · nothing actionable (1 waiting)")

    def test_stuck_state_is_left_alone_for_an_hour(self):
        now = time.time()
        lib.write_owner({"session_id": "A", "heartbeat_at": 0,
                         "stuck": {"fingerprint": lib.fingerprint(ACT), "at": now - 600}})
        self.assertTrue(nxt.wake_check(ACT, now).startswith("WAKE no · owner gave up"))
        lib.write_owner({"session_id": "A", "heartbeat_at": 0,
                         "stuck": {"fingerprint": lib.fingerprint(ACT), "at": now - 4000}})
        self.assertTrue(nxt.wake_check(ACT, now).startswith("WAKE yes"))


class Heartbeat(unittest.TestCase):
    HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "heartbeat.py")

    def fire(self, payload):
        import subprocess

        subprocess.run([sys.executable, self.HOOK], input=json.dumps(payload), text=True,
                       env=dict(os.environ), check=True)

    def setUp(self):
        with open(lib.MODE_FILE, "w") as f:
            f.write("on")
        lib.write_owner({"session_id": "pending"})

    def tearDown(self):
        for f in (lib.MODE_FILE, lib.OWNER_FILE):
            if os.path.exists(f):
                os.remove(f)

    def test_claim_then_heartbeat(self):
        self.fire({"session_id": "S1", "hook_event_name": "PostToolUse", "tool_name": "Bash",
                   "tool_input": {"command": "scripts/autonomy/ctl.sh on"}})
        self.assertEqual(lib.read_owner()["session_id"], "S1")
        self.fire({"session_id": "S1", "hook_event_name": "PreToolUse", "tool_name": "Read",
                   "tool_input": {}})
        self.fire({"session_id": "S2", "hook_event_name": "PreToolUse", "tool_name": "Read",
                   "tool_input": {}})
        self.assertEqual(lib.read_owner()["calls"], 1)

    def test_pre_tool_use_does_not_claim(self):
        self.fire({"session_id": "S1", "hook_event_name": "PreToolUse", "tool_name": "Bash",
                   "tool_input": {"command": "scripts/autonomy/ctl.sh claim"}})
        self.assertEqual(lib.read_owner()["session_id"], "pending")


if __name__ == "__main__":
    unittest.main()
