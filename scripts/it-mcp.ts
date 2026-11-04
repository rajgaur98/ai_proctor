// Integration check for the MCP server (#307; API-07, API-08, AUD-01) against a local stack,
// over HTTP through the mcp Edge Function and Supabase Auth's OAuth server: discovery
// (401 + WWW-Authenticate, Protected Resource Metadata, Auth's metadata), dynamic client
// registration, the consent API the dashboard's consent page uses, the token exchange with
// PKCE, the org switch (no tokens and no tool calls while it is off; only owners and admins
// change it; audit-logged; the notice mentions it), assistant tokens refused everywhere
// but the MCP server, the JSON-RPC surface, every tool for an owner, a manager and an
// employee (each sees only what the dashboard shows them), the fields no tool returns,
// the audit rows and the rate limit. Run it through `pnpm it:mcp`; it can run again on the same
// database.
//
// Needs AI_PROCTOR_SUPABASE_URL, AI_PROCTOR_SUPABASE_ANON_KEY and
// AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY (the wrapper script sets them).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const url = process.env.AI_PROCTOR_SUPABASE_URL ?? "";
const anon = process.env.AI_PROCTOR_SUPABASE_ANON_KEY ?? "";
const service = process.env.AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !anon || !service) {
  console.error("Set AI_PROCTOR_SUPABASE_URL, _ANON_KEY and _SERVICE_ROLE_KEY (pnpm it:mcp).");
  process.exit(2);
}

const ORG = "00000000-0000-4000-8000-000000000001";
const ADA = "00000000-0000-4000-8000-0000000000a1";
const MAX = "00000000-0000-4000-8000-0000000000b1";
const ERIN = "00000000-0000-4000-8000-0000000000c1";
const LUCAS = "00000000-0000-4000-8000-0000000000c2";
const REVAMP = "00000000-0000-4000-8000-0000000000f1";
const MCP = `${url}/functions/v1/mcp`;
const RUN = Date.now().toString(36);
const REDIRECT = "http://localhost:9876/callback";

type Json = Record<string, unknown>;

function parse(text: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** PostgREST / Auth / Storage / Functions with a bearer token. */
async function rest(
  path: string,
  token: string,
  init: { method?: string; body?: unknown; prefer?: string } = {},
) {
  const res = await fetch(`${url}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      apikey: anon,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? parse(text) : null) as unknown, text };
}

async function signIn(email: string) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `sign in ${email}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const b64url = (b: Buffer) => b.toString("base64url");

// Discovery --------------------------------------------------------------------------------

let res = await fetch(MCP, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
assert.equal(res.status, 401, "no token: 401");
const challenge = res.headers.get("www-authenticate") ?? "";
const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
assert.ok(metadataUrl, `the 401 names the resource metadata: ${challenge}`);
assert.match(challenge, /^Bearer /, "a Bearer challenge");

res = await fetch(metadataUrl);
assert.equal(res.status, 200, "Protected Resource Metadata");
const prm = (await res.json()) as {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
};
assert.equal(prm.resource, MCP, "the resource is the MCP endpoint people connect to");
assert.deepEqual(
  prm.authorization_servers,
  [`${url}/auth/v1`],
  "Supabase Auth is the authorization server",
);
assert.deepEqual(prm.bearer_methods_supported, ["header"]);

// RFC 8414 for an issuer with a path: the path-appended form is what the local gateway
// routes (hosted Supabase also serves the path-inserted one).
res = await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`);
assert.equal(res.status, 200, "Auth's metadata");
const as = (await res.json()) as {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported: string[];
};
assert.equal(as.issuer, prm.authorization_servers[0], "the issuer matches");
assert.ok(as.registration_endpoint, "dynamic client registration is on");
assert.ok(as.code_challenge_methods_supported.includes("S256"), "PKCE S256");

// OAuth: register, authorize, consent, token ------------------------------------------------

async function register(name: string) {
  const r = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(r.status, 201, `register ${name}`);
  return ((await r.json()) as { client_id: string }).client_id;
}

/** The OAuth flow an assistant runs, with the person approving on the consent API the
 * dashboard's /oauth/consent page calls. Returns the token response, or the failed one. */
async function connect(email: string, clientId: string) {
  const verifier = b64url(randomBytes(32));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state: RUN,
    scope: "email",
    resource: MCP,
  });
  const authorize = await fetch(`${as.authorization_endpoint}?${q}`, { redirect: "manual" });
  assert.equal(authorize.status, 302, "authorize redirects to the consent page");
  const consentPage = new URL(authorize.headers.get("location") ?? "");
  assert.equal(consentPage.pathname, "/oauth/consent", "the dashboard's consent page");
  const authorizationId = consentPage.searchParams.get("authorization_id") ?? "";
  assert.ok(authorizationId, "with an authorization id");

  const session = await signIn(email);
  const details = await rest(`/auth/v1/oauth/authorizations/${authorizationId}`, session);
  assert.equal(details.status, 200, `authorization details: ${details.text}`);
  // Someone who already approved this assistant goes straight back to it (the consent page
  // redirects at once); otherwise they approve.
  let redirectUrl = (details.json as { redirect_url?: string }).redirect_url;
  if (!redirectUrl) {
    assert.equal(
      (details.json as { client: { id: string } }).client.id,
      clientId,
      "the assistant asking",
    );
    const consent = await rest(
      `/auth/v1/oauth/authorizations/${authorizationId}/consent`,
      session,
      {
        body: { action: "approve" },
      },
    );
    assert.equal(consent.status, 200, `approve: ${consent.text}`);
    redirectUrl = (consent.json as { redirect_url: string }).redirect_url;
  }
  const back = new URL(redirectUrl);
  assert.equal(back.searchParams.get("state"), RUN, "the state comes back");
  const token = await fetch(as.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  const body = parse(await token.text());
  return {
    status: token.status,
    body,
    access: body.access_token as string,
    refresh: body.refresh_token as string,
  };
}

const claude = await register(`IT Claude ${RUN}`);
const adminSession = await signIn("admin@acme.test");
const managerSession = await signIn("manager@acme.test");

// The switch is off by default (a rerun on the same database turns it off first): no
// assistant gets a token.
let org = await rest(`/rest/v1/orgs?id=eq.${ORG}&select=ai_assistant_access`, adminSession);
if ((org.json as Json[])[0]?.ai_assistant_access) {
  await rest("/rest/v1/rpc/set_ai_assistant_access", adminSession, { body: { p_enabled: false } });
  org = await rest(`/rest/v1/orgs?id=eq.${ORG}&select=ai_assistant_access`, adminSession);
}
assert.deepEqual(org.json, [{ ai_assistant_access: false }], "AI assistant access is off");
const offToken = await connect("manager@acme.test", claude);
assert.ok(offToken.status >= 400, `no token while access is off: ${offToken.status}`);
assert.ok(!offToken.access, "no access token");

// Only owners and admins turn it on; it is audit-logged and the notice says so.
const notices = async () =>
  (await rest(`/rest/v1/notices?org_id=eq.${ORG}&select=version,body&order=version.desc`, service))
    .json as { version: number; body: { who: string } }[];
const before = await notices();
let r = await rest("/rest/v1/rpc/set_ai_assistant_access", managerSession, {
  body: { p_enabled: true },
});
assert.equal(r.status, 403, "a manager can't turn it on");
r = await rest("/rest/v1/rpc/set_ai_assistant_access", adminSession, { body: { p_enabled: true } });
assert.equal(r.status, 200, `the owner turns it on: ${r.text}`);
const turnedOn = r.json as { enabled: boolean; notice_version: number; notice_edited: boolean };
assert.equal(turnedOn.enabled, true);
assert.equal(turnedOn.notice_version, before[0].version + 1, "a new notice version");
const after = await notices();
assert.match(after[0].body.who, /AI assistant access/, "the notice mentions AI assistant access");
assert.doesNotMatch(before[0].body.who, /AI assistant/, "it didn't before");
/** The org's audit rows for some actions, newest first (as the owner reads them). */
async function auditRows(actions: string[], actorId: string | null = null) {
  const out = await rest("/rest/v1/rpc/search_audit_log", adminSession, {
    body: { p_actions: actions, p_actor_id: actorId, p_limit: 200 },
  });
  assert.equal(out.status, 200, `audit: ${out.text}`);
  return out.json as {
    action: string;
    actor_id: string;
    target_user_id: string | null;
    metadata: Json;
  }[];
}
const changed = await auditRows(["ai_assistant_access.changed"]);
assert.deepEqual(
  [changed[0].actor_id, changed[0].metadata],
  [ADA, { enabled: true }],
  "audit-logged",
);

// Tokens -------------------------------------------------------------------------------------

const ada = await connect("admin@acme.test", claude);
const max = await connect("manager@acme.test", claude);
const erin = await connect("erin@acme.test", await register(`IT ChatGPT ${RUN}`));
const lucas = await connect("lucas@acme.test", claude);
for (const [who, t] of Object.entries({ ada, max, erin, lucas })) {
  assert.equal(t.status, 200, `${who} gets a token: ${JSON.stringify(t.body)}`);
}

// An assistant's token works only at the MCP server.
r = await rest("/rest/v1/users?select=id", max.access);
assert.equal(r.status, 403, `PostgREST refuses an assistant token: ${r.text}`);
r = await rest("/rest/v1/rpc/can_view_user", max.access, { body: { target: ERIN } });
assert.equal(r.status, 403, "RPCs too");
r = await rest("/storage/v1/bucket", max.access);
assert.ok(r.status >= 400, `Storage refuses it: ${r.status}`);
for (const fn of ["capture-url", "export-my-data", "delete-user-data", "export-user-data"]) {
  r = await rest(`/functions/v1/${fn}`, max.access, { body: {} });
  assert.equal(r.status, 403, `${fn} refuses an assistant token: ${r.status} ${r.text}`);
  assert.equal((r.json as Json).error, "assistant_token", `${fn}: says why`);
}

// MCP over HTTP ------------------------------------------------------------------------------

let nextId = 1;
async function mcp(
  token: string | null,
  method: string,
  params: unknown = {},
  headers: Record<string, string> = {},
) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: (text ? parse(text) : {}) as Json,
    text,
    headers: res.headers,
  };
}

interface ToolResult {
  isError: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Json;
}

/** tools/call; returns the tool result and the raw text (for the never-returned checks). */
async function call(token: string, name: string, args: Json = {}) {
  const reply = await mcp(token, "tools/call", { name, arguments: args });
  assert.equal(reply.status, 200, `${name}: ${reply.text}`);
  const result = reply.json.result as ToolResult;
  assert.ok(result, `${name}: a result (${reply.text})`);
  allText.push(reply.text);
  return result;
}
const allText: string[] = [];

function ok(result: ToolResult, what: string): Json {
  assert.equal(result.isError, false, `${what}: ${JSON.stringify(result.content)}`);
  assert.deepEqual(
    JSON.parse(result.content[0].text),
    result.structuredContent,
    `${what}: text = structured`,
  );
  return result.structuredContent as Json;
}

function failed(result: ToolResult, code: string, what: string) {
  assert.equal(result.isError, true, `${what}: an error`);
  assert.match(
    result.content[0].text,
    new RegExp(`\\(${code}\\)$`),
    `${what}: ${result.content[0].text}`,
  );
}

// A dashboard token isn't one issued to an assistant.
res = await fetch(MCP, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${managerSession}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
});
assert.equal(res.status, 401, "a dashboard session token is refused");
assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
res = await fetch(MCP, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer not.a.token" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
});
assert.equal(res.status, 401, "a garbage token is refused");

let reply = await mcp(max.access, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "it", version: "1" },
});
assert.equal(reply.status, 200, `initialize: ${reply.text}`);
const init = reply.json.result as Json;
assert.equal(init.protocolVersion, "2025-06-18", "the client's version when supported");
assert.deepEqual(init.capabilities, { tools: { listChanged: false } }, "a tools-only server");
assert.equal((init.serverInfo as Json).name, "ai-proctor");
reply = await mcp(max.access, "initialize", { protocolVersion: "1999-01-01", capabilities: {} });
assert.equal(
  (reply.json.result as Json).protocolVersion,
  "2025-11-25",
  "else the newest it speaks",
);

res = await fetch(MCP, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${max.access}` },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
assert.equal(res.status, 202, "a notification is accepted with no body");
assert.deepEqual((await mcp(max.access, "ping")).json.result, {}, "ping");
reply = await mcp(max.access, "resources/list");
assert.equal((reply.json.error as Json).code, -32601, "an unknown method");
reply = await mcp(max.access, "ping", {}, { "MCP-Protocol-Version": "2020-01-01" });
assert.equal(reply.status, 400, "an unsupported protocol version header");
reply = await mcp(max.access, "ping", {}, { "MCP-Protocol-Version": "2025-06-18" });
assert.equal(reply.status, 200, "a supported one");
res = await fetch(MCP, { headers: { Authorization: `Bearer ${max.access}` } });
assert.equal(res.status, 405, "no SSE stream on GET");
res = await fetch(MCP, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${max.access}` },
  body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
});
assert.equal(res.status, 400, "no batches");
res = await fetch(MCP, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${max.access}` },
  body: "{",
});
assert.equal(((await res.json()) as { error: Json }).error.code, -32700, "a parse error");

reply = await mcp(max.access, "tools/list");
const listed = (
  reply.json.result as { tools: { name: string; inputSchema: Json; annotations: Json }[] }
).tools;
assert.deepEqual(
  listed.map((t) => t.name),
  [
    "list_people",
    "who_is_on_shift",
    "get_person_day",
    "list_timesheets",
    "hours_report",
    "list_alerts",
  ],
  "the v1 tools",
);
for (const t of listed) {
  assert.equal(t.inputSchema.type, "object", `${t.name}: an object schema`);
  assert.equal(t.annotations.readOnlyHint, true, `${t.name}: read-only`);
}
reply = await mcp(max.access, "tools/call", { name: "approve_timesheet", arguments: {} });
assert.equal((reply.json.error as Json).code, -32602, "an unknown tool");

// Data: a day for Erin and Lucas (Max's reports) ----------------------------------------------

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(
  new Date(),
);
const dayDate = new Date(`${today}T12:00:00Z`);
dayDate.setUTCDate(dayDate.getUTCDate() - 1);
const DAY = dayDate.toISOString().slice(0, 10);
// 13:00-15:00 in Los Angeles on DAY (PDT or PST: the offset comes from Intl).
const offsetMin = (() => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(`${DAY}T20:00:00Z`));
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(
    parts.find((p) => p.type === "timeZoneName")?.value ?? "",
  );
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : -480;
})();
const at = (h: number, min = 0) =>
  new Date(
    Date.parse(`${DAY}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00Z`) -
      offsetMin * 60_000,
  );

/** Rows straight into a table (service role), one at a time. */
async function insert(table: string, body: Json | Json[]) {
  const rows: Json[] = [];
  for (const row of Array.isArray(body) ? body : [body]) {
    const out = await rest(`/rest/v1/${table}`, service, {
      body: row,
      prefer: "return=representation",
    });
    assert.equal(out.status, 201, `${table}: ${out.text}`);
    rows.push(...(out.json as Json[]));
  }
  return rows;
}

// A rerun on the same database starts from an empty day (and week) for Erin and Lucas.
const weekStart = (() => {
  const d = new Date(`${DAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
})();
const dayFrom = at(0).toISOString();
const dayTo = at(24).toISOString();
for (const path of [
  `time_segments?user_id=in.(${ERIN},${LUCAS})&day=eq.${DAY}`,
  `checkin_events?user_id=eq.${ERIN}&shown_at=gte.${dayFrom}&shown_at=lt.${dayTo}`,
  `activity_samples?user_id=eq.${ERIN}&minute=gte.${dayFrom}&minute=lt.${dayTo}`,
  `timesheets?user_id=eq.${ERIN}&period_start=eq.${weekStart}`,
  `alerts?user_id=eq.${ERIN}&episode=like.it-*`,
]) {
  const out = await rest(`/rest/v1/${path}`, service, { method: "DELETE" });
  assert.ok(out.status < 300, `clean ${path}: ${out.text}`);
}

const [device] = await insert("devices", {
  org_id: ORG,
  user_id: ERIN,
  platform: "macos",
  os_version: "15",
  agent_version: "it",
  hardware_hash: `it-mcp-${RUN}`,
});
await insert("time_segments", [
  {
    org_id: ORG,
    user_id: ERIN,
    day: DAY,
    start_at: at(13).toISOString(),
    end_at: at(15).toISOString(),
    type: "verified",
    project_id: REVAMP,
    counted: true,
    flagged: false,
    source: "manual",
  },
  {
    org_id: ORG,
    user_id: ERIN,
    day: DAY,
    start_at: at(15).toISOString(),
    end_at: at(15, 30).toISOString(),
    type: "unverified",
    project_id: REVAMP,
    counted: true,
    flagged: true,
    source: "manual",
  },
  {
    org_id: ORG,
    user_id: LUCAS,
    day: DAY,
    start_at: at(13).toISOString(),
    end_at: at(14).toISOString(),
    type: "verified",
    project_id: null,
    counted: true,
    flagged: false,
    source: "manual",
  },
]);
const SECRET_CAPTURE = `${ORG}/${ERIN}/secret-capture-${RUN}.webp`;
const SECRET_TITLE = `Secret window ${RUN}`;
const SECRET_REMARK = `private remark ${RUN}`;
await insert("checkin_events", [
  {
    id: crypto.randomUUID(),
    org_id: ORG,
    user_id: ERIN,
    device_id: device.id,
    project_id: REVAMP,
    scheduled_at: new Date(at(14).getTime() - 37_000).toISOString(),
    shown_at: at(14).toISOString(),
    responded_at: new Date(at(14).getTime() + 2_400).toISOString(),
    outcome: "pass",
    response_ms: 2400,
    object_keys: [SECRET_CAPTURE],
    flags: [],
  },
  {
    id: crypto.randomUUID(),
    org_id: ORG,
    user_id: ERIN,
    device_id: device.id,
    project_id: REVAMP,
    scheduled_at: new Date(at(14, 30).getTime() - 41_000).toISOString(),
    shown_at: at(14, 30).toISOString(),
    outcome: "miss",
    object_keys: [],
    flags: [],
    missed_reason_kind: "meeting",
    missed_reason: SECRET_REMARK,
  },
]);
await insert("activity_samples", [
  {
    id: crypto.randomUUID(),
    org_id: ORG,
    user_id: ERIN,
    device_id: device.id,
    minute: at(13, 5).toISOString(),
    app_name: "Figma",
    seconds: 60,
    window_title: SECRET_TITLE,
    domain: `secret-${RUN}.example`,
  },
  {
    id: crypto.randomUUID(),
    org_id: ORG,
    user_id: ERIN,
    device_id: device.id,
    minute: at(13, 6).toISOString(),
    app_name: "Figma",
    seconds: 45,
    window_title: SECRET_TITLE,
    domain: null,
  },
]);
// A submitted week for Erin (waiting for Max) and an alert about her (sent to Max).
await insert("timesheets", {
  org_id: ORG,
  user_id: ERIN,
  period_start: weekStart,
  status: "submitted",
  submitted_at: new Date().toISOString(),
});
await insert("alerts", {
  org_id: ORG,
  user_id: ERIN,
  recipient_id: MAX,
  kind: "consecutive_misses",
  episode: `it-${RUN}`,
  details: { misses: 3, threshold: 3 },
  triggered_at: at(14, 31).toISOString(),
});

// Tools, by role ------------------------------------------------------------------------------

const names = (rows: Json[], key = "name") => rows.map((p) => p[key] as string).sort();
const personNames = (rows: Json[]) => rows.map((p) => (p.person as Json).name as string).sort();

// list_people: the owner sees everyone, the manager their reports and themselves, an
// employee only themselves.
let out = ok(await call(ada.access, "list_people"), "owner people");
assert.deepEqual(names(out.people as Json[]), [
  "Ada Admin",
  "Erin Employee",
  "Lucas Martin",
  "Max Manager",
]);
out = ok(await call(max.access, "list_people"), "manager people");
assert.deepEqual(names(out.people as Json[]), ["Erin Employee", "Lucas Martin", "Max Manager"]);
out = ok(await call(erin.access, "list_people"), "employee people");
assert.deepEqual(names(out.people as Json[]), ["Erin Employee"]);
out = ok(await call(max.access, "list_people", { query: "eri" }), "search by name");
assert.deepEqual(names(out.people as Json[]), ["Erin Employee"]);
failed(
  await call(max.access, "list_people", { team: "x" }),
  "invalid_param",
  "an unknown argument",
);
failed(await call(max.access, "list_people", { role: "boss" }), "invalid_param", "a bad enum");

// who_is_on_shift (everyone is off shift in the seed).
out = ok(await call(max.access, "who_is_on_shift"), "on shift");
assert.deepEqual(out.people, [], "nobody is clocked in");
out = ok(await call(max.access, "who_is_on_shift", { include_off_shift: true }), "with off shift");
assert.deepEqual(personNames(out.people as Json[]), [
  "Erin Employee",
  "Lucas Martin",
  "Max Manager",
]);
assert.ok((out.people as Json[]).every((p) => p.status === "off_shift"));
out = ok(
  await call(erin.access, "who_is_on_shift", { include_off_shift: true }),
  "employee on shift",
);
assert.deepEqual(personNames(out.people as Json[]), ["Erin Employee"]);

// get_person_day: segments, check-ins with the miss reason, top apps.
out = ok(await call(max.access, "get_person_day", { user_id: ERIN, date: DAY }), "Erin's day");
const totals = out.totals as Json;
assert.equal(totals.worked_s, 9000, "2h30 worked");
assert.equal(totals.flagged_s, 1800, "30 min flagged");
assert.equal(totals.checkins_missed, 1);
assert.equal((out.segments as Json[]).length, 2);
assert.equal(((out.segments as Json[])[0].project as Json).name, "Website revamp");
const checkins = out.checkins as Json[];
assert.deepEqual(
  checkins.map((c) => c.outcome),
  ["pass", "miss"],
);
assert.equal(checkins[1].miss_reason, "meeting", "the miss reason picked");
assert.deepEqual(Object.keys(checkins[0]).sort(), [
  "miss_reason",
  "outcome",
  "responded_at",
  "response_ms",
  "shown_at",
]);
assert.deepEqual(out.top_apps, [{ app: "Figma", seconds: 105 }], "top apps: names and seconds");
failed(
  await call(erin.access, "get_person_day", { user_id: LUCAS, date: DAY }),
  "not_found",
  "an employee can't see a peer",
);
failed(
  await call(max.access, "get_person_day", { user_id: ADA }),
  "not_found",
  "a manager can't see their own manager",
);
failed(
  await call(max.access, "get_person_day", { user_id: ERIN, date: "yesterday" }),
  "invalid_param",
  "a bad date",
);
out = ok(await call(erin.access, "get_person_day", { date: DAY }), "an employee's own day");
assert.equal((out.person as Json).name, "Erin Employee");

// list_timesheets: one week lists everyone visible; waiting for my approval.
out = ok(await call(max.access, "list_timesheets", { week: DAY }), "the week");
assert.equal(out.week_start, weekStart);
assert.deepEqual(personNames(out.timesheets as Json[]), [
  "Erin Employee",
  "Lucas Martin",
  "Max Manager",
]);
const erinWeek = (out.timesheets as Json[]).find((t) => (t.person as Json).id === ERIN) as Json;
assert.equal(erinWeek.status, "submitted");
assert.equal(erinWeek.waiting_for_my_approval, true);
assert.equal(erinWeek.worked_s, 9000);
const lucasWeek = (out.timesheets as Json[]).find((t) => (t.person as Json).id === LUCAS) as Json;
assert.equal(lucasWeek.status, "draft");
assert.equal(lucasWeek.started, false);
out = ok(
  await call(max.access, "list_timesheets", { waiting_for_my_approval: true }),
  "waiting for Max",
);
assert.deepEqual(personNames(out.timesheets as Json[]), ["Erin Employee"]);
out = ok(
  await call(erin.access, "list_timesheets", { waiting_for_my_approval: true }),
  "waiting for Erin",
);
assert.deepEqual(out.timesheets, []);
out = ok(await call(erin.access, "list_timesheets", { week: DAY }), "an employee's week");
assert.deepEqual(personNames(out.timesheets as Json[]), ["Erin Employee"]);

// hours_report by person, project and task.
out = ok(await call(max.access, "hours_report", { from: DAY, to: DAY }), "hours by person");
assert.deepEqual(
  (out.rows as Json[]).map((x) => [(x.person as Json).name, x.worked_s]),
  [
    ["Erin Employee", 9000],
    ["Lucas Martin", 3600],
  ],
);
assert.equal(out.total_worked_s, 12600);
out = ok(
  await call(max.access, "hours_report", { from: DAY, to: DAY, group_by: "project" }),
  "by project",
);
assert.deepEqual(
  (out.rows as Json[]).map((x) => [
    x.project ? (x.project as Json).name : null,
    x.worked_s,
    x.people,
  ]),
  [
    ["Website revamp", 9000, 1],
    [null, 3600, 1],
  ],
);
out = ok(
  await call(max.access, "hours_report", { from: DAY, to: DAY, group_by: "client" }),
  "by client",
);
assert.equal(((out.rows as Json[])[0].client as Json).name, "Northwind");
out = ok(await call(erin.access, "hours_report", { from: DAY, to: DAY }), "an employee's hours");
assert.deepEqual(
  (out.rows as Json[]).map((x) => (x.person as Json).name),
  ["Erin Employee"],
);
failed(await call(max.access, "hours_report", { from: DAY }), "invalid_param", "to is required");

// list_alerts: the manager's, the owner's view, never the employee's own.
// The seed also gets real late clock-in alerts from the alert job: look at this kind only.
const range = { from: DAY, to: today, kind: "consecutive_misses" };
out = ok(await call(max.access, "list_alerts", range), "Max's alerts");
assert.deepEqual(personNames(out.alerts as Json[]), ["Erin Employee"]);
assert.equal((out.alerts as Json[])[0].sent_to_me, true);
out = ok(await call(ada.access, "list_alerts", range), "Ada's alerts");
assert.deepEqual(personNames(out.alerts as Json[]), ["Erin Employee"]);
out = ok(await call(erin.access, "list_alerts", range), "Erin's alerts");
assert.deepEqual(out.alerts, [], "not alerts about herself");

// What no tool returns (API-04) --------------------------------------------------------------

const everything = allText.join("\n");
for (const secret of [SECRET_CAPTURE, SECRET_TITLE, SECRET_REMARK, `secret-${RUN}.example`]) {
  assert.ok(!everything.includes(secret), `never returned: ${secret}`);
}
for (const field of [
  "object_keys",
  "scheduled_at",
  "window_title",
  "domain",
  "tamper_reason",
  'missed_reason"',
]) {
  assert.ok(!everything.includes(`"${field.replace(/"$/, "")}"`), `no ${field} field`);
}

// Audit --------------------------------------------------------------------------------------

const audit = await auditRows(["mcp.tool_call"], MAX);
const dayRow = audit.find(
  (a) => a.metadata.tool === "get_person_day" && a.target_user_id === ERIN && !a.metadata.error,
);
assert.ok(dayRow, "a tool call is audit-logged with the person it was about");
assert.deepEqual(dayRow.metadata.filters, { user_id: ERIN, date: DAY }, "and its arguments");
assert.equal(
  dayRow.metadata.row_count,
  5,
  "and the rows returned (2 segments, 2 check-ins, 1 app)",
);
assert.equal(dayRow.metadata.client_name, `IT Claude ${RUN}`, "and the assistant");
assert.ok(
  audit.some((a) => a.metadata.tool === "list_people" && a.metadata.error === "invalid_param"),
  "a failed call is logged too",
);

// Rate limit (per person) -----------------------------------------------------------------

let limited: ToolResult | null = null;
for (let i = 0; i < 61 && !limited; i++) {
  const result = (await mcp(lucas.access, "tools/call", { name: "list_people", arguments: {} }))
    .json.result as ToolResult;
  if (result.isError) limited = result;
}
assert.ok(limited, "the 61st call in a minute is refused");
failed(limited, "rate_limited", "rate limited");
ok(await call(max.access, "list_people"), "another person isn't limited");

// Turning it off -------------------------------------------------------------------------------

r = await rest("/rest/v1/rpc/set_ai_assistant_access", adminSession, {
  body: { p_enabled: false },
});
assert.equal(r.status, 200, "the owner turns it off");
assert.equal((r.json as Json).enabled, false);
assert.doesNotMatch(
  (await notices())[0].body.who,
  /AI assistant/,
  "the notice no longer mentions it",
);
failed(await call(max.access, "list_people"), "ai_assistant_access_off", "every call is refused");
const offAudit = await auditRows(["mcp.tool_call"], MAX);
assert.equal(offAudit[0].metadata.error, "ai_assistant_access_off", "a refused call is logged");
res = await fetch(as.token_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: max.refresh,
    client_id: claude,
  }),
});
assert.ok(res.status >= 400, `no refreshed token while it is off: ${res.status}`);
org = await rest(`/rest/v1/orgs?id=eq.${ORG}&select=ai_assistant_access`, adminSession);
assert.deepEqual(org.json, [{ ai_assistant_access: false }]);

console.log("it-mcp: ok");
