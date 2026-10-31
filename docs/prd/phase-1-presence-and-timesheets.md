# PRD — Phase 1: Presence Verification & Timesheets

| | |
|---|---|
| **Product** | AI Proctor (working name) |
| **Phase** | 1 of 2 (Phase 2 = AI daily summaries / standups) |
| **Status** | Draft v0.3 |
| **Last updated** | 2026-10-08 |
| **Tech stack** | [docs/tech-stack.md](../tech-stack.md) |
| **Target build** | ~13–14 weeks, 2–3 engineers + part-time designer |

---

## 1. Overview

### 1.1 Problem
Companies with remote and distributed teams (especially IT services firms, agencies and companies with offshore staff) have no reliable, low-friction way to know whether people are at their desks during working hours, or to produce trustworthy timesheets for payroll and client billing. Existing tools rely on passive activity signals (mouse/keyboard), which are trivially faked with jigglers, or on continuous surveillance that employees resent and that is legally risky in the EU.

### 1.2 Solution
A desktop agent (Windows + macOS) and web dashboard that:
1. Shows **random check-in prompts** during working hours. Clicking one proves the employee is present, and captures a screenshot and webcam frame as evidence.
2. Computes a **live presence status** for every employee, visible to their manager in real time.
3. Turns presence data into **timesheets**, with flagged (never auto-deducted) gaps, optional project tracking and weekly manager approval.
4. Is **transparent by design**: employees see everything captured about them.

### 1.3 Goals
- G1: Managers can see, in real time, who on their team is present and working.
- G2: Presence evidence is hard to fake (auto-clickers, jigglers, virtual cameras).
- G3: Employees find the experience fair and low-friction (check-in response rate ≥ 90%).
- G4: Timesheets are accurate enough to be used directly for payroll and client billing.
- G5: The product can legally be deployed in the US, EU and India using region presets.
- G6: Phase 1 collects the activity and project data that Phase 2 (AI summaries) needs.

### 1.4 Non-goals (Phase 1)
- AI features of any kind (summaries, productivity scoring, insights).
- Productivity scores, rankings or "focus" metrics.
- Face recognition / identity verification. Emotion or attention detection (prohibited in EU workplaces).
- Keystroke logging, URL/app blocking, continuous screen or video recording.
- Billing rates, invoicing, payroll/accounting integrations (Phase 1.5).
- Linux and mobile agents.
- Self-serve individual / free personal tier (company-only product).

---

## 2. Users & personas

| Persona | Description | Primary needs |
|---|---|---|
| **Org Owner / Admin** | Founder, COO, HR or IT at a 20–200 person company | Set up the org, configure policies, deploy the agent, stay compliant |
| **Manager** | Team lead / delivery manager with direct reports | Live view of team presence, review evidence, approve timesheets |
| **Employee** | Individual contributor running the agent | Low-friction check-ins, privacy controls, accurate hours, visibility into own data |
| **Finance / Ops (consumer)** | Uses exports for payroll and client billing | Clean, exact, exportable hours by employee and project |

**Primary target segment for pilots:** Indian IT services firms and agencies (20–200 people) serving US/EU clients; US companies managing offshore or hourly teams.

---

## 3. Glossary

| Term | Definition |
|---|---|
| **Shift** | The scheduled working window for an employee, in their own time zone |
| **Clocked in** | The employee has started their working session; check-ins and tracking are active |
| **Check-in** | A randomly timed prompt the employee must click to prove presence |
| **Pass** | Check-in answered correctly within the response window |
| **Miss** | Check-in not answered within the response window |
| **Failed challenge** | Check-in answered with the wrong button twice |
| **Break** | Employee is not working (e.g. lunch). Unpaid by default |
| **Pause** | Employee is working but needs privacy. All collection stops. Counted as worked, up to a cap |
| **Segment** | A contiguous block of time with one classification (verified, unverified, idle, etc.) |
| **Flagged time** | Time counted as worked but highlighted for manager review (unverified, idle, away, pause over cap) |
| **Region preset** | A bundle of default policy settings for US, EU or India |

---

## 4. Functional requirements

Requirements are labelled `AREA-NN`. Priority: **P0** = must ship in Phase 1, **P1** = should ship in Phase 1, cut if timeline slips.

### 4.1 Organisation setup & roles (ORG)

| ID | Pri | Requirement |
|---|---|---|
| ORG-01 | P0 | Owner signs up with Google or Microsoft account (OAuth) or email + password, and creates an organisation |
| ORG-02 | P0 | At org creation, Owner picks a **data region** (US or EU) and a **region preset** (US / EU / India). Data region cannot be changed after creation. **During pilots only the US data region is offered**; the EU region is deployed when the first EU customer signs |
| ORG-03 | P0 | Admin invites users by email (single or CSV bulk); invitee receives a link to join and download the agent |
| ORG-04 | P0 | Roles: **Owner**, **Admin**, **Manager**, **Employee**. A user has one role; Managers and Admins can also be tracked employees |
| ORG-05 | P0 | Each employee has exactly one **direct manager** (reporting line). Admin can set and change it |
| ORG-06 | P0 | Each employee has a **work location** (country, plus state for US), used for compliance rules (e.g. Illinois, EU) |
| ORG-07 | P0 | Admin can deactivate a user; their agent stops tracking within 5 minutes and their data is retained per retention policy |
| ORG-08 | P1 | Teams (groups of employees) for filtering in dashboard and reports |

**Acceptance criteria**
- An employee without a direct manager sees a setup warning in the agent and cannot submit timesheets; Admin sees them in a "needs setup" list.
- A Manager can only see data for their direct reports (and delegated reports, see TS-14). Admins and Owner see everyone. Employees see only themselves.

### 4.2 Agent installation, permissions & consent (AGT)

| ID | Pri | Requirement |
|---|---|---|
| AGT-01 | P0 | Signed installers: `.msi` (Windows) and notarized `.pkg` (macOS). Silent install supported for MDM (Intune, Jamf, Kandji) with org enrollment token |
| AGT-02 | P0 | Agent signs in via browser handoff (invite link or org SSO) and receives a revocable **device token** bound to user + device |
| AGT-03 | P0 | **Guided permission flow** on macOS for Screen Recording and Camera, with screenshots of System Settings and a "test capture" step. Windows equivalent for camera privacy settings |
| AGT-04 | P0 | **Notice & acknowledgement screen** on first launch, showing the org's monitoring notice (template provided per region, editable by Admin): what is collected, when, who can see it, retention, employee rights. Employee must acknowledge before tracking starts. Acknowledgement (user, notice version, timestamp) is stored |
| AGT-05 | P0 | When the org changes monitoring policy in a way that affects collection (e.g. enables webcam), employees must re-acknowledge the new notice version before the change takes effect for them |
| AGT-06 | P0 | Agent runs at login, lives in system tray / menu bar, and auto-updates (staged rollout, rollback supported) |
| AGT-07 | P0 | If a required permission is missing or revoked, the agent shows a persistent prompt to fix it, and the employee's status shows **Tamper (capture blocked)** to the manager |
| AGT-08 | P0 | Agent footprint: average CPU < 1%, RAM < 100 MB, no noticeable impact on typing or video calls |

**Supported platforms:** Windows 10 (22H2+) and Windows 11; macOS 13 Ventura and later.

### 4.3 Shifts & clocking (SHF)

| ID | Pri | Requirement |
|---|---|---|
| SHF-01 | P0 | Admin/Manager defines shifts per employee: days of week, start/end time, **employee's time zone**. Shifts may cross midnight |
| SHF-02 | P0 | Employee clocks in/out from the tray app. Optional project selection at clock-in (see PRJ) |
| SHF-03 | P0 | Org setting **auto clock-in**: when enabled, the agent clocks the employee in on first input within the shift window (with a notification) |
| SHF-04 | P0 | **Forgotten clock-out**: if no input for 30 min after shift end (configurable), agent auto clocks out at last activity time and flags the day |
| SHF-05 | P0 | Check-ins, captures and activity sampling run **only while clocked in** and not on break or pause |
| SHF-06 | P1 | Late clock-in (> 15 min after shift start, configurable) is recorded and can trigger an alert |

### 4.4 Check-ins (CHK)

#### Scheduling
| ID | Pri | Requirement |
|---|---|---|
| CHK-01 | P0 | Next check-in time is drawn **uniformly at random** between org-configured min and max interval (default 20–90 min; EU preset 45–120 min) |
| CHK-02 | P0 | After a **miss**, the next check-in is scheduled 5–10 min later (random), so the employee can return to Active quickly |
| CHK-03 | P0 | Check-ins are **deferred** (not shown, not counted as missed) while: the screen is being shared, a full-screen presentation is running, or the camera/microphone is in use by another app (call). The deferred check-in is shown within 2 min after the condition ends |
| CHK-04 | P0 | If the screen is **locked or the device is asleep**, no check-in is shown. Status becomes Away (Locked) immediately. On unlock, a check-in is shown within 2 min |
| CHK-05 | P0 | Scheduling continues to work while offline (see NFR-REL) |

#### The check-in card
| ID | Pri | Requirement |
|---|---|---|
| CHK-10 | P0 | Card appears **always on top**, on a **random connected monitor** at a **random position**, including above full-screen apps |
| CHK-11 | P0 | Card **never steals keyboard focus**. Keyboard input (Enter, Space, typing) must not interact with it. Only a mouse/trackpad click on the correct button counts |
| CHK-12 | P0 | **Challenge:** card shows an instruction ("Click 7") and three numbered buttons in random order. Wrong click reshuffles numbers and positions. Two wrong clicks = **failed challenge** |
| CHK-13 | P0 | Response window default 90 s (configurable 30–300 s), with a visible countdown. Optional sound and OS notification (org setting, employee can mute sound) |
| CHK-14 | P0 | Card shows current project (if any) and a one-tap **"Switch project"** link. If no project is set: "Working on: — [Pick a project]" (optional, never blocks the check-in) |
| CHK-15 | P1 | Card size and visual style vary slightly between check-ins to defeat image-matching auto-clickers |

#### Outcomes
| ID | Pri | Requirement |
|---|---|---|
| CHK-20 | P0 | **Pass:** record the event and trigger captures (see CAP). Show the employee a 2-second thumbnail of the captured webcam frame (if webcam enabled) |
| CHK-21 | P0 | **Miss:** record the event **without any screenshot or webcam capture**. Store: scheduled, shown and expired timestamps; idle seconds at time of showing; device state (locked/asleep/on battery/display off). Status becomes Away |
| CHK-22 | P0 | **Failed challenge:** treated as a miss for status and timesheet purposes, flagged separately in reports |
| CHK-23 | P0 | Employee can add a **reason** to any missed check-in (quick picks: Meeting, Phone call, Break, Away from desk, Other, plus a free-text remark up to 500 characters; Other needs a remark) from the tray app or My data, until that week's timesheet is approved. Every change is audit-logged. Manager sees the reason and remark next to the miss in the day view and timesheet |
| CHK-24 | P0 | Every check-in event stores `response_ms` (time from shown to click). A miss has no click, so its `response_ms` is empty; the shown and expiry times are stored instead (#103) |

**Acceptance criteria**
- Typing continuously in an editor while a card appears does not dismiss, click or hide the card, and keystrokes continue to reach the editor.
- With two monitors, cards appear on both monitors over a day (verified across ≥ 20 check-ins in QA).
- A card never appears while screen sharing in Zoom, Google Meet (browser) or Microsoft Teams, or while a PowerPoint/Keynote slideshow is full screen.
- A missed check-in creates no screenshot or webcam file, locally or on the server.

### 4.5 Captures (CAP)

| ID | Pri | Requirement |
|---|---|---|
| CAP-01 | P0 | On **pass only**, capture a screenshot and a single webcam frame (each subject to org policy) |
| CAP-02 | P0 | Screenshot policy (org-level): **Full / Blurred / Off**. Blur is applied on the device before upload |
| CAP-03 | P0 | Screenshots cover all monitors (one image per monitor) |
| CAP-04 | P0 | **Excluded apps:** Admin maintains a list (defaults: common password managers). If an excluded app is focused at capture time, that monitor's screenshot is replaced with a placeholder |
| CAP-05 | P0 | Webcam policy (org-level): **On / Off**. EU preset: Off. Enabling webcam in an EU-region org requires the Admin to confirm in-app that a DPIA has been completed and (where applicable) works council consultation done; confirmation is audit-logged |
| CAP-06 | P0 | Images are downscaled (max 1280 px wide; webcam up to 320 px wide, keeping the camera's aspect, e.g. 320×180 for 16:9; decided 22 Oct 2026, #175) and compressed on device (WebP, quality ~60; target ≤ 150 KB per screenshot, ≤ 20 KB per webcam frame), encrypted in transit, and uploaded directly to object storage after the check-in event is accepted; the storage policy only accepts files in the employee's own folder for a check-in recorded as passed |
| CAP-07 | P1 | **Face presence detection** (on device, detection only, never recognition): store only a boolean `face_present`. No face images, embeddings or templates are stored or sent. **Disabled** for EU-region orgs and for employees whose work location is Illinois |
| CAP-08 | P0 | If capture fails (permission revoked, camera in use, no camera), the check-in still passes and the failure reason is stored; repeated permission failures trigger Tamper status |

### 4.6 Presence status (STS)

| ID | Pri | Requirement |
|---|---|---|
| STS-01 | P0 | Agent sends a **heartbeat** every 60 s while clocked in (contains: idle seconds, lock state, active app category, agent health). **State changes** (idle, lock/unlock, call start/end, break, pause, check-in outcome) are sent immediately as events, without waiting for the next heartbeat |
| STS-02 | P0 | Status is computed server-side using the rules below and pushed to dashboards in real time |
| STS-03 | P0 | Status change is visible in the manager's live grid within **10 s** (p95) |

**Status rules** (evaluated in priority order; first match wins)

| # | Status | Rule |
|---|---|---|
| 1 | ⚫ **Off shift** | Not clocked in |
| 2 | ⚠️ **Tamper** | Agent killed/blocked during clock-in, capture permission missing, or heartbeat gap with device online elsewhere |
| 3 | ⚫ **Offline** | Clocked in, no heartbeat for > 3 min |
| 4 | 🔵 **On break** | Break active |
| 5 | 🔵 **Paused** | Pause active |
| 6 | 🔴 **Away (Locked)** | Screen locked or device asleep |
| 7 | 🔴 **Away** | Most recent check-in was a miss or failed challenge, and no pass since |
| 8 | 🟣 **In meeting** | Camera or mic in use by another app (detected), or check-in deferred due to screen share/presentation |
| 9 | 🟡 **Idle** | No keyboard/mouse input for ≥ idle threshold (default 10 min) |
| 10 | 🟢 **Active** | Otherwise |

### 4.7 Breaks & pause (BRK)

| ID | Pri | Requirement |
|---|---|---|
| BRK-01 | P0 | Employee starts a **Break** from the tray (open-ended or preset 15/30/60 min) and ends it manually. Check-ins and all collection stop during a break |
| BRK-02 | P0 | Org setting: breaks **unpaid** (default) or paid. Optional max break time per day (allowed, but excess is flagged) |
| BRK-03 | P0 | Employee starts a **Pause** from the tray with preset durations **5 / 10 / 15 min**. Optional private reason (not shared unless employee chooses) |
| BRK-04 | P0 | During a pause, **all collection stops**: no check-ins, no screenshots, no webcam, no activity sampling. Only the pause start/end is recorded |
| BRK-05 | P0 | Pause auto-resumes at the end with a notification; employee can resume early or extend (extension = new pause) |
| BRK-06 | P0 | Org caps (defaults): **15 min per pause, 60 min per day**. Exceeding a cap is **allowed but flagged**; over-cap pause time is shown as flagged time on the timesheet |
| BRK-07 | P0 | Pause time up to the cap counts as **worked**; manager sees "Paused · N min" and daily total, never content |

### 4.8 Activity sampling (ACT) — Phase 2 groundwork

| ID | Pri | Requirement |
|---|---|---|
| ACT-01 | P0 | While clocked in (not on break/pause), agent records the **foreground app name**, **window title**, and **browser domain** (domain only, not full URL) with durations, aggregated into 1-minute buckets |
| ACT-02 | P0 | Window titles for excluded apps (CAP-04) are not recorded; app name only |
| ACT-03 | P0 | Org setting: window title collection **On / Off** (EU preset: Off). App name and domain are always collected when activity sampling is on |
| ACT-04 | P1 | Manager sees a simple "top apps today" breakdown per employee (time only, no scoring) |
| ACT-05 | P0 | Activity data is visible to the employee in "My data" |

### 4.9 Projects (PRJ)

| ID | Pri | Requirement |
|---|---|---|
| PRJ-01 | P0 | Admin/Manager creates **clients** and **projects** (name, client, billable yes/no, active/archived) and assigns which employees can log to each |
| PRJ-02 | P0 | Project selection is **optional**. Employee can pick at clock-in, switch any time from the tray or check-in card |
| PRJ-03 | P0 | Time without a project is recorded as **Unassigned** |
| PRJ-04 | P0 | Employee can **retroactively assign** unassigned (or wrongly assigned) time to projects while their timesheet is in draft |

### 4.10 Timesheets (TS)

#### Time segments
| ID | Pri | Requirement |
|---|---|---|
| TS-01 | P0 | The system classifies all clocked-in time into **segments**: |

| Segment | Source | Counted as worked? | Flagged? |
|---|---|---|---|
| Verified | Default while clocked in and active | Yes | No |
| Meeting | Camera/mic in use, or check-in deferred for screen share/presentation | Yes | No |
| Idle | No input ≥ idle threshold (from start of inactivity) | Yes | **Yes** |
| Unverified | From a miss/failed challenge (`shown_at`) until the next pass | Yes | **Yes** |
| Away (Locked) | Screen locked / device asleep | Yes | **Yes** |
| Offline | No heartbeat while clocked in | Yes | **Yes** |
| Pause (within cap) | Employee pause | Yes | No |
| Pause (over cap) | Employee pause beyond cap | Yes | **Yes** |
| Break | Employee break | Per org setting (default No) | No |
| Manual | Approved manual entry | Yes | No (shows as manual) |

| ID | Pri | Requirement |
|---|---|---|
| TS-02 | P0 | **Flagged time is never deducted automatically.** It is counted as worked and highlighted for the manager, who can **exclude** flagged segments during approval (with a reason) |
| TS-03 | P0 | Where segments overlap, precedence follows the status rules (STS); a moment in time belongs to exactly one segment |
| TS-04 | P0 | Each segment carries a project (or Unassigned) |

#### Precision
| ID | Pri | Requirement |
|---|---|---|
| TS-05 | P0 | **No rounding.** Time is stored to the second. UI shows hours and minutes |
| TS-06 | P0 | All totals are computed from **raw seconds** and rounded only for display, so that row sums and totals always agree |

#### Manual entries
| ID | Pri | Requirement |
|---|---|---|
| TS-07 | P0 | Employee can request a **manual entry** (date, start, end, project, reason) for time not captured (offline work, client visit, whiteboard session) |
| TS-08 | P0 | Manual entries are **pending** until the direct manager approves or rejects them. Pending entries are shown but not counted in totals |
| TS-09 | P0 | Manual entries cannot overlap existing clocked-in time |

#### Weekly approval
| ID | Pri | Requirement |
|---|---|---|
| TS-10 | P0 | Timesheet period is **weekly**; org sets week start day (default Monday) |
| TS-11 | P0 | Lifecycle: **Draft → Submitted → Approved** (locked) or **Returned** (back to draft with manager comments) |
| TS-12 | P0 | Only the employee's **direct manager** (or their active delegate) can approve or return. Admins cannot approve |
| TS-13 | P0 | Manager can edit an employee's time (exclude flagged segments, adjust entries, change project) before approving. **Every manager edit requires a reason, is audit-logged, and is shown to the employee** |
| TS-14 | P0 | **Delegation:** a manager can set a temporary delegate approver for a date range (e.g. while on leave) |
| TS-15 | P0 | When an employee's direct manager changes, all their pending (submitted) timesheets move to the new manager |
| TS-16 | P0 | Org setting per user: **approval not required** (for Owner / top of org). Their timesheets auto-approve on submit |
| TS-17 | P0 | Reminders: employee is reminded to submit at end of week; manager is reminded **2 days** after submission; after a further 3 days, Admin receives an escalation notice (notify only) |
| TS-18 | P0 | Approved timesheets are locked. Changes after approval require the manager to **reopen** (audit-logged, employee notified) |
| TS-19 | P1 | Org setting: daily and weekly **overtime thresholds**; hours above threshold are highlighted (no pay calculation) |

#### Exports
| ID | Pri | Requirement |
|---|---|---|
| TS-20 | P0 | Export to **CSV and XLSX**, filterable by date range, employee, team, client, project and approval status |
| TS-21 | P0 | Export views: (a) per employee per day, (b) per project/client per employee, (c) segment-level detail |
| TS-22 | P0 | Hours shown as **decimal to 2 places** (e.g. 7.43) plus an **H:MM** column. Columns include worked, flagged, excluded, break, manual, billable/non-billable, approval status, approver |
| TS-23 | P0 | Unassigned time appears as its own row in project exports |

### 4.11 Manager dashboard (DSH)

| ID | Pri | Requirement |
|---|---|---|
| DSH-01 | P0 | **Live grid:** all direct reports on shift, showing avatar, name, status (colour + label), time in current status, last check-in time and outcome, today's check-in response rate, current project. Updates in real time |
| DSH-02 | P0 | Filter by status and team; sort by name, status, last check-in |
| DSH-03 | P0 | **Day timeline** per employee: horizontal bar across the shift coloured by segment, with check-in markers (pass / miss / failed / deferred) |
| DSH-04 | P0 | Clicking a passed check-in opens the **capture viewer**: screenshot(s) and webcam frame side by side, with timestamp, active app and project. Every view is audit-logged |
| DSH-05 | P0 | Clicking a miss shows its context: idle time, device state, employee's reason |
| DSH-06 | P0 | **Timesheets tab:** list of reports' timesheets by week and status; open, review flagged time, edit, approve or return |
| DSH-07 | P0 | **Reports:** per employee and team for a date range: worked hours, flagged hours, check-ins shown/passed/missed/failed, response rate, median response time, break and pause totals, late clock-ins |
| DSH-08 | P1 | Anomaly flags in reports (see ANT): suspected injected input, virtual camera, duplicate webcam frames, remote session |
| DSH-09 | P1 | **Seat view** of the Team page, a toggle beside the list and remembered per viewer: everyone the viewer can see sits in a chair round an oval table (seven chairs on each long side, four round each end, about 22 a table; more people open more tables, and with every team shown each team has its own). Initials on each chair; green = Active, red = any other status (idle, away, on break, paused, in a meeting, offline, tamper, off shift), always with the exact status and since when as text (tooltip and accessible name), never colour alone. Hover or focus shows name, status, since and project; click or Enter opens the person's day; arrow keys move round a table; the chairs are a list for screen readers. Updates live from the same feed as DSH-01. Below laptop width the list shows instead |

### 4.12 Alerts (ALR)

| ID | Pri | Requirement |
|---|---|---|
| ALR-01 | P0 | Manager alerts (in-app + email), each individually configurable: **N consecutive misses** (default 3), **offline during shift > 15 min**, **Tamper**, **late clock-in**, **pause over daily cap** |
| ALR-02 | P0 | Alerts are batched to max one email per employee per alert type per hour |
| ALR-03 | P1 | Daily digest email to managers: yesterday's hours, flagged time and misses per report |

### 4.13 Employee transparency (EMP)

| ID | Pri | Requirement |
|---|---|---|
| EMP-01 | P0 | Tray app shows: current status, clock in/out, break, pause (with remaining daily pause allowance), current project. The time of the next check-in is **never** shown (randomness must be preserved) |
| EMP-02 | P0 | **My data** (web, employee view): own timeline, every check-in with its captures, misses with reasons, activity samples, timesheets and all manager edits with reasons |
| EMP-03 | P0 | Employee can see **who viewed their captures** (viewer name and time) |
| EMP-04 | P0 | Employee can download a copy of their own data (supports GDPR/DPDP access requests) |
| EMP-05 | P0 | The monitoring notice they acknowledged is always viewable from the tray app |

### 4.14 Anti-gaming & tamper detection (ANT)

| ID | Pri | Requirement |
|---|---|---|
| ANT-01 | P0 | **Watchdog:** a helper process restarts the agent if it is killed. A heartbeat gap during clock-in while the device is online (detected on next sync) raises Tamper |
| ANT-02 | P0 | **Injected input detection (Windows):** check-in clicks with the injected flag (`LLMHF_INJECTED`) are rejected and flagged. Exception (#168): for a person an admin marks as using assistive input (accessibility tools that click for them), injected clicks are accepted and still flagged for review; changing the setting is audit-logged |
| ANT-03 | P1 | **Injected input detection (macOS):** best-effort detection of synthetic events; flag only |
| ANT-04 | P0 | **Response-time analysis:** flag employees whose response times are implausibly fast (< 300 ms from show) or implausibly consistent (very low variance across a day) |
| ANT-05 | P1 | **Virtual camera detection:** flag when the selected camera is a known virtual device (e.g. OBS Virtual Camera) |
| ANT-06 | P1 | **Duplicate frame detection:** flag when webcam frames are near-identical across check-ins (perceptual hash) |
| ANT-07 | P1 | **Remote session / VM detection:** flag when the agent runs inside an RDP session or a virtual machine |
| ANT-08 | P0 | Flags are shown to the manager as "needs review", never as automatic penalties |

### 4.15 Admin settings & policies (ADM)

| ID | Pri | Requirement |
|---|---|---|
| ADM-01 | P0 | Org-level policy covering all configurable values in §6, initialised from the region preset |
| ADM-02 | P1 | Per-team policy overrides (e.g. different check-in frequency for support vs engineering) |
| ADM-03 | P0 | Retention settings: images (default 30 days, range 7–90), check-in and activity events (default 12 months), timesheets and segments (default 3 years, to meet payroll record-keeping requirements) |
| ADM-04 | P0 | Retention is enforced automatically (object storage lifecycle rules + scheduled DB purge) |
| ADM-05 | P0 | Admin can export or permanently delete all data for a user (data subject requests) |
| ADM-06 | P0 | Editable monitoring notice text per region, with version history (see AGT-04/05) |

### 4.16 Audit log (AUD)

| ID | Pri | Requirement |
|---|---|---|
| AUD-01 | P0 | Append-only audit log of: capture views, policy changes, role and reporting-line changes, timesheet edits/approvals/returns/reopens, delegations, exports, user deactivation, data exports/deletions, DPIA confirmations |
| AUD-02 | P0 | Admin and Owner can search and export the audit log |
| AUD-03 | P0 | Audit log retained for at least 3 years, regardless of other retention settings |

---

## 5. Region presets & compliance

### 5.1 Presets

| Setting | US | EU | India |
|---|---|---|---|
| Data region | US | **EU** (after pilot; see ORG-02) | US |
| Check-in interval | 20–90 min | **45–120 min** | 20–90 min |
| Screenshot | Full | **Blurred** | Full |
| Webcam | On | **Off** (enable requires DPIA confirmation) | On |
| Face presence detection | On (off for Illinois employees) | **Unavailable** | On |
| Window titles | On | **Off** | On |
| Notice template | US (state notice laws) | GDPR (Art. 13) | DPDP |
| Image retention | 30 days | 30 days (max 30) | 30 days |

### 5.2 Compliance requirements by region

**United States**
- Written notice and employee acknowledgement before monitoring (NY Civil Rights Law §52-c requires acknowledgement; CT and DE require notice). Covered by AGT-04.
- California (CPRA): notice at collection, employee rights to access and delete. Covered by EMP-04, ADM-05.
- Illinois (BIPA): no biometric identifiers. Face detection disabled for Illinois employees (CAP-07); no face templates anywhere.
- FLSA: never auto-deduct time from non-exempt employees (TS-02).

**European Union**
- GDPR: provide a legitimate interest assessment and **DPIA template** to customers; DPA with Standard Contractual Clauses; EU data residency including LLM processing in Phase 2.
- Works councils (e.g. Germany, France, Netherlands): provide a works-council information pack describing data collected, purposes and controls.
- EU AI Act: no emotion recognition in the workplace (prohibited). No face detection or other AI-based behaviour monitoring in Phase 1, to stay outside high-risk classification.
- Working-time recording is a legal requirement for EU employers; position timesheets as compliant time recording.

**India**
- DPDP Act 2023 and Rules: notice in clear language, employment is a permitted ground for processing; grievance contact shown in notice; support access/erasure requests.

**Legal review:** a privacy lawyer must review notice templates, the DPIA template and region presets before the first paid customer.

---

## 6. Default configuration values

| Setting | Default | Range | Scope |
|---|---|---|---|
| Check-in min / max interval | 20 / 90 min | 10–240 min | Org (team override P1) |
| Follow-up after miss | 5–10 min | Fixed | System |
| Response window | 90 s | 30–300 s | Org |
| Deferred check-in shown after condition ends | ≤ 2 min | Fixed | System |
| Idle threshold | 10 min | 3–60 min | Org |
| Heartbeat interval | 60 s | Fixed | System |
| Offline threshold | 3 min no heartbeat | Fixed | System |
| Pause presets | 5 / 10 / 15 min | Fixed | System |
| Pause cap per pause / per day | 15 / 60 min | 0–60 / 0–240 min | Org |
| Breaks paid | No | Yes/No | Org |
| Auto clock-in | Off | On/Off | Org |
| Auto clock-out after shift end | 30 min no input | 10–120 min | Org |
| Late clock-in threshold | 15 min | 5–60 min | Org |
| Consecutive-miss alert | 3 | 1–10 | Org |
| Week start | Monday | Any day | Org |
| Rounding | None | None only (Phase 1) | Org |
| Manager approval reminder / escalation | 2 days / +3 days | Fixed | System |

---

## 7. Non-functional requirements (NFR)

### Performance
- NFR-PERF-01: Agent average CPU < 1%, peak < 10% during capture (≤ 2 s); RAM < 100 MB.
- NFR-PERF-02: Check-in card appears within 500 ms of its scheduled time.
- NFR-PERF-03: Live grid status latency ≤ 10 s p95 for agent-reported state changes; Offline is detected within 3–4 min; dashboard pages load in < 2 s p95 for orgs up to 500 users.

### Reliability & offline
- NFR-REL-01: Agent works fully offline: clocking, check-ins, captures, breaks/pauses and activity sampling are queued locally (encrypted) for up to **7 days** and synced when back online. Server-side segment computation uses device timestamps with clock-skew correction.
- NFR-REL-02: Crash-free sessions ≥ 99.5%.
- NFR-REL-03: Pilot: best effort on the managed backend (no contractual SLA). From general availability: 99.9% monthly.

### Security
- NFR-SEC-01: TLS 1.2+ everywhere; AES-256 encryption at rest for databases and object storage.
- NFR-SEC-02: Image URLs for viewing are presigned with ≤ 5 min expiry; images never publicly accessible.
- NFR-SEC-03: Device tokens are revocable and rotated; local agent queue encrypted with OS keychain-protected key.
- NFR-SEC-04: Strict tenant isolation (every query scoped by org); access checks enforce manager → direct reports only.
- NFR-SEC-05: MFA available for all users; enforced option for Admins.
- NFR-SEC-06: Code signing for all agent binaries (Apple notarization, Windows Authenticode) to avoid SmartScreen/AV false positives.

### Data residency
- NFR-DATA-01: Separate US and EU deployments; an org's data (DB, object storage, backups, logs containing personal data) stays in its region. Pilots run in the US region only; the EU deployment is created when the first EU customer signs.

### Usability & accessibility
- NFR-UX-01: Dashboard meets WCAG 2.1 AA. Status is never conveyed by colour alone (always with a label).
- NFR-UX-02: Check-in card supports OS-level accessibility scaling; the response window can be extended per employee (accommodation setting).
- NFR-UX-03: English only in Phase 1; all times shown in the viewer's time zone with the employee's zone available on hover.

### Browsers
- Latest two versions of Chrome, Edge, Firefox and Safari.

---

## 8. Data model (core entities)

```
orgs(id, name, data_region, region_preset, policy jsonb, created_at)
teams(id, org_id, name)
users(id, org_id, role, email, name, manager_id, team_id, work_country, work_state,
      timezone, approval_required, status)
delegations(id, manager_id, delegate_id, starts_on, ends_on)
devices(id, user_id, platform, os_version, agent_version, token_hash, last_seen_at)
notices(id, org_id, region, version, body, published_at)
notice_acks(user_id, notice_id, acknowledged_at)
shifts(id, user_id, days_of_week, start_time, end_time, timezone)
clock_sessions(id, user_id, device_id, start_at, end_at, end_reason)
checkin_events(id, user_id, device_id, scheduled_at, shown_at, responded_at,
               outcome[pass|miss|failed|deferred], response_ms, wrong_clicks,
               idle_seconds_at_show, device_state, deferral_reason,
               screenshot_keys[], webcam_key, face_present, capture_errors[],
               flags[], missed_reason, project_id)
breaks(id, user_id, start_at, end_at, paid)
pauses(id, user_id, start_at, end_at, planned_minutes, over_cap_seconds, private_reason)
heartbeats  -- short-lived, aggregated into status_periods
status_periods(id, user_id, status, start_at, end_at)
activity_samples(user_id, minute, app_name, window_title, domain, seconds)
clients(id, org_id, name)
projects(id, org_id, client_id, name, billable, archived)
project_members(project_id, user_id)
time_segments(id, user_id, type, start_at, end_at, project_id, source,
              excluded, excluded_reason, excluded_by)
manual_entries(id, user_id, start_at, end_at, project_id, reason, status, decided_by, decided_at)
timesheets(id, user_id, period_start, status[draft|submitted|approved|returned],
           submitted_at, approver_id, approved_at, comments)
timesheet_edits(id, timesheet_id, editor_id, change jsonb, reason, created_at)
alerts(id, org_id, user_id, type, payload, sent_at)
audit_log(id, org_id, actor_id, action, target_type, target_id, metadata, created_at)
```

---

## 9. System architecture

Pilot architecture (full detail, costs and scaling triggers in [docs/tech-stack.md](../tech-stack.md)):

```
┌──────────────── Desktop agent (Tauri v2: Rust core + React UI) ────────────────┐
│ Scheduler · Check-in card · Screenshot + webcam capture · Idle/lock detection · │
│ Activity sampler · Encrypted offline queue (SQLite) · Auto-updater · Watchdog   │
└───────────┬──────────────────────────────────────────────┬─────────────────────┘
            │ HTTPS: Postgres RPC functions                │ uploads (own folder)
            ▼   (heartbeat, events, clock, check-ins)      ▼
┌─────────────────────────── Supabase (US region) ───────────────────────────────┐
│ Postgres + row-level security · Auth · Storage (private bucket) · Realtime ·   │
│ pg_cron (offline sweep, alerts, retention) · Edge Functions (segment engine,   │
│ emails, exports, audited capture URLs)                                          │
└───────────┬────────────────────────────────────────────────────────────────────┘
            │ Realtime (status changes only) + REST
            ▼
Manager dashboard: React SPA on Cloudflare Pages
```

**Platform-specific notes** (native APIs used by the agent's Rust platform layer)

| Capability | macOS | Windows |
|---|---|---|
| Overlay | Non-activating `NSPanel`, floating level, joins all Spaces, full-screen auxiliary | `WS_EX_TOPMOST \| WS_EX_NOACTIVATE \| WS_EX_TOOLWINDOW` |
| Screenshot | ScreenCaptureKit | Windows.Graphics.Capture / DXGI duplication |
| Webcam | AVFoundation | Media Foundation |
| Idle time | `CGEventSourceSecondsSinceLastEventType` | `GetLastInputInfo` |
| Lock / sleep | Distributed notifications (screen locked/unlocked), NSWorkspace sleep/wake | `WTSRegisterSessionNotification`, power broadcast |
| Camera/mic in use | CoreMediaIO / CoreAudio device-in-use properties | Capability access manager usage keys |
| Screen sharing detection | ScreenCaptureKit / known conferencing app window heuristics | Known conferencing app window heuristics |
| Injected input | Event source heuristics (best effort) | Low-level mouse hook `LLMHF_INJECTED` |

**Known platform constraints**
- macOS Screen Recording and Camera permissions must be granted by the user; MDM can only allow standard users to approve Screen Recording, not grant it silently. Recent macOS versions periodically re-prompt for Screen Recording. The agent must detect lost permissions and guide the user (AGT-03, AGT-07).
- Monitoring agents are frequently flagged by antivirus; signed binaries and submission to major AV vendors for allow-listing are required before pilots.

---

## 10. Success metrics

**Product health (measured during pilots)**
| Metric | Target |
|---|---|
| Check-in response rate (pass / shown, excluding deferrals) | ≥ 90% |
| Median check-in response time | ≤ 20 s |
| Missed check-ins with a reason added | ≥ 50% |
| Agent crash-free sessions | ≥ 99.5% |
| Permission dropout (employees in Tamper: capture blocked, per week) | ≤ 2% |
| Timesheets approved within 3 days of submission | ≥ 80% |
| Manager weekly active rate (opens dashboard ≥ 2 days/week) | ≥ 70% |
| Employee-reported fairness (pilot survey, "the check-ins are reasonable") | ≥ 70% agree |

**Business**
| Metric | Target |
|---|---|
| Pilots started | 5–8 |
| Pilot → paid conversion | 2–4 paying customers within 3 months of pilot start |

---

## 11. Milestones

| Weeks | Milestone | Exit criteria |
|---|---|---|
| 1–2 | **Foundations** | Agent skeleton on Win + Mac (tray, login, heartbeat); backend auth, orgs, invites, roles, reporting lines |
| 3–5 | **Check-ins** | Scheduler, overlay + challenge, deferral and lock handling, captures on pass, miss records with context, idle detection |
| 5–7 | **Live dashboard** | Status engine, live grid, day timeline, capture viewer, policies and region presets |
| 7–9 | **Breaks, pause, projects** | Breaks, pause with caps, projects/clients, time segments, offline queue + sync |
| 9–11 | **Timesheets** | Timesheet view, manual entries, weekly approval with delegation, manager edits, exports |
| 11–12 | **Trust & compliance** | Notices + acknowledgements, My data, alerts, reports, retention jobs, audit log, data export/delete |
| 12–14 | **Pilot readiness** | Signing/notarization, auto-update, MDM docs, AV allow-listing, load test, security review, first pilot installs |

---

## 12. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| macOS permission friction and re-prompts | Employees appear as Tamper; managers lose trust | Guided permission flow, clear Tamper sub-reason, MDM docs, proactive employee notification |
| Antivirus / SmartScreen flags the agent | Install failures in pilots | Code signing, AV vendor submissions, documented allow-list steps |
| Employee backlash ("surveillance") | Churn, bad reviews | Transparency features (EMP), no captures on miss, pause, notice flow, fairness survey in pilots |
| EU legal exposure | Fines, blocked deals | EU preset defaults, DPIA confirmation gate, no AI/face detection in EU, lawyer review |
| Cheating via auto-clickers / virtual cameras | Product loses credibility | Non-focus card, challenge, injected-input and response-time analysis, virtual camera and duplicate frame detection |
| Check-ins too frequent / disruptive | Low response rate, resentment | Configurable interval, deferral during calls/presentations, measure response rate in pilots |
| Timesheet scope creep (rates, invoices, integrations) | Delays Phase 2 | Hold the line: exports only in Phase 1; integrations in 1.5 based on pilot demand |
| Clock skew / offline edge cases corrupt timesheets | Wrong hours, payroll disputes | Server-side segment computation with skew correction, extensive offline test matrix |

---

## 13. Out of scope / later phases

**Phase 1.5 (driven by pilot feedback)**
- Slack / Microsoft Teams alerts and digests
- Accounting and payroll integrations (QuickBooks, Xero, Zoho Books, Keka, greytHR, Darwinbox, Zoho People)
- Billing rates and invoice-ready reports
- Rounding rules (6 / 15 min)
- SSO (SAML / SCIM)
- India data region (Mumbai), if requested by enterprise customers
- Smart frequency (fewer check-ins when strong activity signals are present)

**Phase 2 — AI daily summaries / standups**
- Daily summary per employee from activity samples, projects, check-in context and integrations (calendar, GitHub/GitLab, Jira/Linear, Slack metadata)
- Every summary bullet links to its source; employee reviews/edits before the manager sees it
- Manager team digest and weekly rollup
- No productivity scoring; human in the loop (EU AI Act / GDPR Art. 22)

---

## 14. Open questions

1. **Pricing & packaging** for Phase 1 and the Phase 2 upgrade path.
2. Should **Meeting** time (camera/mic in use) ever be flagged, e.g. when it exceeds a daily threshold?
3. Should employees be able to **request** an adjustment to a flagged segment (in addition to adding a miss reason), or is the manager edit flow enough?
4. Per-employee **accommodations** (longer response window, fewer check-ins): who can set them — manager or Admin only?
5. Is **Linux** needed for any pilot customer (engineering-heavy agencies)?
6. Product name and brand positioning that works for both Phase 1 (presence) and Phase 2 (summaries).
