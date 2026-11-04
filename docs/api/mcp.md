# AI assistants (MCP server)

Ask Claude, ChatGPT and other AI assistants about your AI Proctor data: who is working right
now, how someone's day went, which timesheets are waiting for you, hours by client or project,
and recent alerts. AI Proctor runs a remote [MCP](https://modelcontextprotocol.io) server that
assistants connect to (PRD API-07, API-08; issue #307).

- **Read-only.** Assistants can't change anything. Write tools (approve or return a timesheet,
  request a manual entry, add a miss reason) come later.
- **Each person signs in as themselves.** The assistant sees exactly what that person sees in
  the dashboard: an employee only their own data, a manager their reports, an owner or admin
  the whole organization (with an MFA session when the org requires MFA for admins).
- **Never:** screenshots, webcam frames, links to them, window titles, websites, when the next
  check-in is, anti-cheat flags or tamper reasons, or the free text people write (miss
  remarks, comments, manual entry reasons). A missed check-in comes with the reason the
  person picked (meeting, phone call, break, away, other).
- **Audited.** Turning access on or off and every question an assistant asks (the person, the
  tool, its arguments, the rows returned, which assistant) are in the audit log.

## Turn it on (owners and admins)

AI assistant access is **off** until an owner or admin turns it on: **Settings → API → AI
assistants → Allow AI assistant access**. While it is off, assistants can't connect and every
tool call is refused with a message saying so.

The monitoring notice says when it is on (ADM-06). If your notice still uses the template
text, turning access on or off publishes a new notice version and everyone acknowledges it
again. If an admin wrote their own notice text, it isn't changed: the page asks you to update
it on the Notice page.

## Connect an assistant

The server URL is shown on Settings → API once access is on:

```
<backend URL>/functions/v1/mcp
```

(locally `http://127.0.0.1:54321/functions/v1/mcp`; a worktree stack uses its own port.)

The assistant opens AI Proctor in the browser; the person signs in (if they aren't already),
sees which assistant is asking and where it sends them back to, and selects **Allow**.

- **Claude (claude.ai and the desktop app):** Settings → Connectors → Add custom connector →
  paste the URL → Connect. On Team and Enterprise plans an owner adds the connector for the
  organization first.
- **Claude Code:** `claude mcp add --transport http ai-proctor <URL>`, then `/mcp` to sign in.
- **ChatGPT:** add a custom connector (developer mode) with the URL and OAuth authentication.
- **Cursor, VS Code and other clients:** add a remote (Streamable HTTP) MCP server with the URL.
  Clients that support MCP authorization register themselves and open the sign-in page.
- **MCP Inspector** (for testing): `npx @modelcontextprotocol/inspector`, transport
  "Streamable HTTP", the URL, then its OAuth flow.

To disconnect, remove the connector in the assistant. An admin turning access off stops every
assistant at once (tokens are not refreshed and every call is refused).

## Tools

All tools are read-only (`readOnlyHint`). Dates are `YYYY-MM-DD`; a person's day is their own
calendar day in their time zone. Durations are exact seconds (never rounded). Flagged time
needs review; it is never deducted.

| Tool | What it returns |
| --- | --- |
| `list_people` | People you can see, by name, team, manager or role, with their id, role, team, manager and time zone. Other tools take these ids. |
| `who_is_on_shift` | Who is clocked in now and their live status (DSH-01): status and since when, last check-in result, project, today's check-ins shown and passed. Optionally by team or status, or including people off shift and on leave. |
| `get_person_day` | One person's day: worked, flagged, excluded, manual, break and pause seconds; time segments with project and task; check-ins (outcome, shown and answered times, response time, miss reason); top apps by time (names and seconds). |
| `list_timesheets` | Weekly timesheets with status, approver and the week's seconds. One week (default this week) lists everyone you see, including timesheets not started; `waiting_for_my_approval` lists the submitted weeks you can approve or return. |
| `hours_report` | Worked and flagged seconds for a date range (up to 366 days), by person, team, client, project or task (DSH-07, DSH-10), from the Reports page's numbers. |
| `list_alerts` | Manager alerts you can see (consecutive misses, offline, tamper, late clock-in, pause over the cap), newest first; the last 7 days by default. Never alerts about yourself. |

Not built yet: insights metrics (INS, #305) and write tools.

Errors come back as tool results the assistant reads (`isError: true`) with a code in
brackets: `invalid_param` (names the argument), `not_found` (no such person, or not someone
you can see), `ai_assistant_access_off`, `rate_limited` (60 tool calls a minute per person; the
message says when to retry).

## How it works

- **Transport:** Streamable HTTP, JSON responses only (no SSE stream, no sessions). Methods:
  `initialize`, `ping`, `tools/list`, `tools/call`. Protocol versions 2025-11-25, 2025-06-18
  and 2025-03-26. One JSON-RPC message per request (no batches).
- **Authorization (MCP spec, OAuth 2.1):** a request without a valid token gets `401` with
  `WWW-Authenticate: Bearer resource_metadata="<URL>/.well-known/oauth-protected-resource"`.
  That document (RFC 9728) names Supabase Auth (`<backend URL>/auth/v1`) as the authorization
  server; its metadata is at `<backend URL>/auth/v1/.well-known/oauth-authorization-server`
  (and the OpenID configuration next to it). Clients register with dynamic client
  registration, use the authorization code flow with PKCE (S256), and send the person to the
  dashboard's consent page, `/oauth/consent`. Scope: `email`.
- **Tokens:** the server checks the token with Auth and accepts only tokens Auth issued to an
  OAuth client (they carry `client_id`); a dashboard session token is refused. Such a token is
  good for the MCP server only: the access token hook gives it the role `ai_assistant`, which
  the REST API, Storage and Realtime refuse, and the Edge Functions that take a person's token
  refuse it too. While the org's access is off, Auth issues and refreshes no assistant tokens.
- **Database:** `public.mcp_call` (service role only) runs each tool as the person, with the
  same access rules as the dashboard (`can_view_user()`), and writes the `mcp.tool_call` audit
  row (`supabase/migrations/20261105600000_mcp_server.sql`). Tool definitions:
  `supabase/functions/mcp/tools.ts`.

## Deploying (M6)

- Supabase project: Authentication → OAuth Server: on, dynamic client registration on,
  authorization path `/oauth/consent`; Site URL is the dashboard's URL (the consent page lives
  there). Locally these are `[auth.oauth_server]` and `site_url` in `supabase/config.toml`.
- Deploy the `mcp` function with JWT verification off (it checks tokens itself).
- If the server is reached through a custom domain, set the function secret `MCP_PUBLIC_URL`
  to that origin so the resource metadata names the URL people connect to.

## Known limits

- Supabase Auth issues assistants ordinary session tokens. Besides the MCP server, such a token
  also works on Auth's own endpoints for the person's account (for example changing their
  password or adding an MFA factor) until it expires. The dashboard's consent page names the
  assistant and where it returns to, and nobody can connect while the org's access is off.
- In an org that requires MFA for admins, an owner's or admin's assistant gets the org-wide
  view only when its token carries an MFA level (aal2); otherwise it sees like a non-MFA
  session (themselves and their direct reports). Whether Supabase Auth issues aal2 assistant
  tokens after an MFA sign-in isn't verified yet, and the consent page doesn't ask for MFA.
- People can't yet see or revoke their connected assistants on the dashboard; they remove the
  connector in the assistant.
