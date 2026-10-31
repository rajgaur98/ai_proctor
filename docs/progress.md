# Progress

Living status file. Update it in the same PR as the work.

_Last updated: 1 Nov 2026. M0–M2 built and merged; M3–M5 next._

## Now / Next

Read this first after a restart or a context compaction. Update it with every PR.

- **Autonomous mode:** the switch is the local file `.claude/autonomy/mode` (`on` / `off`, untracked). While it's on, the Stop hook (`scripts/autonomy/stop_guard.py`) keeps the session going until no unblocked milestone issue is left, and a scheduled check every ~30 min resumes the work if the session goes idle.
- **Now (1 Nov):** Raj's 31 Oct requests are on main, apart from the parts below.
  - Merged:
    - #250 onboarding without a camera (#258)
    - #251 seat map (#259)
    - #252 miss remarks (#260)
    - #253 employees delete parts of their own check-ins (#270)
    - #254 part 1: tasks and work notes (#261)
    - #255 part 1: exports on list pages (#271)
    - #256 imports: people, teams, clients, projects, shifts (#276)
    - #263 day list (#278)
    - #266 timesheet totals (#277)
    - #268 tray task picker (#273)
    - #269 task reorder and reports by task (#275)
    - #274 fix: back-to-back manual entries kept no project (#279)
  - In progress: #255 part 2 (exports on the live grid, day view, captures metadata, timesheet views, task report); #282 importing manual time entries.
  - Board: moving a card to "In review" closes the issue (the board's Auto-close workflow), which blinds the Stop hook. Cards stay "In progress" until the PR merges.
- **Open PRs:** none yet for #255 part 2 and #282.
- **Next:**
  - #254 parts 2, 5, 6 and 8 (#262, #264, #265, #267) wait on the weekly-grid question in "Blocked on Raj".
  - Then the hosted Supabase project (staging) for Pages previews and backups.
- **Waiting on Raj:** see "Blocked on Raj"; those issues carry the `blocked` label and are skipped.
- **Device checks for Raj (one session, bundled `.app` from main):**
  1. Domains: Chromium (Brave, Chrome) and Safari with Accessibility granted (#114).
  2. Notifications: permission prompt and banners (#123).
  3. Two displays: an excluded app on one display blanks only that display (#123).
  4. Screen share or Keynote while a card is due: card held, deferred marker on the day page (#102); status In meeting while sharing (#170).
  5. Invite flow: invite email → join → agent sign-in.
  6. Tray popover (#127): clock in with a project, break, pause with a note, extend, switch project, miss a card and give a reason.
  7. Monitoring notice (#141): unacknowledged user sees the notice and can't clock in; acknowledge; publish a new version while clocked in.
  8. Watchdog (#158): first launch from /Applications installs the LaunchAgent; `kill -9` comes back in ~10 s with a short Tamper; Quit refused while clocked in; revoke Screen Recording → Tamper; reboot → no Tamper.
  9. Onboarding (#165): permissions step, restart banner, test capture, re-run from the tray; webcam off hides the camera.
  10. macOS 13 screenshots (#162): on a macOS 13 machine or VM; on 14+ with `AI_PROCTOR_DEV_FORCE_SCSTREAM=1`.
  11. Accessibility step (#169, PR #215 checklist): optional card, tray banner only when activity sampling is on, no Tamper.
  12. Tamper follows the policy (#161, PR #217 checklist): screenshots and window titles off → no banner or Tamper with Screen Recording revoked.
  13. Restricted permission (#212): an MDM-restricted Screen Recording shows the device-management banner and Capture blocked.
  14. Stable signing (#108, PR #226 steps): grant Screen Recording and Camera once to the signed bundle; after a rebuild no prompt returns (keychain too).
  15. Agent e2e with real captures (#227, PR #231 steps): `bash scripts/agent-e2e.sh` passes after the one-time grant.
  16. Anti-cheat extras (#63, PR #229 checklist): real trackpad clicks are not flagged synthetic (check first); OBS virtual camera, still frame, Screen Sharing, VM; card variation.
  17. MDM enrollment (#86, PR #230 checklist): managed-preference token enrolls at sign-in; user-level value ignored; revoke stops new devices.
  18. Face presence (#64, PR #233 checklist): facing the camera vs covered; off for an Illinois work location.
  19. Onboarding without a camera (#250, PR #258): on the Windows VM with no camera, "Finish without camera" reaches Done; on the Mac, with Photo Booth holding the camera, Retake leads.
  20. Miss remark in the tray (#252, PR #260): let a card expire; the Remark box has a counter; Other needs a remark; Cmd+Enter saves; My data shows it.
  21. Tray task picker (#268, PR #273): on a project with tasks, pick a task, clear it, switch project (resets), archive a task (the tray drops it); the timesheet splits time by task after about 5 minutes.
  - Windows (no machine yet): #158 task + restart, #165 camera privacy, #166 injected clicks, #167 capture and signals, #174 HDR / UWP / stale calls / toasts (PR #214), #63 VM/RDP/virtual camera (PR #229), #86 registry token (PR #230), #64 FaceDetector (PR #233). Each PR has its checklist.

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
| #11, #13, #14 | Week-1 spikes (macOS) | Merged (#13 / #14 stay open for their Windows halves) | #71, #72, #73 |
| #12 | Windows card spike | Waiting for a Windows machine | |
| #15 | Agent skeleton | Merged | #74 |
| #17 | Device registration, revocation, deactivation (backend) | Merged | #75 |
| #23 | Sync RPCs | Merged | #76, #81 |
| #24 | Capture upload policy and uploader | Merged | #77, #81 |
| #22 | Encrypted offline outbox | Merged | #78 |
| #18 | Clock in/out and session state machine | Merged | #79 |
| #19 | Check-in scheduler | Merged | #80 |
| #31 | Row-level security, can_view_user() | Merged | #82 |
| #30 | Status engine and offline sweep | Merged | #83 |
| #27 | Dashboard skeleton | Merged | #84 |
| #32 | Live grid with Realtime | Merged | #85 |
| #16 | Agent sign-in (magic link), device attach, sync + heartbeat loop | Merged; needs device test | #87 |
| #20 | Check-in card: challenge, countdown, outcomes | Merged; needs device test | #88 |
| #14 (macOS) | Presence signals in the macOS Platform | Merged; needs device test | #89 |
| #21 | Capture pipeline: screenshots, webcam, blur, excluded apps | Merged; needs device test | #91 |
| #25 | Activity sampling | Merged; needs device test | #90, #92 |
| #28 | Org setup: invites, roles, reporting lines, work location, audit log | Merged | #93 |
| #29 | Shift schedules per employee | Server + dashboard merged; agent side PR open | #94, #97 |
| #33 | Day timeline per employee with check-in markers | Merged | #95 |
| #34 | Capture viewer with signed URLs and audit logging | Merged | #96 |

Add rows as issues start. Status values: Not started · In progress · PR open · Needs device test · Merged.

## Decisions

Answered by Raj on 19 Oct 2026.

1. **Branches:** `main` (created from `claude/employee-activity-monitoring-z07n3t`) is the default branch. One branch per issue, PRs stacked per milestone.
2. **Merging:** Claude merges every PR once CI is green and the self-review is clean. Raj reviews afterwards.
3. **Physical testing:** checks that need Raj are batched into one numbered list per spike or milestone; work continues meanwhile. Stop at once only when a result decides what gets built next.
4. **Windows:** no Windows machine or VM. Windows code must compile and pass tests on the Windows CI runner; real-machine testing and #12 wait until M6.
5. **Second display:** none available. Multi-monitor cases are tested on one display; see the M6 device-test checklist.
6. **Labels:** `ci:full` and `needs-device-test` created.
7. **Turborepo:** used from #8 (overrides "only if builds get slow" in issue #8).
8. **Windows CI:** the Windows job runs automatically on PRs that touch Windows code, plus on `ci:full` and nightly. Label-only would let stacked PRs go green with no Windows run.
9. **UI design:** UI work doesn't wait for an export. Sessions read the Claude Design project with `DesignSync` and commit copies of the screens they use under `docs/design/`.

Answered by Raj on 20 Oct 2026.

10. **Agent sign-in (#16):** magic link. The agent sends the email with its PKCE challenge; the link opens the browser and returns via `aiproctor://auth`. Google / Microsoft OAuth added when those apps exist (M6).
11. **Approvals (#43):** an owner or admin may approve their **own direct reports only**; never anyone else's. (Refines TS-12 / LLD 07; `can_approve_for` changes with #43.)
12. **Heartbeat during pause or break:** yes, a content-free heartbeat (alive + agent version only), so the person stays Paused / On break, not Offline.
13. **Accounts (Cloudflare Pages previews, Google/Microsoft OAuth apps, Sentry DSN):** wait for M6. #27 stays open for those items.
14. **MDM enrollment token (AGT-01):** tracked as P1 #86 under #62; pilot installs are manual.
15. **Branch protection:** not enabled (needs GitHub Pro). The session merges only on green CI.
16. **Second display / second Space:** multi-monitor and Spaces testing move to the M6 device-test checklist below.
17. **Spike checks:** done step by step with Raj on 19–20 Oct; results in `docs/spikes/`.
18. **`response_ms` on a miss (CHK-24, #103):** empty. A miss has no click; storing the countdown would skew response-time averages. Default taken from the issue; Raj can reopen it.

## Blocked on Raj

Format: `- #<issue>: <exact question or action needed>`

- #12, #13, #14 (Windows halves), #56: a Windows VM (Raj is setting one up, 22 Oct). CI builds an unsigned Windows installer to install there; then the Windows checklists in each PR.
- #27, #55, #57, #60, #61: accounts and secrets for M6 (Apple Developer, Cloudflare Pages + R2, Sentry, Better Stack, Google/Microsoft OAuth, a domain for Resend).
- #262, #264, #265, #267 (all wait on the grid): should the weekly grid's cells be duration-only entries (no start/end, like Harvest and Clockify), or placed at a default start time? Today a manual entry needs a start and an end.
- 31 Oct defaults taken (Raj can change any of them):
  - #251: in_meeting, paused and idle show red on the seat map, although the "Active" tile counts them as active.
  - #252: miss reasons stay editable until the week is **approved**. CHK-23 is updated to match; it said "submitted".
  - #253: "apps for a check-in" is the minute it was answered; deleting domains also clears browser page titles; only passed check-ins can have parts deleted; managers get no separate notification.
  - #254:
    - notes lock once the week is submitted;
    - managers edit notes only through the audited RPC;
    - a task's billable flag is copied from its project when the task is made;
    - there are no task-level member lists.
  - #255:
    - no notifications export (that list has no page);
    - `record_export` trusts the browser's row count;
    - employees may record exports.
  - #256:
    - CSV plus an .xlsx reader with no new dependency;
    - membership imports only add;
    - an unknown team or client is an error;
    - imports are admin-only;
    - invite emails go out after the database commit.

Decided 22 Oct 2026: #168 per-person assistive-input exemption (flag, don't block); #175 keep the camera's aspect (CAP-06 updated); #54 names stay in the deletion tombstone and audit rows as the legal record; #21 camera-on target ≤ 2 s; the pilot includes Windows (VM).

## M6 device-test checklist

Physical checks deferred to pilot readiness:
- Two monitors: card on a random monitor (CHK-10), one screenshot per display (CAP-03), "≥ 20 check-ins across two monitors" (PRD).
- Card on a second Space (desktop 2).
- PowerPoint slideshow presentation detection; Zoom and Microsoft Teams screen-share indicators.
- macOS 13 (PRD minimum): the `SCStream` single-frame fallback for screenshots.
- Webcam exposure in a dark room.
- All Windows items (#12, Windows halves of #13 / #14, #26, #56).

## Accounts needed later (M6)

Apple Developer Program ($99/yr) · Windows code signing (e.g. Azure Trusted Signing) · Supabase Pro project · Cloudflare (Pages + R2, also PR previews for #27) · Google Cloud + Microsoft Entra OAuth apps (#27, #16) · Resend · Sentry · Better Stack. Not needed before M6; everything earlier runs locally.

## Launch compliance (India + US)

Not legal or tax advice: a CA and a privacy lawyer confirm each item. Selling to US customers from an Indian company; no US entity for the pilot.

Now:
- [ ] Check the day-job employment contract (IP assignment, moonlighting); get a written NOC if needed.
- [ ] Incorporate: Pvt Ltd (SPICe+; DSC + DIN per director) or LLP. Pvt Ltd if raising money.
- [ ] D-U-N-S number for the company (free, 1–2 weeks), then the Apple Developer Program as an organisation (Developer ID + notarization, AGT-01).
- [ ] GST registration + LUT every year (exports billed at 0%); bank account; keep FIRA / e-BRC for each foreign payment. Ask the CA whether SOFTEX applies to the agent.

Before the pilot:
- [ ] Privacy lawyer reviews the notice templates, DPIA template and region presets (PRD §5.2). Ask whether on-device face presence detection is a biometric identifier under Texas CUBI, Washington and Colorado law, not only Illinois BIPA (CAP-07 only covers Illinois).
- [ ] Contracts: Terms of Service / MSA, order form, DPA (processor terms: DPDP + CPRA service-provider clauses), subprocessor list (Supabase, Cloudflare, Resend, Sentry, Better Stack), privacy policy (site + app).
- [ ] Windows code signing (NFR-SEC-06): Azure Trusted Signing is likely limited to US / Canada / EU / UK organisations; plan for an OV certificate with a cloud or hardware key (~$200–400/yr).
- [ ] W-8BEN-E ready for US customers (India–US treaty, no withholding).
- [ ] CERT-In 2022 directions: incident report within 6 hours, NTP-synced clocks, logs kept 180 days. Write the incident runbook.
- [ ] Cyber liability + E&O insurance (US contracts often ask for $1–2M).
- [ ] Third-party licence notices bundled in the app (cargo + npm dependencies).

Later:
- [ ] DPDP Rules: most duties apply from about May 2027 (notice, grievance contact, breach reporting to the Board and to people, erasure). EMP-04 / ADM-05 cover access and deletion.
- [ ] SOC 2 Type I, then Type II, when US buyers ask; until then a security questionnaire, pentest report and written policies.
- [ ] Trademark search, then India (Class 9 + 42) and USPTO. "AI Proctor" may be too descriptive and clash with exam-proctoring products.
- [ ] US sales tax on SaaS once past state thresholds (often $100k or 200 sales), or use a merchant of record (e.g. Paddle).
- [ ] Delaware C-Corp only if raising from US investors (EIN, registered agent, franchise tax, Form 5472; ODI filings in India). Decide before raising: moving the company later is costly.
- [ ] DPIIT Startup India recognition (optional); Shops & Establishments and Professional Tax once there's an office or staff.

## Known mismatches (docs win)

- Dashboard folder: `docs/tech-stack.md` says `apps/web`; issue #8 says `apps/dashboard`. Use `apps/web`.
- Capture path: tech-stack uses `captures/{org}/{user}/{date}/{checkin_id}/…`; issue #24 omits `{date}`. Use the tech-stack path.
- macOS release builds: tech-stack says build on the local Mac (macOS CI minutes cost 10×); issue #55 says a CI macOS runner. Build releases locally; CI only compiles and runs tests on macOS, on a label or nightly.
- XLSX export is P0 in the PRD (TS-20); it was deferred from the pilot and lands with #65 (with TS-19 overtime highlighting).
- ALR-01 (P0) includes a late clock-in alert, but recording late clock-ins (SHF-06) is P1 (#67). Needs a decision before #50.
- First migration (#9) lists `checkins` and `captures` tables; the LLD has `checkin_events` (with `object_keys[]`), a separate `last_seen` table, and no `captures` table. Use the LLD. #23 and #24 use the issue names too. `users` also gets `full_name` and `email` (not in the LLD column list; the dashboard needs them and `auth.users` isn't readable through the API).
- macOS minimum: PRD says macOS 13+, so the spike guide's 12.3 fallback is dropped, but the macOS 13 `SCStream` path is still needed (`SCScreenshotManager` is 14+). Only compile-checked on Raj's macOS 26 Mac.
- Device token (AGT-02): implemented as the Supabase JWT plus a `device_id` claim added by an Auth access-token hook, bound per Auth session (`device_sessions`, not in the LLD). The hook refuses tokens for deactivated users and revoked devices. Agent RPCs still take `device_id` (LLD) and check it matches the claim.
- #23 / LLD: `agent_events` returns `acked_seq` (highest contiguous seq processed) next to the LLD's accepted / duplicates / rejected / server_time, so the agent can drop everything at or below it. Rejected events are stored in `agent_event_rejections` so they count toward it.
- #30 Tamper from a heartbeat gap: recorded only when the agent went silent during clock-in with no queued events from the gap and no lock/sleep before it (agent killed or blocked). A gap with queued events is offline work (NFR-REL-01), not Tamper. The PRD's "device online elsewhere" isn't observable server-side.
- Design token: the light theme's `--ink3` is `#696d74` in code, not the design's `#6c7077`, which is 4.35:1 on `--sunk` (table headers, hovered rows) and fails WCAG AA (NFR-UX-01). Update the Claude Design style sheet to match.
- LLD pg_cron table lists 6 jobs; there are 7 (`send_emails` missing). Fix when touching the LLD.

## Notes for later issues

- #24 uploader: Storage answers denials with HTTP 400 and the real status in the JSON body (`statusCode` "409" = already uploaded, treat as done; "403" = policy refused, don't retry).

- Device re-registration: the outbox's `seq` keeps counting per install, but the server's `acked_seq` starts at 0 for a new device row, so its contiguous cursor would never pass the gap. The sync client (#23) must reset the outbox seq when the device id changes (or the server must start the cursor at the first seq it sees).

## Environment notes

- Development machine: Raj's Mac, local Claude desktop session. Keep it awake during long runs (`caffeinate -dims`).
- CI budget: the repo is public since 20 Oct, so standard runners are free (it was private with 2,000 minutes/month; macOS counts 10×, Windows 2×, which ran out). Going private again brings the limit back. Linux checks on every PR; Windows also on PRs touching Windows code; otherwise macOS/Windows only on the `ci:full` label or nightly.
- Homebrew refuses formula builds because the Command Line Tools are outdated (it wants the Xcode 27 version; fixing needs `sudo`). Full Xcode 26.6 works for Rust builds. The Supabase CLI comes from the `supabase` npm devDependency instead of Homebrew (#9).
- Local Supabase runs with analytics (Logflare + Vector) off: they failed health checks on Docker Desktop and aren't needed.
- Rust comes from Homebrew's `rustup` (proxies in `/opt/homebrew/opt/rustup/bin`, not on the default PATH); Node 22 from asdf. See the Commands section of `CLAUDE.md`.
