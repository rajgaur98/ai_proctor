# AI Proctor

Presence verification + timesheets for remote teams (Phase 1), AI daily summaries later (Phase 2). Sole developer: Raj. Not launched; building toward a US pilot.

## Read first
- `docs/progress.md`: current status, build order, open decisions, blockers. **Update it as you work.**
- `docs/prd/phase-1-presence-and-timesheets.md`: requirements with IDs (CHK-10, TS-05…). Every change traces to an ID.
- `docs/tech-stack.md`: chosen stack, key flows, repo layout, pilot settings.
- `docs/architecture-lld.html`: modules, state machines, sync protocol, schema, access control.
- `docs/development-tracking.md`: epics, labels, branch/PR conventions.
- Issues: https://github.com/rajgaur98/ai_proctor/issues (epics #1–#7, later #62).

If an issue body and a doc disagree, **the docs win** (PRD > tech-stack > LLD > issue). Known mismatches are listed in `docs/progress.md`.

## Stack (locked; don't relitigate)
- **Agent:** Tauri v2. Rust core + `Platform` trait (macOS via objc2, Windows via windows-rs, `FakePlatform` for tests), React UI. Encrypted SQLite outbox (rusqlite + AES-GCM, key in OS keychain). reqwest + rustls. Sign-in via system browser + PKCE + `aiproctor://` deep link.
- **Backend:** Supabase (Postgres RLS, RPC functions, Auth, Storage, Realtime, pg_cron, Edge Functions in Deno). US region only.
- **Dashboard:** React + Vite SPA, TanStack Router/Query/Table, Tailwind + shadcn/ui, Recharts, React Hook Form + Zod, Luxon. Hosted on Cloudflare Pages.
- **Shared:** `packages/core` (status rules, `buildSegments()`, pure TS), `packages/contracts` (Zod → JSON Schema → Rust serde), `packages/ui`.
- **Tooling:** pnpm workspaces, TypeScript strict, Biome, Vitest + fast-check, Playwright, cargo clippy/fmt. Turborepo only if builds get slow.
- **Ops:** Resend (email), Sentry + Better Stack, Cloudflare R2 (updates + backups), GitHub Actions.

## Rules that matter
- The agent reports raw state only. Status and timesheets are computed server-side / in `packages/core`.
- Check-in event first, upload after ack. Storage policy only accepts files for a recorded passed check-in in the caller's own folder.
- Misses never capture anything. Pauses collect nothing.
- No rounding: store seconds, round only for display; totals from raw seconds.
- Flagged time is never auto-deducted; anti-cheat flags are "needs review", never penalties.
- Next check-in time is never exposed to the UI.
- Every capture view, policy change, timesheet edit and export is audit-logged.

## Workflow
- A new session, or a session given a handoff, first replies with its understanding and plan and waits for Raj's go-ahead. No installs, branches or code before that.
- One issue → one branch → one PR. Branch: `<issue>-<short-name>` (e.g. `21-capture-pipeline`). PR body has `Closes #<n>` and the PRD IDs covered.
- PRs are **stacked**: each targets the previous branch in its milestone stack. Rebase the rest of the stack after a lower PR merges.
- Before pushing: lint, typecheck, unit tests, and a self-review of the diff. CI must be green.
- Platform code that can't be run where you are (macOS UI/permissions from Linux, anything on Windows) gets the `needs-device-test` label and a manual test checklist in the PR body; keep going.
- Never put model names in commits, PRs or code.
- When blocked on a decision only Raj can make, add it to "Blocked on Raj" in `docs/progress.md` with the exact question, then move to the next unblocked issue.

## Where sessions run
- **Cloud (claude.ai/code, Linux):** backend, dashboard, `packages/*`, cross-platform agent core. Docker is available for `supabase start`.
- **Local (Claude desktop on Raj's Mac):** macOS spikes (#11, #13, #14 macOS parts) and macOS platform code. Needs Screen Recording permission for the Claude app; Raj clicks OS permission prompts.

## Commands
Not scaffolded yet (issue #8). Fill this section in when it lands: install, dev, lint, typecheck, test, `supabase start`, agent dev build.
