# Design brief: AI Proctor, Phase 1

## Product
AI Proctor (working name) helps companies with remote teams know who is at their desk and produce trustworthy timesheets. A desktop app (Windows and macOS) shows small check-in cards at random times during work hours. Clicking one proves the person is present and captures a screenshot and one webcam frame. Managers see their team's presence live and approve weekly timesheets. Employees see everything captured about them.

Buyers: IT services firms, agencies and remote companies (20–200 people) in India, the US and the EU. Phase 2 will add AI daily work summaries, so the brand must not feel like surveillance software.

## Design principles
1. **Fair, not policing.** Calm, respectful, transparent. No surveillance imagery (eyes, cameras, CCTV, red alarms, sirens).
2. **Glanceable.** A manager understands the whole team's state in two seconds.
3. **Transparent.** Wherever data is captured or viewed, say so plainly. Employees can see their own data and who viewed it.
4. **Low friction for employees.** The check-in takes under three seconds and never interrupts typing.
5. **No scores.** No productivity scores, rankings or "focus" metrics anywhere.

## Brand direction
Create a fresh identity (not an existing company's brand). Trustworthy, calm, modern and precise, like a well-made finance or developer tool. Avoid: purple-blue gradients, neon, emoji, Inter/Roboto/Arial. One accent colour plus a semantic status palette. Light and dark themes for every screen.

## Status system (used everywhere)
Each status needs a colour **and** a text label (never colour alone), distinguishable by lightness for colour-blind users:
Active · Idle · Away · Away (locked) · On break · Paused · In meeting · Offline · Tamper (capture blocked) · Off shift.

## Platforms and sizes
- **Desktop app windows:** check-in card ~360×200, tray popover ~360×520, onboarding window 720×560.
- **Web dashboard:** design at 1440 wide; must also work at 1024 and collapse sensibly on a phone.
- Touch targets ≥ 44 px. Text contrast ≥ 4.5:1.

## Screens and states

### 1. Check-in card (desktop, floats above all windows)
- **Shown:** "Click 7 to check in", three numbered buttons in random order (e.g. 4 · 7 · 2), a 90-second countdown, current project "Acme Redesign" with a "Switch" link. If no project: "Working on: — Pick a project" (optional).
- **Wrong click:** numbers reshuffle, small note "Try again".
- **Passed:** "Checked in · 10:42" with a small thumbnail of the captured webcam frame for 2 seconds.
- Must look like it can't steal keyboard focus: no text field, no default-highlighted button. Never show when the next check-in is due.

### 2. Tray popover (desktop)
- **Off shift:** "Clock in" button, optional project picker.
- **Working:** status chip "Active", time today "5 h 12 min", current project, last check-in "10:42 · passed", buttons Break and Pause, pause allowance "45 of 60 min left today", links My data and Monitoring notice.
- **Paused:** countdown "Paused · 8:41 left", note "Nothing is being collected", Resume button.
- **On break:** "On break · 22 min", End break.
- **Permission missing:** warning "Screen recording permission is off. Your manager sees 'Capture blocked'." with Fix button.
- **Missed check-in:** "You missed a check-in at 14:03" with "Add a reason" (Meeting, Phone call, Break, Away from desk, Other).

### 3. Onboarding (desktop)
1. **Monitoring notice:** what is collected (check-in screenshot and webcam frame on pass only, app names, active time), when (only while clocked in; never on break or pause), who can see it (your direct manager and admins), how long it's kept (images 30 days), your rights (see and export your data). Button: "I've read this".
2. **Permissions (macOS):** Screen Recording and Camera, each with a step-by-step illustration of System Settings and a status (Granted / Not yet).
3. **Test capture:** preview of a screenshot and webcam frame, "This is what your manager sees on a check-in".
4. **Done:** "You're set. Clock in when you start work."

### 4. Manager: live team grid (web)
- Summary row: On shift 8 · Active 5 · Away 1 · On break 1 · Offline 1.
- Filters: status, team. Search.
- Rows: avatar, name, status chip with time in status ("Active · 42 min"), last check-in (time + passed/missed), today's response rate ("9 of 10"), current project, "View day" link.
- Example people: Priya Sharma (Active), Daniel Okafor (Active), Meera Iyer (In meeting), Lucas Martin (Away, missed 14:03), Aisha Khan (On break), Rohan Gupta (Active), Emily Chen (Offline 6 min), Arjun Nair (Paused).
- Empty state: "No one is on shift right now."

### 5. Manager: employee day view (web)
- Header: Lucas Martin, Tue 7 Oct, shift 09:00–18:00 (IST).
- **Timeline bar** across the shift, coloured by segment: Verified, Meeting, Idle (flagged), Unverified (flagged), Pause, Break; check-in markers (pass, miss, failed).
- **Capture viewer** for a selected check-in: screenshot(s) and webcam frame side by side, time, active app, project, and a visible note "Your view is logged and visible to Lucas".
- **Missed check-in detail:** shown 14:03, idle 11 min, screen locked, employee's reason "Phone call with client".

### 6. Manager: timesheet approval (web)
- Week of 6 Oct, status Submitted.
- Day-by-day table: worked, flagged, break, manual, project split; totals "38 h 20 min worked · 1 h 05 min flagged".
- Flagged segments list: each with Keep / Exclude, and a required reason when excluding ("Excluded edits are shown to the employee").
- Manual entry request: "Client visit, Thu 14:00–16:30, Northwind API" with Approve / Reject.
- Actions: Approve week, Return with comment.

### 7. Employee: My data (web)
- Today's timeline and check-ins with their captures.
- Missed check-ins with "Add reason".
- "Who viewed my captures": "Sarah Lee (manager) viewed 10:42 check-in · today 15:10".
- My timesheet: unassigned time to tag with projects, Submit week; manager edits with their reasons.

### 8. Admin: monitoring policy (web, optional)
Region preset (US / EU / India), check-in interval (20–90 min), response window (90 s), screenshots (Full / Blurred / Off), webcam (On / Off; in EU requires "I confirm a DPIA has been completed"), image retention (30 days), pause limits (15 min each, 60 min per day).

## Deliverables
One artboard per screen and state above, in light and dark themes, plus a small style sheet (colours, type scale, status chips, buttons). Use realistic content as written, no lorem ipsum.
