# Handoff: full development on Raj's Mac

You are running in a local Claude desktop session on Raj's Mac, in a clone of this repo. All of Phase 1 development happens here: every open issue under epics #1–#7 (P1 items under #62 only when Raj asks). Planning, docs and the issue backlog were done earlier in a cloud session; nothing is built yet.

## Read once
1. `CLAUDE.md`: stack, rules, workflow. It's loaded automatically, but read it properly.
2. `docs/progress.md`: build order, status, open decisions, blockers, known doc mismatches.
3. `docs/prd/phase-1-presence-and-timesheets.md`, `docs/tech-stack.md`, `docs/architecture-lld.html`: skim now, read the relevant section before each issue.
4. The issues themselves (`gh issue list` or the GitHub UI); each has PRD IDs and acceptance criteria.
5. `docs/handoff/mac-spikes.md` when you reach the spikes.

## Step 1: confirm with Raj before doing anything

Do not install anything, create branches, write code or open PRs yet. Reply with:

1. Your understanding of the goal and scope, in 3–5 bullets.
2. A **read-only** environment check: `sw_vers`, `xcode-select -p`, `rustc --version`, `cargo --version`, `cargo tauri --version`, `node --version`, `pnpm --version`, `docker info`, `supabase --version`, `gh auth status`, number of displays. List what's missing and what you'd install.
3. The four open decisions from `docs/progress.md`, asked as questions, with your recommendation for each.
4. The first stack of work you'll do (issues and order) and what you'll need Raj to do physically.
5. Anything in the docs you disagree with or find contradictory.

Then wait for an explicit go-ahead. Record Raj's answers to the open decisions in `docs/progress.md` (move them out of "Open decisions" into a "Decisions" section) in your first PR.

## Step 2: environment setup (after go-ahead)

Ask before each install. Typical set:
- Xcode command line tools: `xcode-select --install`
- Rust: rustup; then `cargo install tauri-cli --version "^2" --locked`
- `brew install node@22 pnpm supabase/tap/supabase gh`
- Docker for the local Supabase stack: `brew install --cask orbstack` (or Docker Desktop)
- `gh auth login` if not signed in

Ask Raj to enable **System Settings → Privacy & Security → Screen Recording → Claude**, so you can verify UI with `screencapture -x`.

## Step 3: work loop

For each issue in the build order (`docs/progress.md`):
1. Read the issue, the PRD IDs it lists, and the matching LLD section. If the issue and docs disagree, docs win; note it in the PR.
2. Branch `<issue>-<short-name>` off the previous branch in the stack.
3. Implement with tests. Run lint, typecheck, unit tests (and Supabase/SQL tests where relevant) locally.
4. Self-review the diff (correctness, the "Rules that matter" in `CLAUDE.md`, PRD acceptance criteria).
5. Push, open a PR targeting the previous branch, body with `Closes #<n>`, PRD IDs, how it was tested, and any manual checks for Raj.
6. Watch CI; fix failures before moving on. Address review comments when they come in.
7. Update the issue's row in `docs/progress.md` in the same PR. Fill in the Commands section of `CLAUDE.md` as soon as #8 lands.

**Stacks:** one stack per milestone (M0, M1, …). Keep at most ~10 unmerged PRs in total unless Raj's merging decision says otherwise; if you hit the limit, work on the spikes, docs or the next milestone's backend on a separate stack. After a lower PR merges, rebase the rest of the stack onto the new base.

**Physical steps:** when something needs Raj (approve a permission prompt, click the check-in card, open a full-screen app), stop and give numbered steps, then wait. Verify what you can yourself with screenshots. Test permissions on a bundled `.app`, not a binary launched from your shell.

**Blocked on a decision:** add it to "Blocked on Raj" in `docs/progress.md` with the exact question, tell Raj, and move to the next unblocked issue.

**Windows:** code must compile and pass tests on the Windows CI runner; label PRs needing real-machine testing `needs-device-test` with a checklist. #12 waits for a Windows machine.

**UI work** (#20 card, #27 onwards, #37 tray): the design reference is the Claude Design project linked in `CLAUDE.md`. Read the screen files with the `DesignSync` tool and commit a copy of the ones you used under `docs/design/` in the same PR.

**CI budget:** Linux jobs on every PR. The Windows job also runs automatically on PRs that touch Windows code. Otherwise macOS and Windows jobs run only on the `ci:full` label or nightly, since they cost 10× and 2× the free minutes. macOS release builds happen locally.

## Running long

After Raj approves the plan, he may set a goal such as:

```
/goal Every sub-issue of epics #1–#7 has a PR with green CI, or is listed in docs/progress.md under "Blocked on Raj" with the exact question
```

The goal checker only reads the conversation, so end every turn with a short status table: issue, status, PR link, blocker. Keep the Mac awake during long runs (`caffeinate -dims` in a terminal).

## Done when

Every sub-issue of #1–#7 has a merged PR (or an open PR with green CI awaiting review), or is listed under "Blocked on Raj" with the exact question.
