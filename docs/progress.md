# Progress

Living status file. Update it in the same PR as the work.

_Last updated: 19 Oct 2026. Development started on Raj's Mac; M0 in progress._

## Build order

Milestone order, with the week-1 spikes early because they decide how the agent is built. All work runs locally on Raj's Mac.

1. **M0:** #8 monorepo → #9 local Supabase + first migration → #10 CI → spikes #11, #13, #14 (macOS halves; guide in `docs/handoff/mac-spikes.md`) → #15 agent skeleton. #12 (Windows card spike) waits for a Windows machine.
2. **M1 → M5** in order. Inside each milestone, do backend before the UI that uses it.
3. **M6** release work once the accounts below exist.

## Status

| Issue | Title | Status | PR |
|---|---|---|---|
| #8 | Monorepo setup | Merged | #68 |
| #9 | Local Supabase + first migration | Merged | #69 |
| #10 | CI | Merged | #70 |
| #11, #13, #14 | Week-1 spikes (macOS) | Draft PRs, manual checks pending Raj | #71, #72, #73 |
| #12 | Windows card spike | Waiting for a Windows machine | |
| #15 | Agent skeleton | Merged | #74 |
| #17 | Device registration, revocation, deactivation (backend) | PR open | #75 |
| #23 | Sync RPCs | In progress: server side PR open; agent client waits for the outbox (#22) | |

Add rows as issues start. Status values: Not started · In progress · PR open · Needs device test · Merged.

## Decisions

Answered by Raj on 19 Oct 2026.

1. **Branches:** `main` (created from `claude/employee-activity-monitoring-z07n3t`) is the default branch. One branch per issue, PRs stacked per milestone.
2. **Merging:** Claude merges every PR once CI is green and the self-review is clean. Raj reviews afterwards.
3. **Physical testing:** checks that need Raj are batched into one numbered list per spike or milestone; work continues meanwhile. Stop at once only when a result decides what gets built next.
4. **Windows:** no Windows machine or VM. Windows code must compile and pass tests on the Windows CI runner; real-machine testing and #12 wait until M6.
5. **Second display:** none available. Multi-monitor cases are tested on one display and listed under "Blocked on Raj".
6. **Labels:** `ci:full` and `needs-device-test` created.
7. **Turborepo:** used from #8 (overrides "only if builds get slow" in issue #8).
8. **Windows CI:** the Windows job runs automatically on PRs that touch Windows code, plus on `ci:full` and nightly. Label-only would let stacked PRs go green with no Windows run.
9. **UI design:** UI work doesn't wait for an export. Sessions read the Claude Design project with `DesignSync` and commit copies of the screens they use under `docs/design/`.

## Blocked on Raj

Format: `- #<issue>: <exact question or action needed>`

- #11, #13: multi-monitor cases need a second display (CHK-10 card on a random monitor, CAP-03 one screenshot per display, PRD "≥20 check-ins across two monitors"). Tested on the built-in display only until one is connected.
- #23, #30 (before M1): during a pause or break, should the agent still send a heartbeat with no content (no idle, lock or app data), so `offline_sweep` doesn't mark the user Offline? Default if no answer: yes.
- M6: PRD AGT-01/AGT-02 call for a device token and an MDM enrollment token, but tech-stack and the LLD only use the user's session plus `device_id`, and no issue builds the enrollment token. Should an issue be added?

## Accounts needed later (M6)

Apple Developer Program ($99/yr) · Windows code signing (e.g. Azure Trusted Signing) · Supabase Pro project · Cloudflare (Pages + R2) · Resend · Sentry · Better Stack. Not needed before M6; everything earlier runs locally.

## Known mismatches (docs win)

- Dashboard folder: `docs/tech-stack.md` says `apps/web`; issue #8 says `apps/dashboard`. Use `apps/web`.
- Capture path: tech-stack uses `captures/{org}/{user}/{date}/{checkin_id}/…`; issue #24 omits `{date}`. Use the tech-stack path.
- macOS release builds: tech-stack says build on the local Mac (macOS CI minutes cost 10×); issue #55 says a CI macOS runner. Build releases locally; CI only compiles and runs tests on macOS, on a label or nightly.
- XLSX export is P0 in the PRD (TS-20) but deferred to #65 to keep the pilot small.
- ALR-01 (P0) includes a late clock-in alert, but recording late clock-ins (SHF-06) is P1 (#67). Needs a decision before #50.
- First migration (#9) lists `checkins` and `captures` tables; the LLD has `checkin_events` (with `object_keys[]`), a separate `last_seen` table, and no `captures` table. Use the LLD. #23 and #24 use the issue names too. `users` also gets `full_name` and `email` (not in the LLD column list; the dashboard needs them and `auth.users` isn't readable through the API).
- macOS minimum: PRD says macOS 13+, so the spike guide's 12.3 fallback is dropped, but the macOS 13 `SCStream` path is still needed (`SCScreenshotManager` is 14+). Only compile-checked on Raj's macOS 26 Mac.
- Device token (AGT-02): implemented as the Supabase JWT plus a `device_id` claim added by an Auth access-token hook, bound per Auth session (`device_sessions`, not in the LLD). The hook refuses tokens for deactivated users and revoked devices. Agent RPCs still take `device_id` (LLD) and check it matches the claim.
- #23 / LLD: `agent_events` returns `acked_seq` (highest contiguous seq processed) next to the LLD's accepted / duplicates / rejected / server_time, so the agent can drop everything at or below it. Rejected events are stored in `agent_event_rejections` so they count toward it.
- LLD pg_cron table lists 6 jobs; there are 7 (`send_emails` missing). Fix when touching the LLD.

## Environment notes

- Development machine: Raj's Mac, local Claude desktop session. Keep it awake during long runs (`caffeinate -dims`).
- CI budget: private repo, 2,000 free Actions minutes/month; macOS counts 10×, Windows 2×. Linux checks on every PR; Windows also on PRs touching Windows code; otherwise macOS/Windows only on the `ci:full` label or nightly.
- Homebrew refuses formula builds because the Command Line Tools are outdated (it wants the Xcode 27 version; fixing needs `sudo`). Full Xcode 26.6 works for Rust builds. The Supabase CLI comes from the `supabase` npm devDependency instead of Homebrew (#9).
- Local Supabase runs with analytics (Logflare + Vector) off: they failed health checks on Docker Desktop and aren't needed.
- Rust comes from Homebrew's `rustup` (proxies in `/opt/homebrew/opt/rustup/bin`, not on the default PATH); Node 22 from asdf. See the Commands section of `CLAUDE.md`.
