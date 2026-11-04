// Integration check for webhooks (#320, API-06) against a local stack; see it-webhooks.sh,
// which sets up the receiver (http://rest:3000/rpc/it_webhook_sink records what it gets,
// .../it_webhook_fail answers 400) and the environment. Run it through `pnpm it:webhooks`.
//
// Needs AI_PROCTOR_SUPABASE_URL, _ANON_KEY, _SERVICE_ROLE_KEY and AI_PROCTOR_DB_URL.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";

const url = process.env.AI_PROCTOR_SUPABASE_URL ?? "";
const anon = process.env.AI_PROCTOR_SUPABASE_ANON_KEY ?? "";
const service = process.env.AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY ?? "";
const dbUrl = process.env.AI_PROCTOR_DB_URL ?? "";
if (!url || !anon || !service || !dbUrl) {
  console.error("Set AI_PROCTOR_SUPABASE_URL, _ANON_KEY, _SERVICE_ROLE_KEY and AI_PROCTOR_DB_URL.");
  process.exit(2);
}

const ORG = "00000000-0000-4000-8000-000000000001";
const ADA = "00000000-0000-4000-8000-0000000000a1";
const MAX = "00000000-0000-4000-8000-0000000000b1";
const ERIN = "00000000-0000-4000-8000-0000000000c1";
const LUCAS = "00000000-0000-4000-8000-0000000000c2";
const RUN = Date.now().toString(36);
const SINK = "http://rest:3000/rpc/it_webhook_sink";
const FAIL = "http://rest:3000/rpc/it_webhook_fail";
const ALL_EVENTS = [
  "timesheet.submitted",
  "timesheet.approved",
  "timesheet.returned",
  "alert.raised",
  "person.invited",
  "person.deactivated",
  "time_off.decided",
];

type Json = Record<string, unknown>;

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

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

async function rpc<T = unknown>(name: string, token: string, body: Json = {}): Promise<T> {
  const r = await rest(`/rest/v1/rpc/${name}`, token, { body });
  assert.ok(r.status < 300, `${name}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json as T;
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

function sql(statement: string) {
  return execFileSync(
    "psql",
    [dbUrl, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", statement],
    {
      encoding: "utf8",
    },
  ).trim();
}

async function deliverNow() {
  const res = await fetch(`${url}/functions/v1/deliver-webhooks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 200, `deliver-webhooks: ${await res.clone().text()}`);
  return (await res.json()) as { claimed: number; delivered: number; failed: number };
}

interface Received {
  headers: Record<string, string>;
  body: string;
}

async function received(): Promise<Received[]> {
  const r = await rest("/rest/v1/it_webhook_received?select=headers,body&order=id", service);
  assert.equal(r.status, 200, `receiver rows: ${JSON.stringify(r.json)}`);
  return r.json as Received[];
}

/** The receiver's request for an event of this type about this id (data.id or data.user_id). */
async function find(type: string, about: string): Promise<Received | undefined> {
  return (await received()).find((r) => {
    const b = JSON.parse(r.body) as { type: string; data: Json };
    return b.type === type && (b.data.id === about || b.data.user_id === about);
  });
}

async function waitFor<T>(what: string, ms: number, probe: () => Promise<T | undefined>) {
  const until = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got !== undefined) return got;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((res) => setTimeout(res, 1000));
  }
}

function verify(r: Received, secret: string) {
  const ts = r.headers["x-aiproctor-timestamp"] ?? "";
  const sig = r.headers["x-aiproctor-signature"] ?? "";
  const want = createHmac("sha256", secret).update(`${ts}.${r.body}`).digest("hex");
  return sig === `v1=${want}`;
}

function checkRequest(r: Received, secret: string, type: string) {
  const body = JSON.parse(r.body) as Json;
  assert.ok(verify(r, secret), `${type}: the signature verifies with the endpoint's secret`);
  assert.ok(
    Math.abs(Date.now() / 1000 - Number(r.headers["x-aiproctor-timestamp"])) < 600,
    "a fresh timestamp",
  );
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(r.headers["x-aiproctor-event"], type);
  assert.equal(r.headers["x-aiproctor-event-id"], body.id, "the event id header is the body's id");
  assert.match(r.headers["x-aiproctor-delivery"] ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(body.type, type);
  assert.equal(body.api_version, "v1");
  assert.match(String(body.created_at), /T.*([+-]\d{2}:\d{2}|Z)$/);
  return body.data as Json;
}

const admin = await signIn("admin@acme.test");
const manager = await signIn("manager@acme.test");
const erin = await signIn("erin@acme.test");
const lucas = await signIn("lucas@acme.test");
const made: string[] = [];

try {
  // Endpoints ---------------------------------------------------------------------------------

  const [sink] = await rpc<{ id: string; secret: string }[]>("create_webhook", admin, {
    p_url: SINK,
    p_events: ALL_EVENTS,
  });
  made.push(sink.id);
  assert.match(sink.secret, /^whsec_[A-Za-z0-9_-]{43}$/, "the secret is shown once, on creation");
  const [failing] = await rpc<{ id: string }[]>("create_webhook", admin, {
    p_url: FAIL,
    p_events: ["person.invited", "person.deactivated"],
  });
  made.push(failing.id);
  const refused = await rest("/rest/v1/rpc/create_webhook", manager, {
    body: { p_url: "https://x.example.com/h", p_events: ["person.invited"] },
  });
  assert.equal(refused.status, 403, "a manager can't add an endpoint");
  const listed = JSON.stringify(await rpc("list_webhooks", admin));
  assert.ok(
    listed.includes(SINK) && !listed.includes(sink.secret),
    "the list never shows the secret",
  );
  const direct = await rest("/rest/v1/webhooks?select=id", manager);
  assert.deepEqual(direct.json, [], "a manager reads no endpoints through PostgREST");

  // person.invited, delivered by the cron job (webhooks_kick → pg_net → deliver-webhooks) ---------

  const email = `wanda-${RUN}@acme.test`;
  const created = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: service,
      Authorization: `Bearer ${service}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password: "password123", email_confirm: true }),
  });
  assert.equal(created.status, 200, `create auth user: ${await created.clone().text()}`);
  const WANDA = ((await created.json()) as { id: string }).id;
  const inserted = await rest("/rest/v1/users", service, {
    body: {
      id: WANDA,
      org_id: ORG,
      full_name: "Wanda Webhook",
      email,
      role: "employee",
      manager_id: MAX,
    },
    prefer: "return=minimal",
  });
  assert.equal(inserted.status, 201, `users row: ${JSON.stringify(inserted.json)}`);

  const invited = await waitFor("the cron job to deliver person.invited", 130_000, () =>
    find("person.invited", WANDA),
  );
  const person = checkRequest(invited, sink.secret, "person.invited");
  assert.equal(person.email, email, "the data is the API's Person");
  assert.equal(person.full_name, "Wanda Webhook");

  // The failing endpoint answered 400 and waits for its next attempt.
  const failedOnce = await waitFor("the failing endpoint's first attempt", 30_000, async () => {
    const log = await rpc<Json[]>("list_webhook_deliveries", admin, { p_webhook_id: failing.id });
    const d = log.find((x) => x.event_type === "person.invited" && x.attempts === 1);
    return d && d.response_status === 400 ? d : undefined;
  });
  assert.equal(failedOnce.status, "pending", "a failed attempt is retried");
  assert.equal(failedOnce.last_error, "HTTP 400");
  const nextIn =
    Date.parse(String(failedOnce.next_attempt_at)) - Date.parse(String(failedOnce.last_attempt_at));
  assert.ok(nextIn > 55_000 && nextIn < 65_000, `the first retry is a minute later (${nextIn} ms)`);

  // Timesheet submitted and approved, through the dashboard's RPCs --------------------------------

  const weeksBack = 30 + (Number.parseInt(RUN.slice(-4), 36) % 60);
  const la = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  la.setDate(la.getDate() - ((la.getDay() + 6) % 7) - 7 * weeksBack);
  const week = `${la.getFullYear()}-${String(la.getMonth() + 1).padStart(2, "0")}-${String(la.getDate()).padStart(2, "0")}`;
  const sheet = await rpc<string>("ensure_timesheet", lucas, {
    p_user_id: LUCAS,
    p_period_start: week,
  });
  assert.equal(await rpc<string>("submit_timesheet", lucas, { p_id: sheet }), "submitted");
  await rpc("approve_timesheet", manager, { p_id: sheet });

  // Time off decided.
  const vacation = (
    (await rest(`/rest/v1/leave_types?select=id&org_id=eq.${ORG}&name=eq.Vacation`, erin)).json as {
      id: string;
    }[]
  )[0];
  const offset = 100 + (Number.parseInt(RUN.slice(-3), 36) % 200);
  const day = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const leaveId = await rpc<string>("request_leave", erin, {
    p_leave_type_id: vacation.id,
    p_first_day: day,
    p_note: "Private trip note",
  });
  await rpc("decide_leave", manager, {
    p_request_id: leaveId,
    p_approve: true,
    p_note: "Private reply",
  });

  // An alert (as alert_eval writes it: one row per recipient).
  const episode = `it-${RUN}`;
  const since = new Date().toISOString();
  const alerts = await rest("/rest/v1/alerts", service, {
    body: [ADA, MAX].map((recipient) => ({
      org_id: ORG,
      user_id: ERIN,
      recipient_id: recipient,
      kind: "offline",
      episode,
      details: { since },
    })),
    prefer: "return=minimal",
  });
  assert.equal(alerts.status, 201, `alerts: ${JSON.stringify(alerts.json)}`);

  await deliverNow();
  const submitted = await waitFor("timesheet.submitted", 30_000, () =>
    find("timesheet.submitted", sheet),
  );
  let data = checkRequest(submitted, sink.secret, "timesheet.submitted");
  assert.equal(data.user_id, LUCAS);
  assert.equal(data.previous_status, "draft");
  assert.equal(typeof data.worked_s, "number", "with the week's totals in seconds");
  const approved = await waitFor("timesheet.approved", 30_000, () =>
    find("timesheet.approved", sheet),
  );
  data = checkRequest(approved, sink.secret, "timesheet.approved");
  assert.equal(data.approver_id, MAX, "with the approver");

  const decided = await waitFor("time_off.decided", 30_000, () =>
    find("time_off.decided", leaveId),
  );
  data = checkRequest(decided, sink.secret, "time_off.decided");
  assert.equal(data.status, "approved");
  assert.equal(data.decided_by, MAX);
  assert.ok(!decided.body.includes("Private"), "never the note or the decision note");

  const alertRows = (await received()).filter((r) => {
    const b = JSON.parse(r.body) as { type: string; data: Json };
    return b.type === "alert.raised" && (b.data.details as Json | undefined)?.since === since;
  });
  assert.equal(alertRows.length, 1, "an alert to two recipients is one event");
  data = checkRequest(alertRows[0] as Received, sink.secret, "alert.raised");
  assert.equal(data.kind, "offline");

  // Deactivated: the failing endpoint now fails for good and is turned off --------------------

  await rpc("set_user_active", admin, { p_user_id: WANDA, p_active: false });
  // As if the failing endpoint had already failed 4 events, each 6 times.
  await rest(`/rest/v1/webhooks?id=eq.${failing.id}`, service, {
    method: "PATCH",
    body: { failed_in_row: 4 },
  });
  await rest(
    `/rest/v1/webhook_deliveries?webhook_id=eq.${failing.id}&event_type=eq.person.deactivated`,
    service,
    {
      method: "PATCH",
      body: { attempts: 6, status: "pending", next_attempt_at: new Date().toISOString() },
    },
  );
  await deliverNow();
  const deactivated = await waitFor("person.deactivated", 30_000, () =>
    find("person.deactivated", WANDA),
  );
  assert.equal(checkRequest(deactivated, sink.secret, "person.deactivated").active, false);
  const off = await waitFor("the failing endpoint to be turned off", 30_000, async () => {
    const w = (await rpc<Json[]>("list_webhooks", admin)).find((x) => x.id === failing.id);
    return w?.enabled === false ? w : undefined;
  });
  assert.equal(off?.enabled, false, "5 failed events in a row turn the endpoint off");
  assert.equal(off?.disabled_reason, "failing");
  const log = await rpc<Json[]>("list_webhook_deliveries", admin, { p_webhook_id: failing.id });
  const gaveUp = log.find((d) => d.event_type === "person.deactivated");
  assert.equal(gaveUp?.status, "failed", "after its last attempt the delivery has failed");
  assert.equal(gaveUp?.attempts, 7);
  assert.equal(gaveUp?.response_status, 400, "the log keeps the response code");
  const notes = await rest(
    "/rest/v1/notifications?select=kind,payload&kind=eq.webhook.disabled",
    admin,
  );
  assert.ok(
    (notes.json as { payload: Json }[]).some((n) => n.payload.webhook_id === failing.id),
    "the owner is notified",
  );

  // Rotating: the next event is signed with the new secret ---------------------------------------

  const rotated = await rpc<string>("rotate_webhook_secret", admin, { p_id: sink.id });
  assert.notEqual(rotated, sink.secret);
  await rpc("set_user_active", admin, { p_user_id: LUCAS, p_active: false });
  await rpc("set_user_active", admin, { p_user_id: LUCAS, p_active: true });
  await deliverNow();
  const lucasOff = await waitFor("person.deactivated after rotating", 30_000, () =>
    find("person.deactivated", LUCAS),
  );
  checkRequest(lucasOff, rotated, "person.deactivated");
  assert.ok(!verify(lucasOff, sink.secret), "the old secret no longer verifies");

  // Changing and turning back on.
  await rpc("update_webhook", admin, {
    p_id: failing.id,
    p_url: FAIL,
    p_events: ["person.invited"],
    p_enabled: true,
  });
  const back = (await rpc<Json[]>("list_webhooks", admin)).find((w) => w.id === failing.id);
  assert.equal(back?.enabled, true, "an admin turns it back on");
  assert.deepEqual(back?.events, ["person.invited"]);

  // Production: a host that resolves to a private address is refused at delivery ------------------

  const [privateHost] = await rpc<{ id: string }[]>("create_webhook", admin, {
    p_url: "https://rest:3000/rpc/it_webhook_sink",
    p_events: ["alert.raised"],
  });
  made.push(privateHost.id);
  sql(
    "select vault.update_secret(id, 'false') from vault.secrets where name = 'webhooks_allow_private_hosts'",
  );
  try {
    const bad = await rest("/rest/v1/rpc/create_webhook", admin, {
      body: { p_url: "https://10.1.2.3/hook", p_events: ["alert.raised"] },
    });
    assert.equal(bad.status, 400, "a private address is refused when the endpoint is saved");
    await rest("/rest/v1/alerts", service, {
      body: {
        org_id: ORG,
        user_id: ERIN,
        recipient_id: MAX,
        kind: "offline",
        episode: `${episode}-private`,
        details: {},
      },
      prefer: "return=minimal",
    });
    await deliverNow();
    const blocked = await waitFor("the private host to be refused", 30_000, async () => {
      const d = (
        await rpc<Json[]>("list_webhook_deliveries", admin, { p_webhook_id: privateHost.id })
      )[0];
      return d?.attempts === 1 ? d : undefined;
    });
    assert.equal(
      blocked?.last_error,
      "refused: the host resolves to a private or local address",
      "and when its host resolves to one at delivery",
    );
  } finally {
    sql(
      "select vault.update_secret(id, 'true') from vault.secrets where name = 'webhooks_allow_private_hosts'",
    );
  }

  // Audit ---------------------------------------------------------------------------------------

  const audit = await rpc<{ action: string; actor_id: string | null; metadata: Json }[]>(
    "search_audit_log",
    admin,
    {
      p_actions: [
        "webhook.created",
        "webhook.changed",
        "webhook.secret_rotated",
        "webhook.disabled",
        "webhook.deleted",
      ],
      p_limit: 200,
    },
  );
  const about = (action: string, id: string) =>
    audit.find((a) => a.action === action && a.metadata.webhook_id === id);
  assert.equal(about("webhook.created", sink.id)?.actor_id, ADA, "creating is audit-logged");
  assert.equal(about("webhook.created", sink.id)?.metadata.host, "rest", "with the host");
  assert.ok(about("webhook.secret_rotated", sink.id), "rotating is audit-logged");
  assert.ok(about("webhook.changed", failing.id), "changing is audit-logged");
  assert.equal(
    about("webhook.disabled", failing.id)?.actor_id,
    null,
    "turning off by the system too",
  );
  assert.ok(!JSON.stringify(audit).includes(sink.secret), "never with the secret");

  await rpc("delete_webhook", admin, { p_id: privateHost.id });
  made.splice(made.indexOf(privateHost.id), 1);
  const deleted = await rpc<{ action: string; metadata: Json }[]>("search_audit_log", admin, {
    p_actions: ["webhook.deleted"],
    p_limit: 50,
  });
  assert.ok(
    deleted.some((a) => a.metadata.webhook_id === privateHost.id),
    "deleting is audit-logged",
  );
} finally {
  for (const id of made) await rest("/rest/v1/rpc/delete_webhook", admin, { body: { p_id: id } });
}

console.log("it-webhooks: ok");
