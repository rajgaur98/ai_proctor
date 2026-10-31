# Design screens

Copies of the Claude Design project "AI Proctor Phase 1 canvas" (link and DesignSync
project id in `CLAUDE.md`), committed by the UI PR that first used each file, so the
reference survives standalone Claude Design closing on 14 Dec 2026.

| File | Used by |
|---|---|
| `WebNav.dc.html` | #27 dashboard shell (`apps/web/src/components/AppShell.tsx`) |
| `Tray.dc.html` | #37 tray popover (`apps/agent/src/Tray.tsx`, `tray.css`) |
| `Onboarding.dc.html` | #48 monitoring notice, step 1; #59 permissions, test capture and done, steps 2 to 4 (`apps/agent/src/notice/`) |
| `StyleSheet.dc.html` | #27 tokens, type, buttons, status chips (`apps/web/src/styles.css`, `StatusChip.tsx`) |
| `Timesheet.dc.html` | #43 manager timesheet review (`apps/web/src/features/timesheets/TimesheetPage.tsx`) |
| `MyData.dc.html` | #49 My data (`apps/web/src/features/mydata/`) |
| `Policy.dc.html` | #52 monitoring policy (`apps/web/src/features/policy/`); the other PRD section 6 settings follow in the same row style, the EU preset has the webcam Off (PRD 5.1) where the mock has it On, and the interval is a shortest/longest pair (CHK-01) rather than one slider |
| `DayView.dc.html` | #124 employee day: totals, segment bar with check-in markers, check-in detail and list (`apps/web/src/features/day/`). Deviations: active app is shown with the captures, not in the list, because it is part of the audit-logged view; the failed marker is a failed challenge (CHK-12), which has no captures |
| `TeamGrid.dc.html` | Live team grid reference (`apps/web/src/features/team/LiveTeam.tsx`, #32); committed here with the DayView PR and not changed by it. The seat view (#251, `SeatMap.tsx`) has no screen of its own: it reuses this screen's panel, filter-bar and chip styling |

The files are Claude Design component sources (`<x-dc>` markup plus a `DCLogic`
script); they need Claude Design's `support.js` to render and are kept as reference.
