# Design screens

Copies of the Claude Design project "AI Proctor Phase 1 canvas" (link and DesignSync
project id in `CLAUDE.md`), committed by the UI PR that first used each file, so the
reference survives standalone Claude Design closing on 14 Dec 2026.

| File | Used by |
|---|---|
| `WebNav.dc.html` | #27 dashboard shell (`apps/web/src/components/AppShell.tsx`) |
| `Tray.dc.html` | #37 tray popover (`apps/agent/src/Tray.tsx`, `tray.css`) |
| `Onboarding.dc.html` | #48 monitoring notice window, step 1 (`apps/agent/src/notice/`); steps 2 to 4 arrive with #59 |
| `StyleSheet.dc.html` | #27 tokens, type, buttons, status chips (`apps/web/src/styles.css`, `StatusChip.tsx`) |

The files are Claude Design component sources (`<x-dc>` markup plus a `DCLogic`
script); they need Claude Design's `support.js` to render and are kept as reference.
