# AI Proctor (working name)

Presence verification, timesheets and (later) AI daily work summaries for remote and distributed teams.

- **Phase 1 — Presence & timesheets:** random check-ins with screenshot + webcam evidence, live manager dashboard, weekly timesheets with manager approval. See [PRD](docs/prd/phase-1-presence-and-timesheets.md).
- **Phase 2 — AI daily summaries:** Google Meet–style summaries of each employee's day, reviewed by the employee before managers see them.

**Docs:** [Phase 1 PRD](docs/prd/phase-1-presence-and-timesheets.md) · [Tech stack & costs](docs/tech-stack.md) · [Architecture diagrams](docs/architecture/README.md) (draw.io: system and component views) · [LLD details](docs/architecture-lld.html) ([rendered](https://claude.ai/artifact/2SHRyNKxu1rGN557mYtvCY)) · [Development tracking](docs/development-tracking.md)

## Run locally

Needs Node 22 (`.nvmrc`), pnpm via corepack (`corepack enable pnpm`), Rust via rustup (`rust-toolchain.toml` pins the version) and Docker for the local Supabase stack.

```bash
pnpm install
pnpm lint        # Biome lint + format check (fix with pnpm format)
pnpm typecheck   # tsc in every package
pnpm test        # Vitest in every package
```

Layout: `apps/agent` (Tauri v2 desktop agent), `apps/web` (dashboard), `packages/core` (status rules, segment engine), `packages/contracts` (shared Zod schemas), `packages/ui` (shared components), `supabase/` (migrations, functions, seed). The apps and the Supabase stack arrive in later issues (#9, #15, #27).
