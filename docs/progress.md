# Progress

Living status file. Update it in the same PR as the work.

_Last updated: 18 Oct 2026. Planning done; no code yet._

## Build order

Front-loads work that can be fully verified in a Linux cloud session; batches macOS/Windows work for on-device testing.

1. **M0 infra:** #8 monorepo → #9 local Supabase + first migration → #10 CI → #15 agent skeleton (with `FakePlatform`)
2. **Shared logic + backend:** #40 `buildSegments()`, #30 status engine, #31 RLS, #17 devices, #23 sync RPCs, #24 storage policy, #41 rebuild-segments
3. **Dashboard:** #27 skeleton → #28 org setup → #29 shifts → #32 live grid → #33 timeline → #34 capture viewer, then M3/M4/M5 dashboard items
4. **Agent core (cross-platform):** #16 sign-in, #18 state machine, #19 scheduler, #22 outbox, #20 card logic, #25 activity aggregation
5. **Platform code, batched for device testing:** spikes #11–#14, then macOS/Windows parts of #20, #21, #25, #26, #57–#59
6. **M6 release work** once accounts exist: #55, #56, #57, #60, #61

## Status

| Issue | Title | Status | PR |
|---|---|---|---|
| #8 | Monorepo setup | Not started | |
| #9 | Local Supabase + first migration | Not started | |
| #10 | CI | Not started | |
| #11–#14 | Week-1 spikes | Not started (needs Mac) | |
| #15 | Agent skeleton | Not started | |

Add rows as issues start. Status values: Not started · In progress · PR open · Needs device test · Merged.

## Open decisions (asked, not yet answered)

1. **Branches:** the cloud session may only push to `claude/employee-activity-monitoring-z07n3t`. Stacked PRs need one branch per issue, and a `main` branch (created from the current branch) as the repo default. Allowed?
2. **Merging:** (a) Raj reviews and merges, with at most ~10 unmerged PRs in a stack; or (b) Claude merges each PR once CI is green and self-review is clean, Raj reviews afterwards.
3. **Device testing:** label `needs-device-test` and keep going (recommended), or stop until tested?
4. **Windows:** is a Windows machine or VM available, or do Windows items wait until M6?
5. **Session split:** cloud for backend/dashboard/core, local Mac session for macOS work. OK?

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

- Cloud container: Linux, 4 CPUs, 15 GB RAM, Docker, Rust, Node 22, pnpm, psql. Ephemeral; push everything.
- CI budget: private repo, 2,000 free Actions minutes/month; macOS counts 10×, Windows 2×. Linux checks on every PR; macOS/Windows only on label or nightly.
