# AI Proctor

Presence verification + timesheets for remote teams (Phase 1), AI daily summaries later (Phase 2). Sole developer: Raj. Not launched; building toward a US pilot.

## Read first
- `docs/handoff/mac-session.md`: how this local session works (read once).
- `docs/progress.md`: current status, build order, open decisions, blockers. **Update it as you work.**
- `docs/prd/phase-1-presence-and-timesheets.md`: requirements with IDs (CHK-10, TS-05…). Every change traces to an ID.
- `docs/tech-stack.md`: chosen stack, key flows, repo layout, pilot settings.
- `docs/architecture-lld.html`: modules, state machines, sync protocol, schema, access control.
- `docs/development-tracking.md`: epics, labels, branch/PR conventions.
- Issues: https://github.com/rajgaur98/ai_proctor/issues (epics #1–#7, later #62).
- UI design (Claude Design, file "AI Proctor Phase 1.dc.html"): https://claude.ai/design/p/2d6757e9-b833-4f16-829e-c2c507023b77?file=AI+Proctor+Phase+1.dc.html. Read it with the `DesignSync` tool (project `2d6757e9-b833-4f16-829e-c2c507023b77`; one file per screen: `CheckIn`, `Tray`, `Onboarding`, `TeamGrid`, `DayView`, `Timesheet`, `MyData`, `Policy`, plus `StyleSheet` and `WebNav`). Each UI PR commits a copy of the screen files it used under `docs/design/`, because standalone Claude Design closes on 14 Dec 2026. It's the visual reference for the dashboard, tray popover and check-in card; the brief it came from is `docs/design/phase-1-design-brief.md`.

If an issue body and a doc disagree, **the docs win** (PRD > tech-stack > LLD > issue). Known mismatches are listed in `docs/progress.md`.

## Stack (locked; don't relitigate)
- **Agent:** Tauri v2. Rust core + `Platform` trait (macOS via objc2, Windows via windows-rs, `FakePlatform` for tests), React UI. Encrypted SQLite outbox (rusqlite + AES-GCM, key in OS keychain). reqwest + rustls. Sign-in via system browser + PKCE + `aiproctor://` deep link.
- **Backend:** Supabase (Postgres RLS, RPC functions, Auth, Storage, Realtime, pg_cron, Edge Functions in Deno). US region only.
- **Dashboard:** React + Vite SPA, TanStack Router/Query/Table, Tailwind + shadcn/ui, Recharts, React Hook Form + Zod, Luxon. Hosted on Cloudflare Pages.
- **Shared:** `packages/core` (status rules, `buildSegments()`, pure TS), `packages/contracts` (Zod → JSON Schema → Rust serde), `packages/ui`.
- **Tooling:** pnpm workspaces, TypeScript strict, Biome, Vitest + fast-check, Playwright, cargo clippy/fmt. Turborepo for task running.
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
- Windows code (no Windows machine yet) gets the `needs-device-test` label and a manual test checklist in the PR body; it must still compile and pass tests on the Windows CI runner. Keep going.
- Never put model names in commits, PRs or code.
- When blocked on a decision only Raj can make, add it to "Blocked on Raj" in `docs/progress.md` with the exact question, then move to the next unblocked issue.

## Where development runs
All development runs in a **local Claude desktop session on Raj's Mac** (`docs/handoff/mac-session.md`). The earlier cloud session only did planning and docs.
- Docker (OrbStack or Docker Desktop) for `supabase start`; Rust, Node 22, pnpm, Tauri CLI, Xcode command line tools.
- The Claude app needs Screen Recording permission so you can verify UI with `screencapture`. App permission prompts (Screen Recording, Camera) are clicked by Raj; test them on a bundled `.app`, not a binary launched from your shell (it inherits Claude's permissions).
- When something needs Raj physically (open an app, click, approve a prompt), stop and give numbered steps.

## Commands
Toolchain on Raj's Mac: Node 22 is asdf's (`.nvmrc`), Rust is Homebrew's rustup (pinned by `rust-toolchain.toml`). The shell's default `node` is an older nvm one, so prepend both:
`export PATH="$HOME/.asdf/installs/nodejs/22.21.1/bin:/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"`

- Install: `pnpm install`
- Lint + format check: `pnpm lint` (fix: `pnpm format`)
- Typecheck: `pnpm typecheck` (Turborepo runs `tsc` in every package)
- Test: `pnpm test` (Turborepo runs Vitest in every package)
- Local backend (Docker must be running): `pnpm db:start` / `pnpm db:stop`; rebuild from migrations + seed: `pnpm db:reset`; pgTAP tests: `pnpm db:test`; regenerate `packages/contracts/src/database.types.ts`: `pnpm db:types` (commit it with the migration). Any other CLI command: `pnpm supabase <args>`. Seed users (`supabase/seed.sql`) sign in with `password123`.
- New migration: `pnpm supabase migration new <name>`.
- Not yet: agent dev build (#15), dashboard dev (#27).
