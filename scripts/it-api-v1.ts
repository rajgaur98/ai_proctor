// Integration check for the public API v1 (#306; time off #320) against a local stack, over HTTP through
// the api-v1 Edge Function: keys made and refused on the dashboard RPCs, the OpenAPI
// document against docs/api/openapi.json, every key error (missing, malformed, unknown,
// revoked, expired, creator no longer an admin), scopes, parameter errors, paging with
// cursors and updated_since, writes (clients, projects, tasks, manual entries through the
// manual-entry rules), check-ins as metadata only, reports, the rate limit, another org's
// key seeing only its org, and the audit rows. Run it through `pnpm it:api`; it can run
// again on the same database.
//
// Needs AI_PROCTOR_SUPABASE_URL, AI_PROCTOR_SUPABASE_ANON_KEY and
// AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY (the wrapper script sets them).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const url = process.env.AI_PROCTOR_SUPABASE_URL ?? "";
const anon = process.env.AI_PROCTOR_SUPABASE_ANON_KEY ?? "";
const service = process.env.AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !anon || !service) {
  console.error("Set AI_PROCTOR_SUPABASE_URL, _ANON_KEY and _SERVICE_ROLE_KEY (pnpm it:api).");
  process.exit(2);
}

const ORG = "00000000-0000-4000-8000-000000000001";
const ADA = "00000000-0000-4000-8000-0000000000a1";
const MAX = "00000000-0000-4000-8000-0000000000b1";
const ERIN = "00000000-0000-4000-8000-0000000000c1";
const REVAMP = "00000000-0000-4000-8000-0000000000f1";
const API = `${url}/functions/v1/api-v1`;
const RUN = Date.now().toString(36);

type Json = Record<string, unknown>;
interface Reply {
  status: number;
  json: Json;
  headers: Headers;
}

function parse(text: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** PostgREST / Auth with a bearer token (a session or the service role). */
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
  return { status: res.status, json: (text ? parse(text) : null) as unknown };
}

/** The public API with an API key. */
async function api(
  path: string,
  key: string | null,
  init: { method?: string; body?: unknown } = {},
): Promise<Reply> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, json: parse(await res.text()), headers: res.headers };
}

const errorCode = (r: Reply) => (r.json.error as { code?: string } | undefined)?.code;
const data = (r: Reply) => r.json.data as Json[];
const item = (r: Reply) => r.json.data as Json;

function expectError(r: Reply, status: number, code: string, what: string) {
  assert.equal(r.status, status, `${what}: ${r.status} ${JSON.stringify(r.json)}`);
  assert.equal(errorCode(r), code, `${what}: code`);
  assert.equal(typeof (r.json.error as Json).message, "string", `${what}: a message`);
}

function expectOk(r: Reply, what: string, status = 200) {
  assert.equal(r.status, status, `${what}: ${r.status} ${JSON.stringify(r.json)}`);
}

async function signIn(email: string, password = "password123") {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `sign in ${email}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function createKey(
  token: string,
  name: string,
  scopes: string[],
  expiresAt: string | null = null,
) {
  const r = await rest("/rest/v1/rpc/create_api_key", token, {
    body: { p_name: name, p_scopes: scopes, p_expires_at: expiresAt },
  });
  assert.equal(r.status, 200, `create key ${name}: ${JSON.stringify(r.json)}`);
  return (r.json as { id: string; key: string; key_prefix: string }[])[0];
}

/** Every page of a list, following next_cursor. */
async function all(path: string, key: string, limit: number) {
  const items: Json[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const r = await api(`${path}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`, key);
    expectOk(r, `page ${pages + 1} of ${path}`);
    items.push(...data(r));
    assert.ok(data(r).length <= limit, "a page holds at most limit items");
    cursor = r.json.next_cursor as string | null;
    pages++;
    assert.ok(pages < 100, "paging ends");
  } while (cursor);
  return { items, pages };
}

const ALL_SCOPES = [
  "people:read",
  "teams:read",
  "projects:read",
  "projects:write",
  "shifts:read",
  "timesheets:read",
  "time:read",
  "time:write",
  "checkins:read",
  "reports:read",
  "alerts:read",
  "timeoff:read",
];

// Keys -------------------------------------------------------------------------------------

const admin = await signIn("admin@acme.test");
const manager = await signIn("manager@acme.test");

const full = await createKey(admin, `IT full ${RUN}`, ALL_SCOPES);
assert.match(full.key, /^aip_[A-Za-z0-9_-]{43}$/, "a key is aip_ and 43 characters");
assert.equal(full.key_prefix, full.key.slice(0, 8), "the prefix is the key's first 8 characters");
const peopleOnly = await createKey(admin, `IT people ${RUN}`, ["people:read"]);

const refused = await rest("/rest/v1/rpc/create_api_key", manager, {
  body: { p_name: "Manager key", p_scopes: ["people:read"] },
});
assert.equal(refused.status, 403, "a manager can't make a key");
const badScope = await rest("/rest/v1/rpc/create_api_key", admin, {
  body: { p_name: "Bad", p_scopes: ["captures:read"] },
});
assert.equal(badScope.status, 400, "an unknown scope is refused");

const listed = await rest("/rest/v1/rpc/list_api_keys", admin);
assert.equal(listed.status, 200);
const listedText = JSON.stringify(listed.json);
assert.ok(listedText.includes(full.key_prefix), "the list shows the prefix");
assert.ok(!listedText.includes(full.key), "the list never shows the key");
assert.ok(!listedText.includes("key_hash"), "the list never shows the hash");
const direct = await rest(`/rest/v1/api_keys?select=id`, admin);
assert.ok(direct.status >= 400, "the table isn't readable through PostgREST");

// The document ---------------------------------------------------------------------------

const spec = await api("/v1/openapi.json", null);
expectOk(spec, "openapi.json without a key");
assert.deepEqual(
  spec.json,
  JSON.parse(readFileSync(new URL("../docs/api/openapi.json", import.meta.url), "utf8")),
  "the served document is docs/api/openapi.json (pnpm api:openapi)",
);

// Key errors ---------------------------------------------------------------------------------

expectError(await api("/v1/people", null), 401, "missing_key", "no key");
expectError(await api("/v1/people", "not-a-key"), 401, "invalid_key", "a malformed key");
expectError(await api("/v1/people", `aip_${"x".repeat(43)}`), 401, "invalid_key", "an unknown key");
expectError(await api("/v1/nothing", full.key), 404, "not_found", "an unknown path");
expectError(
  await api("/v1/people", full.key, { method: "DELETE" }),
  405,
  "method_not_allowed",
  "a wrong method",
);

const toRevoke = await createKey(admin, `IT revoke ${RUN}`, ["people:read"]);
expectOk(await api("/v1/people", toRevoke.key), "a new key works");
assert.equal(
  (await rest("/rest/v1/rpc/revoke_api_key", admin, { body: { p_id: toRevoke.id } })).status,
  204,
);
expectError(await api("/v1/people", toRevoke.key), 401, "key_revoked", "a revoked key");

const toExpire = await createKey(
  admin,
  `IT expire ${RUN}`,
  ["people:read"],
  new Date(Date.now() + 3_600_000).toISOString(),
);
expectOk(await api("/v1/people", toExpire.key), "a key before its expiry");
await rest(`/rest/v1/api_keys?id=eq.${toExpire.id}`, service, {
  method: "PATCH",
  body: { expires_at: new Date(Date.now() - 1000).toISOString() },
});
expectError(await api("/v1/people", toExpire.key), 401, "key_expired", "an expired key");

expectError(
  await api("/v1/teams", peopleOnly.key),
  403,
  "insufficient_scope",
  "a key without the scope",
);
expectError(
  await api("/v1/clients", peopleOnly.key, { body: { name: "Nope" } }),
  403,
  "insufficient_scope",
  "a read key can't write",
);

// Parameters -------------------------------------------------------------------------------

let r = await api("/v1/people?bogus=1", full.key);
expectError(r, 400, "invalid_param", "an unknown parameter");
assert.equal((r.json.error as Json).param, "bogus");
r = await api("/v1/people?updated_since=2026-01-01T00:00:00", full.key);
expectError(r, 400, "invalid_param", "a time without a zone");
assert.equal((r.json.error as Json).param, "updated_since");
expectError(await api("/v1/people?limit=501", full.key), 400, "invalid_param", "limit over 500");
expectError(await api("/v1/people?cursor=zz", full.key), 400, "invalid_param", "a made-up cursor");
expectError(await api("/v1/people?team_id=x", full.key), 400, "invalid_param", "a bad id");
expectError(
  await api("/v1/people?limit=1&limit=2", full.key),
  400,
  "invalid_param",
  "a repeated parameter",
);
expectError(
  await api("/v1/segments?from=2026-02-30", full.key),
  400,
  "invalid_param",
  "an impossible date",
);
expectError(
  await api("/v1/reports/people", full.key),
  400,
  "invalid_param",
  "a report needs from and to",
);

// People, paging and updated_since ---------------------------------------------------------

r = await api("/v1/people", full.key);
expectOk(r, "people");
assert.equal(r.headers.get("x-ratelimit-limit"), "120", "rate limit headers");
assert.ok(Number(r.headers.get("x-ratelimit-remaining")) < 120);
const people = data(r);
assert.ok(people.length >= 4, "everyone in the org");
assert.ok(
  people.every((p) => p.id && p.full_name && p.updated_at),
  "people have ids, names, updated_at",
);
assert.match(
  String(people[0].updated_at),
  /T\d{2}:\d{2}:\d{2}.*[+-]\d{2}:\d{2}$|Z$/,
  "times have a zone",
);
const paged = await all("/v1/people", full.key, 1);
assert.equal(paged.items.length, people.length, "paging by 1 gets everyone");
assert.equal(new Set(paged.items.map((p) => p.id)).size, people.length, "no person twice");
assert.equal(paged.pages, people.length, "one page per person");

const marker = new Date(Date.now() - 1000).toISOString();
await rest(`/rest/v1/users?id=eq.${ERIN}`, service, {
  method: "PATCH",
  body: { work_state: "OR" },
});
r = await api(`/v1/people?updated_since=${encodeURIComponent(marker)}`, full.key);
expectOk(r, "people updated since");
assert.ok(
  data(r).some((p) => p.id === ERIN),
  "a changed person comes back with updated_since",
);
await rest(`/rest/v1/users?id=eq.${ERIN}`, service, {
  method: "PATCH",
  body: { work_state: "CA" },
});
r = await api(
  `/v1/people?updated_since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
  full.key,
);
expectOk(r, "nothing changed in the future");
assert.equal(data(r).length, 0);

// Writes -----------------------------------------------------------------------------------

r = await api("/v1/clients", full.key, { body: { name: `IT Client ${RUN}` } });
expectOk(r, "create client", 201);
const client = item(r);
assert.equal(client.archived, false);
expectError(
  await api("/v1/clients", full.key, { body: { name: `IT Client ${RUN}` } }),
  409,
  "name_taken",
  "a taken name",
);
expectError(
  await api("/v1/clients", full.key, { body: {} }),
  400,
  "invalid_param",
  "a client needs a name",
);
r = await api("/v1/projects", full.key, {
  body: { name: `IT Project ${RUN}`, client_id: client.id, billable: false },
});
expectOk(r, "create project", 201);
const project = item(r);
assert.equal(project.client_id, client.id);
assert.equal(project.billable, false);
r = await api("/v1/tasks", full.key, { body: { project_id: project.id, name: "Design" } });
expectOk(r, "create task", 201);
const task = item(r);
assert.equal(task.billable, false, "a task takes its project's billable");
r = await api(`/v1/tasks/${task.id}/archive`, full.key, { method: "POST" });
expectOk(r, "archive task");
assert.equal(item(r).archived, true);
expectOk(await api(`/v1/tasks/${task.id}/archive`, full.key, { method: "POST" }), "archive again");
r = await api(`/v1/projects?client_id=${client.id}`, full.key);
expectOk(r, "projects of the client");
assert.deepEqual(
  data(r).map((p) => p.id),
  [project.id],
);
r = await api(`/v1/tasks?project_id=${project.id}&archived=true`, full.key);
assert.deepEqual(
  data(r).map((t) => t.id),
  [task.id],
  "archived tasks",
);
expectOk(
  await api(`/v1/projects/${project.id}/archive`, full.key, { method: "POST" }),
  "archive project",
);
expectOk(
  await api(`/v1/clients/${client.id}/archive`, full.key, { method: "POST" }),
  "archive client",
);
expectError(
  await api(`/v1/clients/${crypto.randomUUID()}/archive`, full.key, { method: "POST" }),
  404,
  "client_not_found",
  "archiving an unknown client",
);

// A manual entry for Erin last Monday-ish (a past day, LA afternoon), pending for Max.
const day = new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10);
const minuteOfRun = Number.parseInt(RUN.slice(-3), 36) % 600;
const startAt = new Date(`${day}T20:00:00Z`);
startAt.setUTCMinutes(minuteOfRun % 60, minuteOfRun % 59);
const entryBody = {
  user_id: ERIN,
  start_at: startAt.toISOString(),
  end_at: new Date(startAt.getTime() + 30 * 60_000 + 7_000).toISOString(),
  project_id: REVAMP,
  reason: "Client workshop",
  note: "Whiteboard session",
};
await rest(
  `/rest/v1/manual_entries?user_id=eq.${ERIN}&start_at=lt.${encodeURIComponent(entryBody.end_at)}&end_at=gt.${encodeURIComponent(entryBody.start_at)}`,
  service,
  { method: "DELETE" },
);
r = await api("/v1/manual-entries", full.key, { body: entryBody });
expectOk(r, "create manual entry", 201);
const entry = item(r);
assert.equal(entry.status, "pending", "pending until Erin's manager decides (TS-08)");
assert.equal(entry.duration_s, 1807, "exact seconds");
expectError(
  await api("/v1/manual-entries", full.key, { body: entryBody }),
  409,
  "overlaps_manual_entry",
  "an overlap (TS-09)",
);
expectError(
  await api("/v1/manual-entries", full.key, {
    body: { ...entryBody, start_at: "2099-01-01T10:00:00Z", end_at: "2099-01-01T11:00:00Z" },
  }),
  400,
  "in_the_future",
  "an entry in the future",
);
expectError(
  await api("/v1/manual-entries", full.key, {
    body: { ...entryBody, user_id: MAX, project_id: REVAMP },
  }),
  400,
  "project_not_allowed",
  "a project the person isn't a member of",
);
r = await api(`/v1/manual-entries?user_id=${ERIN}&status=pending`, full.key);
assert.ok(
  data(r).some((e) => e.id === entry.id),
  "the entry is listed",
);

// Check-ins as metadata only -------------------------------------------------------------

const device = await rest("/rest/v1/devices", service, {
  body: {
    org_id: ORG,
    user_id: ERIN,
    platform: "macos",
    os_version: "15",
    agent_version: "it",
    hardware_hash: `it-api-${RUN}`,
  },
  prefer: "return=representation",
});
assert.equal(device.status, 201, `device: ${JSON.stringify(device.json)}`);
const deviceId = (device.json as { id: string }[])[0].id;
const shown = new Date(Date.now() - 2 * 3_600_000);
const checkin = await rest("/rest/v1/checkin_events", service, {
  body: {
    id: crypto.randomUUID(),
    org_id: ORG,
    user_id: ERIN,
    device_id: deviceId,
    project_id: REVAMP,
    scheduled_at: new Date(shown.getTime() - 61_000).toISOString(),
    shown_at: shown.toISOString(),
    responded_at: new Date(shown.getTime() + 2_400).toISOString(),
    outcome: "pass",
    response_ms: 2400,
    object_keys: [`${ORG}/${ERIN}/secret-capture-${RUN}.webp`],
    missed_reason: "private words",
    flags: [],
  },
  prefer: "return=representation",
});
assert.equal(checkin.status, 201, `checkin: ${JSON.stringify(checkin.json)}`);
const checkinId = (checkin.json as { id: string }[])[0].id;
r = await api(`/v1/checkins?user_id=${ERIN}&outcome=pass`, full.key);
expectOk(r, "check-ins");
const got = data(r).find((c) => c.id === checkinId);
assert.ok(got, "the check-in is listed");
assert.deepEqual(
  Object.keys(got).sort(),
  [
    "created_at",
    "id",
    "outcome",
    "project_id",
    "responded_at",
    "response_ms",
    "shown_at",
    "updated_at",
    "user_id",
  ],
  "metadata only",
);
assert.equal(got.response_ms, 2400);
const text = JSON.stringify(r.json);
for (const secret of [
  "secret-capture",
  "object_keys",
  "scheduled_at",
  "private words",
  "window_title",
]) {
  assert.ok(!text.includes(secret), `never returns ${secret}`);
}

// Timesheets, segments, reports, the rest ----------------------------------------------------

for (const path of ["/v1/teams", "/v1/shifts", "/v1/timesheets", "/v1/segments", "/v1/alerts"]) {
  expectOk(await api(path, full.key), path);
}
r = await api(`/v1/reports/people?from=${day}&to=${day}`, full.key);
expectOk(r, "report per person");
assert.ok(
  data(r).some((p) => p.user_id === ADA),
  "the key's creator is in the report too",
);
assert.equal(r.json.from, day);
expectOk(await api(`/v1/reports/tasks?from=${day}&to=${day}`, full.key), "report per task");

// Time off (#320): requests without their notes, and the holiday calendar ------------------------

const erinToken = await signIn("erin@acme.test");
const vacation = (
  (await rest(`/rest/v1/leave_types?select=id&org_id=eq.${ORG}&name=eq.Vacation`, erinToken))
    .json as { id: string }[]
)[0];
const leaveDay = new Date(
  Date.now() + (60 + (Number.parseInt(RUN.slice(-3), 36) % 250)) * 86_400_000,
)
  .toISOString()
  .slice(0, 10);
const asked = await rest("/rest/v1/rpc/request_leave", erinToken, {
  body: { p_leave_type_id: vacation.id, p_first_day: leaveDay, p_note: "Secret leave note" },
});
assert.equal(asked.status, 200, `request leave: ${JSON.stringify(asked.json)}`);
const leaveId = asked.json as string;
await rest("/rest/v1/holidays", service, {
  body: { org_id: ORG, day: leaveDay, name: `IT Holiday ${RUN}` },
  prefer: "return=minimal",
});
r = await api(
  `/v1/time-off?user_id=${ERIN}&status=pending&from=${leaveDay}&to=${leaveDay}`,
  full.key,
);
expectOk(r, "time off");
const leave = data(r).find((l) => l.id === leaveId);
assert.ok(leave, "the request is listed");
assert.equal(leave.type_name, "Vacation");
assert.equal(leave.kind, "days");
assert.equal(leave.first_day, leaveDay);
assert.equal(leave.decided_by, null);
assert.ok(!JSON.stringify(r.json).includes("Secret leave note"), "never the note");
r = await api(`/v1/holidays?from=${leaveDay}&to=${leaveDay}`, full.key);
expectOk(r, "holidays");
assert.ok(
  data(r).some((h) => h.name === `IT Holiday ${RUN}` && h.day === leaveDay && h.country === null),
  "the holiday is listed",
);
expectError(
  await api("/v1/holidays", peopleOnly.key),
  403,
  "insufficient_scope",
  "time off needs its scope",
);
expectError(
  await api("/v1/time-off?status=maybe", full.key),
  400,
  "invalid_param",
  "a bad time-off status",
);

// Another org's key sees only its org ---------------------------------------------------------

const otherEmail = `olga-${RUN}@other.test`;
const created = await fetch(`${url}/auth/v1/admin/users`, {
  method: "POST",
  headers: {
    apikey: service,
    Authorization: `Bearer ${service}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ email: otherEmail, password: "password123", email_confirm: true }),
});
assert.equal(created.status, 200, `create auth user: ${await created.clone().text()}`);
const OLGA = ((await created.json()) as { id: string }).id;
const org2 = await rest("/rest/v1/orgs", service, {
  body: { name: `Other ${RUN}` },
  prefer: "return=representation",
});
const ORG2 = (org2.json as { id: string }[])[0].id;
assert.equal(
  (
    await rest("/rest/v1/users", service, {
      body: { id: OLGA, org_id: ORG2, full_name: "Olga Owner", email: otherEmail, role: "owner" },
      prefer: "return=minimal",
    })
  ).status,
  201,
);
const olga = await signIn(otherEmail);
const otherKey = await createKey(olga, "Other org", ["people:read", "projects:write", "time:read"]);
r = await api("/v1/people", otherKey.key);
expectOk(r, "other org's people");
assert.deepEqual(
  data(r).map((p) => p.id),
  [OLGA],
  "a key only sees its own org",
);
r = await api(`/v1/manual-entries?user_id=${ERIN}`, otherKey.key);
assert.equal(data(r).length, 0, "nobody from another org");
expectError(
  await api(`/v1/clients/${client.id}/archive`, otherKey.key, { method: "POST" }),
  404,
  "client_not_found",
  "another org's client",
);
await rest(`/rest/v1/users?id=eq.${OLGA}`, service, { method: "PATCH", body: { role: "manager" } });
expectError(
  await api("/v1/people", otherKey.key),
  401,
  "key_creator_inactive",
  "the creator is no longer an admin",
);

// Audit -------------------------------------------------------------------------------------

const audit = await rest("/rest/v1/rpc/search_audit_log", admin, {
  body: {
    p_actions: ["api.read", "api.write", "api_key.created", "api_key.revoked"],
    p_limit: 200,
  },
});
assert.equal(audit.status, 200, `audit: ${JSON.stringify(audit.json)}`);
const rows = audit.json as {
  action: string;
  actor_id: string;
  target_user_id: string | null;
  metadata: Json;
}[];
const mine = rows.filter((a) => a.metadata.key_id === full.id || a.metadata.key_id === toRevoke.id);
assert.ok(
  mine.some((a) => a.action === "api_key.created" && a.metadata.key_id === full.id),
  "key created",
);
assert.ok(
  mine.some((a) => a.action === "api_key.revoked" && a.metadata.key_id === toRevoke.id),
  "key revoked",
);
const read = mine.find((a) => a.action === "api.read" && a.metadata.operation === "checkins.list");
assert.ok(read, "a read is logged");
assert.equal(read.actor_id, ADA, "as the key's creator");
assert.equal(read.target_user_id, ERIN, "about the person filtered on");
assert.deepEqual(read.metadata.filters, { user_id: ERIN, outcome: "pass" }, "with its filters");
assert.equal(typeof read.metadata.row_count, "number", "and its row count");
assert.equal(read.metadata.prefix, full.key_prefix, "and the key's prefix");
const write = mine.find(
  (a) => a.action === "api.write" && a.metadata.operation === "manual_entries.create",
);
assert.ok(write, "a write is logged");
assert.equal(write.target_user_id, ERIN);
assert.ok(!JSON.stringify(write.metadata).includes("Whiteboard"), "without the entry's own words");
const requested = await rest("/rest/v1/rpc/search_audit_log", admin, {
  body: { p_actions: ["manual_entry.requested"], p_limit: 50 },
});
const req = (requested.json as { actor_id: string; target_user_id: string; metadata: Json }[]).find(
  (a) => a.metadata.entry_id === entry.id,
);
assert.ok(req, "the manual-entry rules log the request");
assert.equal(req.actor_id, ADA, "with the key's creator as actor");
assert.equal(req.metadata.key_id, full.id, "and the key");

// Rate limit (last: it uses up a key's minute) ------------------------------------------------

const limited = await createKey(admin, `IT rate ${RUN}`, ["teams:read"]);
// Start early in a minute so the window doesn't turn over halfway.
const second = new Date().getUTCSeconds();
if (second > 30) await new Promise((res) => setTimeout(res, (61 - second) * 1000));
let lastOk: Reply | null = null;
let tooMany: Reply | null = null;
for (let i = 0; i < 125 && !tooMany; i++) {
  const reply = await api("/v1/teams", limited.key);
  if (reply.status === 429) tooMany = reply;
  else {
    expectOk(reply, `request ${i + 1}`);
    lastOk = reply;
  }
}
assert.ok(tooMany, "the 121st request in a minute is refused");
assert.equal(lastOk?.headers.get("x-ratelimit-remaining"), "0", "the 120th has none left");
expectError(tooMany, 429, "rate_limited", "rate limited");
assert.ok(Number(tooMany.headers.get("retry-after")) > 0, "with Retry-After");
expectOk(await api("/v1/people", full.key), "other keys are not limited");

console.log("it-api-v1: ok");
