# Development tracking

Work is tracked in [GitHub Issues](https://github.com/rajgaur98/ai_proctor/issues). Each milestone is an **epic issue** whose sub-issues are the work items, so the epic shows a progress bar.

| Epic | Milestone | Scope |
|---|---|---|
| #1 | M0 · Foundations & spike | monorepo, local Supabase, CI, week-1 spikes, agent skeleton |
| #2 | M1 · Check-ins & captures | sign-in, scheduler, card, capture, outbox, sync |
| #3 | M2 · Live dashboard | org setup, shifts, status engine, RLS, live grid, timeline, capture viewer |
| #4 | M3 · Breaks, pause & projects | breaks, capped pause, tray popover, projects, miss reasons |
| #5 | M4 · Timesheets | segment engine, approvals, manual entries, export, reminders, reports |
| #6 | M5 · Trust & compliance | notice + ack, My data, alerts, retention, audit log, data subject requests |
| #7 | M6 · Pilot readiness | signed installers, auto-update, watchdog, backups, observability |
| #62 | Later · After pilot | PRD P1 items |

Work the milestones in order. M0's spikes can change the approach for M1, so finish them first.

## Labels

| Label | Meaning |
|---|---|
| `epic` | milestone parent issue |
| `P0` / `P1` | pilot scope / after pilot (matches the PRD) |
| `area:agent` `area:dashboard` `area:backend` `area:infra` | where the code lives |
| `type:feature` `type:bug` `type:spike` `type:chore` | kind of work |
| `platform:macos` `platform:windows` | OS-specific work |
| `ci:full` | run the macOS and Windows CI jobs on this PR |
| `needs-device-test` | needs manual testing on a real device; checklist in the PR body |

## Conventions

- One branch per issue: `<issue-number>-<short-name>`, e.g. `21-capture-pipeline`.
- Pull request description includes `Closes #<n>` so merging closes the issue and moves the board card to Done. GitHub only auto-closes when the PR merges into `main`, so for stacked PRs the issue closes when its PR (or the stack below it) lands on `main`.
- Every issue body lists the PRD requirement IDs it covers. If scope changes, update the PRD first, then the issue.
- Spikes end with a write-up in `docs/spikes/`.

## Project board setup (one time, in the GitHub UI)

1. Repository → **Projects** → **New project** → **Board** template. Name it "AI Proctor".
2. Columns (Status field): **Backlog → Ready → In progress → In review → Done**.
3. Add fields: **Iteration** (2 weeks), **Size** (single select: S, M, L). Show the built-in **Parent issue** field so each card shows its epic.
4. **Workflows** (project menu): turn on *Auto-add to project* with filter `is:issue is:open repo:rajgaur98/ai_proctor`, *Item closed → Done*, *Pull request merged → Done*.
5. Add all existing issues: in the project, press `+ Add item` and paste `repo:rajgaur98/ai_proctor is:issue is:open`, select all.
6. Extra views:
   - **Roadmap** (layout: Roadmap), grouped by *Parent issue*, using the Iteration field for dates.
   - **This iteration** (layout: Board), filter `iteration:@current`.
   - **By area** (layout: Table), grouped by label.

Optional: label colours and real GitHub Milestones (Issues → Milestones) can be added in the UI; the epics already give per-milestone progress.
