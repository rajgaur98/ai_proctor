# Tech Stack — Phase 1 Pilot

| | |
|---|---|
| **Status** | Decided for pilot (v1.0) |
| **Last updated** | 2026-10-07 |
| **Applies to** | [Phase 1 PRD](prd/phase-1-presence-and-timesheets.md) |
| **Guiding principle** | Speed to first pilot and low cost, without risking customer data |

---

## 1. Decisions

| Layer | Choice | Why |
|---|---|---|
| Desktop agent | **Electron** (TypeScript) + a small native module | Covers almost every agent requirement in JS; fastest path to a working agent on Windows and macOS |
| Backend | **Supabase Pro** (Postgres, Auth, Storage, Realtime, pg_cron, Edge Functions), US region | Replaces a custom API, auth, Redis, WebSocket gateway and infra-as-code; daily backups and managed security |
| Business logic | **Postgres RPC functions** (agent writes) + **Edge Functions** (segment engine, emails, exports) | No separate server to run during the pilot |
| Shared logic | **`packages/core`** (pure TypeScript): status rules, segment engine, policy defaults | One implementation used by the dashboard, Edge Functions and agent |
| Dashboard | **React + Vite SPA**, TanStack Router/Query/Table, Tailwind + shadcn/ui | Login-only app, no server rendering needed |
| Dashboard hosting | **Cloudflare Pages** | Free static hosting |
| Agent update hosting | **Cloudflare R2** (public bucket) | Free tier, no egress fees |
| Email | **Resend** (free tier) | Alerts, reminders, invites |
| Errors & logs | **Sentry** (free) + **Better Stack** (free) | Agent, dashboard and Edge Functions |
| CI | **GitHub Actions** (free minutes); macOS release builds on a local Mac | macOS CI minutes are expensive |
| Region | **US only** during pilots | EU deployment created when the first EU customer signs |

---

## 2. Pilot architecture

```
┌──────────────────── Desktop agent (Electron) ─────────────────────┐
│ main process (TS): scheduler · session state · offline queue ·    │
│   sync · auto-update · powerMonitor (idle, lock, sleep)           │
│ check-in card window · hidden capture window (screen + webcam)    │
│ native module (napi-rs): camera/mic in use · injected input ·     │
│   screen-share heuristics                                         │
└───────┬──────────────────────────────────────────┬────────────────┘
        │ supabase-js → PostgREST RPC              │ signed upload URL
        │ heartbeat (60 s) · events (immediate)    │ (WebP images)
        ▼                                          ▼
┌──────────────────────── Supabase (US East) ───────────────────────┐
│ Postgres + RLS                       Storage: private "captures"  │
│   rpc: agent_heartbeat, agent_events,  bucket, path               │
│        clock_in/out, start_break/pause  {org}/{user}/{date}/...   │
│   tables: presence, last_seen, checkin_events, time_segments, ... │
│ pg_cron (every minute): offline sweep · alert queue               │
│ pg_cron + pg_net → Edge Functions:                                │
│   rebuild-segments (every 5 min + on demand) · send-emails ·      │
│   export-timesheet · capture-url (audit log + signed URL) ·       │
│   retention-purge (nightly)                                       │
│ Auth: Google, Microsoft, email/password, TOTP MFA                 │
│ Realtime: presence changes only                                   │
└───────┬───────────────────────────────────────────────────────────┘
        │ supabase-js (REST + Realtime)
        ▼
 Manager / employee dashboard — React SPA on Cloudflare Pages
```

### Key flows

**Heartbeats and status**
1. The agent calls `agent_heartbeat()` every 60 s. It updates `last_seen` only (this table is not published over Realtime).
2. State changes (idle, lock, call, break, pause, check-in outcome) are sent immediately through `agent_events()` and update the `presence` row.
3. The dashboard subscribes to `presence` changes and computes the displayed status in the browser using `packages/core` rules.
4. A pg_cron job every minute marks users Offline when `last_seen` is older than 3 min.

**Check-in with captures**
1. The agent records the check-in outcome locally first (works offline).
2. On a pass, the hidden capture window grabs the screenshot(s) and webcam frame, downscales them and encodes WebP in a canvas.
3. The agent uploads to `captures/{org}/{user}/{date}/{checkin_id}/…` (storage RLS only allows writes to the user's own path), then sends the event with the object keys.
4. Misses send an event only, with no capture.

**Viewing a capture**
The dashboard never reads the bucket directly. It calls the `capture-url` Edge Function, which checks the viewer may see that employee, writes the audit log entry, and returns a signed URL valid for ≤ 5 min.

**Timesheets**
`rebuild-segments` runs `buildSegments()` from `packages/core` for every user-day that changed since the last run (new events, late offline sync, manager edits), and on demand when a timesheet is opened. The result is written to `time_segments`. It is deterministic: rebuilding the same day always gives the same result.

**Offline sync**
Every event carries a client-generated UUID and device timestamp. `agent_events()` is idempotent (`ON CONFLICT DO NOTHING`), so the agent can safely resend a batch after a dropped connection. The server stores its own receive time to correct for device clock skew.

---

## 3. Desktop agent (Electron)

| Requirement | Implementation |
|---|---|
| Check-in card on top, no focus stealing | `BrowserWindow` with `type: 'panel'` (macOS), `focusable: false`, `alwaysOnTop` at `'screen-saver'` level, `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`, frameless, `skipTaskbar`. **Verify in week-1 spike** that the first click registers without focusing the window on both OSes |
| Screenshots | `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })`, one per display |
| Webcam frame | `getUserMedia` in a hidden window → draw one frame to canvas → stop all tracks immediately |
| Encoding & blur | Canvas `toBlob('image/webp', 0.6)`; blur via canvas `filter`. Max 1280 px wide; webcam 320×240. No native image library needed |
| Permissions | `systemPreferences.getMediaAccessStatus('screen' \| 'camera')`, `askForMediaAccess('camera')`; guided flow for Screen Recording |
| Idle, lock, sleep | `powerMonitor.getSystemIdleTime()`, `lock-screen` / `unlock-screen` / `suspend` / `resume` events |
| Active app, window title | `get-windows` package (macOS needs Screen Recording permission for titles) |
| Camera/mic in use, injected input, screen-share detection | **Native module** written with napi-rs (Rust). macOS: CoreMediaIO / CoreAudio "device in use"; Windows: capability access manager registry keys, low-level mouse hook `LLMHF_INJECTED` |
| Offline queue | `better-sqlite3`; sensitive fields and pending images encrypted with a key protected by Electron `safeStorage` (OS keychain) |
| Auth | Browser sign-in with PKCE → deep link back (`aiproctor://auth`) → Supabase session; refresh token stored via `safeStorage` |
| Auto-launch & watchdog | `app.setLoginItemSettings`; macOS LaunchAgent with `KeepAlive`; Windows scheduled task at logon with restart-on-failure. Heartbeat gaps during clock-in are flagged as Tamper |
| Packaging & updates | `electron-builder` → MSI (Windows), PKG + DMG (macOS); `@electron/notarize`; `electron-updater` from R2 with staged rollout channels |
| Security | `contextIsolation: true`, `sandbox: true`, no `nodeIntegration` in renderers; strict preload API; never ship the Supabase service-role key |
| Footprint target | RAM < 250 MB, average CPU < 1% |

---

## 4. Backend (Supabase)

| Area | Detail |
|---|---|
| Environments | **Local**: `supabase start` (Docker). **Staging**: free Supabase project (may pause when unused). **Production**: Supabase Pro, US East |
| Schema & migrations | `supabase/migrations/*.sql` via Supabase CLI; generated TS types (`supabase gen types typescript`) used by dashboard, agent and Edge Functions |
| Tenant isolation | RLS on every table keyed by `org_id`; manager access via `manager_id` + active delegations, expressed in SQL helper functions (`can_view_user(viewer, target)`) |
| Agent writes | Only through `SECURITY DEFINER` RPC functions that validate device, user, clock state and payload. Agents never write tables directly |
| Device revocation | `devices.revoked_at`; every agent RPC checks it. Admin deactivation also revokes the user's Supabase sessions |
| Storage | Private `captures` bucket. Insert allowed only to the caller's own path; reads only via `capture-url` |
| Realtime | Postgres Changes on `presence` for the pilot. Move to broadcast-from-database when concurrent managers grow |
| Scheduled jobs | pg_cron: offline sweep (1 min), alert evaluation (1 min), segment rebuild trigger (5 min), retention purge (nightly). Edge Functions invoked via `pg_net` |
| Edge Functions (Deno, TS) | `rebuild-segments`, `send-emails` (Resend), `export-timesheet` (CSV + XLSX via SheetJS), `capture-url`, `retention-purge` (deletes storage objects through the Storage API, then rows) |
| Backups | Supabase Pro daily backups, plus a weekly `pg_dump` to R2 from a scheduled GitHub Action as an off-platform copy |

---

## 5. Dashboard

| Concern | Choice |
|---|---|
| App | React + Vite SPA, TanStack Router + Query |
| UI | Tailwind + shadcn/ui; TanStack Table for grids |
| Day timeline | Custom SVG component |
| Charts | Recharts |
| Forms | react-hook-form + Zod |
| Time zones | Luxon. Store UTC + employee IANA time zone |
| Data | `supabase-js` (REST + Realtime), typed from generated DB types |
| Hosting | Cloudflare Pages |
| Tests | Vitest, Playwright |

---

## 6. Repository layout

```
ai_proctor/
├─ apps/
│  ├─ agent/          Electron (main, preload, renderer: tray, onboarding, check-in card)
│  │  └─ native/      napi-rs module (camera/mic in use, injected input)
│  └─ web/            Dashboard SPA
├─ packages/
│  ├─ core/           Status rules, segment engine, policy defaults (pure TS, property-tested)
│  ├─ contracts/      Zod schemas for RPC payloads and events
│  └─ ui/             Shared React components (dashboard + agent renderer)
├─ supabase/
│  ├─ migrations/     SQL schema, RLS policies, RPC functions, pg_cron jobs
│  └─ functions/      Edge Functions
└─ docs/
```

Tooling: pnpm workspaces + Turborepo, TypeScript strict, Biome (lint + format), Vitest + fast-check, Playwright.

---

## 7. Pilot settings

| Setting | Pilot value | PRD reference |
|---|---|---|
| Heartbeat interval | 60 s | STS-01 |
| Offline threshold | 3 min | STS rules, §6 |
| Screenshot | Max 1280 px wide, WebP q≈60, ~100 KB | CAP-06 |
| Webcam frame | 320×240, ~15 KB | CAP-06 |
| Image retention for pilot orgs | 14 days (PRD default 30; configurable) | ADM-03 |
| Data region | US only | ORG-02, NFR-DATA-01 |

---

## 8. Costs

List prices at time of writing; verify on the providers' pricing pages before budgeting.

### Monthly (pilot, up to ~200 users)

| Item | Cost |
|---|---|
| Supabase Pro (includes compute credit covering a Micro instance, ~8 GB DB, ~100 GB storage, daily backups) | ~$25 |
| Supabase staging (free project) | $0 |
| Cloudflare Pages (dashboard) + R2 (agent updates, backups) | $0 |
| Resend, Sentry, Better Stack free tiers | $0 |
| GitHub Actions (free minutes; macOS builds local) | $0 |
| **Infrastructure total** | **~$25/month** |

Expect to upgrade the Supabase compute instance (roughly +$15/month for Small) once database CPU stays above ~50%, likely around 100–200 active users.

### Fixed

| Item | Cost |
|---|---|
| Apple Developer Program | $99/year |
| Windows code signing | ~$10/month (Azure Trusted Signing, if eligible) or ~$100–300/year (OV certificate with cloud signing) |
| Domain | ~$10–15/year |

**All-in pilot estimate: ~$35–55/month.**

### Credits to apply for
AWS Activate, Microsoft for Startups, Google for Startups Cloud, Cloudflare for Startups. Eligibility and amounts vary.

---

## 9. Scaling triggers

| Trigger | Action |
|---|---|
| ~300–500 active users, or DB CPU consistently high from heartbeats | Move heartbeat ingestion to a small dedicated service (in-memory presence, batched writes). The agent already calls our own API domain, so no agent change |
| Many managers online at once / Realtime limits approached | Switch from Postgres Changes to broadcast-from-database |
| First EU customer signs | Create an EU Supabase project (Frankfurt); add org → region directory for login and agent enrollment |
| Customer asks for SOC 2 report or SSO (SAML) | Supabase Team plan; add SSO provider |
| RAM footprint becomes a sales objection | Port the agent to Tauri; `packages/core` and the dashboard are unaffected |
| ~5,000 users or enterprise infra requirements | Evaluate moving to AWS (Postgres + S3-compatible storage make this a migration, not a rewrite) |

---

## 10. Week-1 spike (de-risk before building)

Prove on Windows 11 and the latest macOS, with two monitors:
1. Check-in card above a full-screen app, never takes keyboard focus, first click registers.
2. Screenshot of each display; detect when Screen Recording permission is revoked.
3. One webcam frame in < 1 s, camera released immediately (webcam light off).
4. Detect camera/mic in use by Zoom, Meet (browser) and Teams; detect screen lock.
5. Signed upload to Supabase Storage and an idempotent `agent_events()` call from the agent.

If item 1 fails with Electron windows, render the card from the native module instead.
