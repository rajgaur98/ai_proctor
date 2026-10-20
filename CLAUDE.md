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
- Two PRs that are green alone can break main together (one adds a struct field, the other a test that builds the struct). Before merging, merge current `main` into the branch, run the checks it touches, and push so CI runs on that result. Merge one PR at a time. Every DB PR regenerates `database.types.ts`, so on a conflict regenerate it from the merged migrations rather than hand-merging.
- Before pushing: lint, typecheck, unit tests, and a self-review of the diff. CI must be green.
- Windows code (no Windows machine yet) gets the `needs-device-test` label and a manual test checklist in the PR body; it must still compile and pass tests on the Windows CI runner. Keep going.
- Never put model names in commits, PRs or code.
- When blocked on a decision only Raj can make, add it to "Blocked on Raj" in `docs/progress.md` with the exact question, then move to the next unblocked issue.

## Autonomous runs
- When `.claude/autonomy/mode` says `on`, keep working through the open milestone issues in the order of `docs/progress.md` → "Now / Next" until none is left unblocked. A list you wrote yourself is an order, not a stopping point.
- After a restart or compaction, re-read "Now / Next" (on `origin/main`) and the open issues, then continue. Keep that block current in every PR.
- Something only Raj can do: add it to "Blocked on Raj" with the exact question, label the issue `blocked`, move on. Device steps go into one batched list for Raj.
- Deferred work always becomes an issue (sub-issue of its milestone epic, on the board). Move board cards as work moves: In progress → In review → Done.
- Run up to ~3 implementers in parallel, each in its own worktree on files that don't overlap and with its own stack (`scripts/stack.sh`); the main session reviews, merges and owns `docs/progress.md`. Two migrations that both redefine the same function (e.g. `internal.apply_event`) silently undo each other: rebase the later one on the earlier before merging.

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
- **Worktrees get their own stack** (#118): in any worktree other than the main checkout, use `scripts/stack.sh up` (own project id and ports, generated into ignored `.stack/`; each worktree claims its port block in `~/.ai_proctor-stacks/` so two never share one), `scripts/stack.sh reset|test`, `scripts/stack.sh dotenv` (writes `apps/web/.env.local`), `scripts/stack.sh types` (regenerates `database.types.ts` from this stack; `pnpm db:types` reads the main one), and `scripts/stack.sh run <cmd>` to run tests with that stack's env (e.g. `scripts/stack.sh run pnpm --filter @ai-proctor/web e2e`, `scripts/stack.sh run cargo test -p ai-proctor-agent --test sign_in_supabase`). Never `pnpm db:reset` from a worktree: that resets the shared main stack under everyone else. A running stack doesn't reload its config: `scripts/stack.sh down && scripts/stack.sh up` after changing `config.toml`. `scripts/stack.sh down` when the worktree is done.
- Agent (Tauri): `pnpm --filter @ai-proctor/agent tauri dev` (dev, with hot reload); bundled `.app` for permission tests: `pnpm --filter @ai-proctor/agent tauri build --debug`. Logs: `~/Library/Logs/com.aiproctor.agent/agent.<date>.log` (JSON lines, 7 days kept).
- Rust: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all`. The workspace is the root `Cargo.toml`: `apps/agent/src-tauri` (Tauri shell), `.../core` (logic, `Platform` trait, `FakePlatform`), `.../platform` (macOS/Windows impls). Spikes stay out of it.
- IPC contract: edit the Zod schemas in `packages/contracts/src/ipc.ts`, then `pnpm contracts:gen` (writes `packages/contracts/generated/ipc.schema.json`; the Rust core reads it at compile time via typify). CI fails if it's stale.
- Agent events contract: edit `packages/contracts/src/events.ts`, run `pnpm contracts:gen`, then `pnpm contracts:migration` (writes a migration that stores the schema in `internal.contract_schemas`; `agent_events` validates every event against it with pg_jsonschema). CI runs `pnpm contracts:check-db` to catch a missing migration.
- Agent ↔ local Supabase integration tests (sync, magic-link sign-in via Mailpit, the app's account flow): with the stack up, `eval "$(pnpm --silent supabase status -o env | grep -E '^(API_URL|ANON_KEY|MAILPIT_URL)=')"; export AI_PROCTOR_SUPABASE_URL=$API_URL AI_PROCTOR_SUPABASE_ANON_KEY=$ANON_KEY AI_PROCTOR_MAILPIT_URL=$MAILPIT_URL; cargo test -p agent-core --test sync_supabase --test auth_supabase; cargo test -p ai-proctor-agent --test sign_in_supabase`. They skip themselves without those variables.
- Running the agent against a server: it reads `AI_PROCTOR_SUPABASE_URL` / `AI_PROCTOR_SUPABASE_ANON_KEY` at run time, else the values it was compiled with (set them when building a release). Without them sign-in is off. Sign-in links open `aiproctor://auth`, which macOS only routes to a bundled app (`pnpm --filter @ai-proctor/agent tauri build --debug`), not to `tauri dev`.
- Trying the check-in card by hand: debug builds take `AI_PROCTOR_DEV_CHECKIN_S=<seconds>` (one fixed interval) instead of the 20–90 min draw. Sign in and clock in first; the card only runs while working. Screen Recording and Camera are asked for by the onboarding window (#59): it opens by itself after the notice, and the tray's "Set up permissions…" (or a permission warning's Fix) runs it again. `AI_PROCTOR_DEV_REQUEST_PERMISSIONS=1` makes a debug build ask for Accessibility (browser domains, #25) at launch; it isn't part of onboarding. Launch the bundle with `open -n "target/debug/bundle/macos/AI Proctor.app" --env AI_PROCTOR_SUPABASE_URL=… --env AI_PROCTOR_SUPABASE_ANON_KEY=… --env AI_PROCTOR_DEV_CHECKIN_S=30 --env AI_PROCTOR_DEV_REQUEST_PERMISSIONS=1`. Every ad-hoc-signed rebuild loses the macOS grants and keychain access (#108): re-grant, removing the old Screen Recording entry with "−" first.
- Status rules: `packages/core/src/status.ts` and SQL `internal.compute_status` must agree. Add cases to `packages/core/vectors/status.json`, then `pnpm core:gen` (regenerates `supabase/tests/database/status_vectors.test.sql`; CI checks it).
- Timesheet segments (#41): `time_segments` is rebuilt by the `rebuild-segments` Edge Function (cron `segments_kick` every 5 min while `dirty_days` has rows; triggers on the source tables mark the days). The function imports a generated copy of `packages/core` (`supabase/functions/_shared/core`): after editing `segments.ts` or `status.ts` run `pnpm core:fn` and commit it (`pnpm core:fn --check` is the CI check). `segments_kick` needs two Vault secrets, `project_url` and `service_role_key`: after every db reset run `scripts/stack-secrets.sh` (sets them for the stack, URL `http://kong:8000`; production sets them once at deploy, M6, never in a migration or seed). Integration check (events → function → `time_segments`, signed-in path, RLS, then the cron leg through pg_net): on a freshly reset stack with the secrets set, `pnpm it:rebuild-segments`. A function added after the stack started isn't served until the stack is restarted (`down` then `up`); `docker restart` of the edge runtime only reloads the functions it already knew.
- Agent end-to-end (macOS, local stack up): `scripts/agent-e2e.sh` builds the debug bundle and drives it unattended (launch, sign-in, clock-in, check-in card, server row) through a debug-only control socket; isolation switches are `AI_PROCTOR_DEV_DATA_DIR`, `AI_PROCTOR_DEV_KEYSTORE`, `AI_PROCTOR_DEV_CONTROL` (`apps/agent/src-tauri/tests/e2e_bundle.rs`).
- CI (`.github/workflows/ci.yml`): the single required check is **CI OK**.
- Dashboard (`apps/web`): copy `apps/web/.env.example` to `apps/web/.env.local` with the URL and anon key from `pnpm supabase status`, then `pnpm --filter @ai-proctor/web dev` (http://localhost:5173). Smoke + axe tests: `pnpm --filter @ai-proctor/web e2e` (local Supabase up; drives the installed Chrome). The invite test reads emails from Mailpit (`MAILPIT_URL`, default http://127.0.0.1:54324).
- Edge Functions (`supabase/functions`) are served by `pnpm db:start` at `/functions/v1/<name>`; Auth email templates live in `supabase/templates` (restart the stack after changing `config.toml`). The runtime serves the `supabase/functions` of the checkout the stack was started from and doesn't pick up edits: after changing a function or switching worktrees, `docker restart supabase_edge_runtime_ai_proctor` (or restart the stack from that worktree).
