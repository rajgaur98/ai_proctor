# Progress

Living status file. Update it in the same PR as the work.

_Last updated: 18 Oct 2026. Planning done; development moving to the local Mac session; no code yet._

## Build order

Milestone order, with the week-1 spikes early because they decide how the agent is built. All work runs locally on Raj's Mac.

1. **M0:** #8 monorepo → #9 local Supabase + first migration → #10 CI → spikes #11, #13, #14 (macOS halves; guide in `docs/handoff/mac-spikes.md`) → #15 agent skeleton. #12 (Windows card spike) waits for a Windows machine.
2. **M1 → M5** in order. Inside each milestone, do backend before the UI that uses it.
3. **M6** release work once the accounts below exist.

## Status

| Issue | Title | Status | PR |
|---|---|---|---|
| #8 | Monorepo setup | Not started | |
| #9 | Local Supabase + first migration | Not started | |
| #10 | CI | Not started | |
| #11, #13, #14 | Week-1 spikes (macOS) | Not started | |
| #12 | Windows card spike | Waiting for a Windows machine | |
| #15 | Agent skeleton | Not started | |

Add rows as issues start. Status values: Not started · In progress · PR open · Needs device test · Merged.

## Open decisions (asked, not yet answered)

1. **Branches:** create `main` from `claude/employee-activity-monitoring-z07n3t` and make it the default branch; one branch per issue for stacked PRs. OK?
2. **Merging:** (a) Raj reviews and merges, with at most ~10 unmerged PRs in a stack; or (b) Claude merges each PR once CI is green and self-review is clean, Raj reviews afterwards.
3. **Physical testing:** when a check needs Raj (permission prompts, clicking the card), stop and ask each time, or batch those checks and keep going?
4. **Windows:** is a Windows machine or VM available, or do Windows items wait until M6?

## Blocked on Raj

Format: `- #<issue>: <exact question or action needed>`

- #27 and later UI issues: export the Claude Design file "AI Proctor Phase 1.dc.html" (link in `CLAUDE.md`) and commit it under `docs/design/`. Sessions can't open claude.ai/design links. Standalone Claude Design closes on 14 Dec 2026, so export before then.

## Accounts needed later (M6)

Apple Developer Program ($99/yr) · Windows code signing (e.g. Azure Trusted Signing) · Supabase Pro project · Cloudflare (Pages + R2) · Resend · Sentry · Better Stack. Not needed before M6; everything earlier runs locally.

## Known mismatches (docs win)

- Dashboard folder: `docs/tech-stack.md` says `apps/web`; issue #8 says `apps/dashboard`. Use `apps/web`.
- Capture path: tech-stack uses `captures/{org}/{user}/{date}/{checkin_id}/…`; issue #24 omits `{date}`. Use the tech-stack path.
- macOS release builds: tech-stack says build on the local Mac (macOS CI minutes cost 10×); issue #55 says a CI macOS runner. Build releases locally; CI only compiles and runs tests on macOS, on a label or nightly.
- XLSX export is P0 in the PRD (TS-20) but deferred to #65 to keep the pilot small.
- ALR-01 (P0) includes a late clock-in alert, but recording late clock-ins (SHF-06) is P1 (#67). Needs a decision before #50.
- LLD pg_cron table lists 6 jobs; there are 7 (`send_emails` missing). Fix when touching the LLD.

## Environment notes

- Development machine: Raj's Mac, local Claude desktop session. Keep it awake during long runs (`caffeinate -dims`).
- CI budget: private repo, 2,000 free Actions minutes/month; macOS counts 10×, Windows 2×. Linux checks on every PR; macOS/Windows only on label or nightly.
