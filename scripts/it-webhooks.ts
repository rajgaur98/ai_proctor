// Integration check for webhooks (#320, #335; API-06) against a local stack; see it-webhooks.sh,
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

/** The v1= values of the signature header, in order (two during a rotation's grace period). */
function signatures(r: Received): string[] {
  return (r.headers["x-aiproctor-signature"] ?? "").split(",").map((v) => v.trim());
}

function signedWith(r: Received, secret: string) {
  const ts = r.headers["x-aiproctor-timestamp"] ?? "";
  return `v1=${createHmac("sha256", secret).update(`${ts}.${r.body}`).digest("hex")}`;
}

/** As docs/api/v1.md tells receivers: any one of the values verifies. */
function verify(r: Received, secret: string) {
  return signatures(r).includes(signedWith(r, secret));
}

function checkRequest(r: Received, secret: string, type: string) {
  const body = JSON.parse(r.body) as Json;
  assert.ok(verify(r, secret), `${type}: the signature verifies with the endpoint's secret`);
  assert.ok(
    Math.abs(Date.now() / 1000 - Number(r.headers["x-aiproctor-timestamp"])) < 600,
    "a fresh timestamp",
  );
  assert.equal(r.headers["content-type"], "application/json");
  // The connection went to the address deliver-webhooks resolved (pin.ts), by IP, with the
  // URL's own Host header.
  assert.equal(r.headers.host, "rest:3000", "the original Host header");
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

  // Test event (#335): a ping, queued and sent through the normal path ----------------------

  const pingDelivery = await rpc<string>("send_test_webhook", admin, { p_id: sink.id });
  const ping = await waitFor("the test event", 30_000, async () =>
    (await received()).find((r) => r.headers["x-aiproctor-delivery"] === pingDelivery),
  );
  data = checkRequest(ping, sink.secret, "ping");
  assert.deepEqual(data, { webhook_id: sink.id }, "a ping names its endpoint");
  assert.equal(signatures(ping).length, 1, "one signature outside a rotation's grace period");
  const pingRow = await waitFor("the test event in the log", 30_000, async () =>
    (await rpc<Json[]>("list_webhook_deliveries", admin, { p_webhook_id: sink.id })).find(
      (d) => d.id === pingDelivery && d.status === "delivered",
    ),
  );
  assert.equal(pingRow.event_type, "ping");
  const notAdmin = await rest("/rest/v1/rpc/send_test_webhook", manager, {
    body: { p_id: sink.id },
  });
  assert.equal(notAdmin.status, 403, "a manager can't send a test event");

  // Redeliver (#335): the same event again, as a new delivery -----------------------------------

  const original = (
    await rpc<Json[]>("list_webhook_deliveries", admin, { p_webhook_id: sink.id })
  ).find((d) => d.event_type === "time_off.decided" && d.status === "delivered");
  assert.ok(original, "the time-off event was delivered");
  const again = await rpc<string>("redeliver_webhook", admin, { p_delivery_id: original.id });
  assert.notEqual(again, original.id, "a new delivery id");
  const resent = await waitFor("the redelivery", 30_000, async () =>
    (await received()).find((r) => r.headers["x-aiproctor-delivery"] === again),
  );
  checkRequest(resent, sink.secret, "time_off.decided");
  assert.equal(resent.headers["x-aiproctor-event-id"], original.event_id, "the same event id");
  assert.equal(resent.body, decided.body, "the same event, byte for byte");
  const againRow = await waitFor("the redelivery in the log", 30_000, async () =>
    (await rpc<Json[]>("list_webhook_deliveries", admin, { p_webhook_id: sink.id })).find(
      (d) => d.id === again && d.status === "delivered",
    ),
  );
  assert.equal(againRow.redelivery_of, original.id, "the log links it to the original");
  const pendingCopy = await rpc<string>("redeliver_webhook", admin, { p_delivery_id: original.id });
  const twice = await rest("/rest/v1/rpc/redeliver_webhook", admin, {
    body: { p_delivery_id: original.id },
  });
  assert.equal(twice.status, 400, "not while a copy of the event still waits");
  assert.equal((twice.json as Json).message, "delivery_pending");
  await waitFor("the second redelivery", 30_000, async () =>
    (await received()).find((r) => r.headers["x-aiproctor-delivery"] === pendingCopy),
  );

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

  // Rotating (#335): for 24 hours both secrets sign, the new one first ---------------------------

  const rotated = await rpc<string>("rotate_webhook_secret", admin, { p_id: sink.id });
  assert.notEqual(rotated, sink.secret);
  const graceUntil = (await rpc<Json[]>("list_webhooks", admin)).find(
    (w) => w.id === sink.id,
  )?.previous_secret_expires_at;
  const graceMs = Date.parse(String(graceUntil)) - Date.now();
  assert.ok(graceMs > 23.9 * 3600_000 && graceMs <= 24 * 3600_000, "a 24-hour grace period");
  await rpc("set_user_active", admin, { p_user_id: LUCAS, p_active: false });
  await deliverNow();
  const lucasOff = await waitFor("person.deactivated after rotating", 30_000, () =>
    find("person.deactivated", LUCAS),
  );
  checkRequest(lucasOff, rotated, "person.deactivated");
  assert.deepEqual(
    signatures(lucasOff),
    [signedWith(lucasOff, rotated), signedWith(lucasOff, sink.secret)],
    "two values during the grace period: the new secret's, then the previous one's",
  );
  assert.ok(verify(lucasOff, sink.secret), "a receiver with the old secret still verifies");

  // The grace period ends: the previous secret leaves Vault and only the new one signs.
  sql(
    `update public.webhooks set previous_secret_expires_at = now() - interval '1 second' where id = '${sink.id}'`,
  );
  assert.equal(sql("select internal.webhooks_end_grace()"), "1");
  assert.equal(
    sql(`select count(*) from vault.secrets where name = 'webhook_secret_prev:${sink.id}'`),
    "0",
    "the previous secret is removed from Vault",
  );
  await rpc("set_user_active", admin, { p_user_id: LUCAS, p_active: true });
  const pingAfter = await rpc<string>("send_test_webhook", admin, { p_id: sink.id });
  const afterGrace = await waitFor("a test event after the grace period", 30_000, async () =>
    (await received()).find((r) => r.headers["x-aiproctor-delivery"] === pingAfter),
  );
  checkRequest(afterGrace, rotated, "ping");
  assert.equal(signatures(afterGrace).length, 1, "one signature after the grace period");
  assert.ok(!verify(afterGrace, sink.secret), "the old secret no longer verifies");

  // An endpoint that is off takes no test event and no redelivery.
  const offTest = await rest("/rest/v1/rpc/send_test_webhook", admin, {
    body: { p_id: failing.id },
  });
  assert.equal((offTest.json as Json).message, "webhook_off", "no test event while it's off");
  const offAgain = await rest("/rest/v1/rpc/redeliver_webhook", admin, {
    body: { p_delivery_id: gaveUp?.id },
  });
  assert.equal((offAgain.json as Json).message, "webhook_off", "no redelivery while it's off");

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

    // Over the internet (opt in: IT_WEBHOOKS_INTERNET=1): the pinned connection runs TLS for
    // the host name, so a valid certificate is accepted and one for another name refused.
    if (process.env.IT_WEBHOOKS_INTERNET === "1") {
      const tls: Record<string, string> = {};
      for (const target of ["https://example.com/", "https://wrong.host.badssl.com/"]) {
        const [w] = await rpc<{ id: string }[]>("create_webhook", admin, {
          p_url: target,
          p_events: ["alert.raised"],
        });
        made.push(w.id);
        tls[target] = await rpc<string>("send_test_webhook", admin, { p_id: w.id });
      }
      await deliverNow();
      // Each test event is sent by whichever run claims it first (its own kick or ours).
      const tried = (delivery: string) =>
        waitFor(`the test event ${delivery}`, 30_000, async () =>
          (await rpc<Json[]>("list_webhook_deliveries", admin, { p_limit: 500 })).find(
            (d) => d.id === delivery && (d.response_status !== null || d.last_error !== null),
          ),
        );
      const valid = await tried(tls["https://example.com/"] as string);
      assert.equal(
        typeof valid.response_status,
        "number",
        `example.com answered: ${valid.last_error}`,
      );
      const wrong = await tried(tls["https://wrong.host.badssl.com/"] as string);
      assert.equal(
        wrong.last_error,
        "TLS failed: invalid peer certificate: NotValidForName",
        "a certificate for another name is refused",
      );
    }
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
        "webhook.test_sent",
        "webhook.redelivered",
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
  assert.equal(
    audit.find((a) => a.action === "webhook.test_sent" && a.metadata.delivery_id === pingDelivery)
      ?.actor_id,
    ADA,
    "a test event is audit-logged",
  );
  const redelivered = audit.find(
    (a) => a.action === "webhook.redelivered" && a.metadata.delivery_id === again,
  );
  assert.equal(redelivered?.actor_id, ADA, "a redelivery is audit-logged");
  assert.equal(redelivered?.metadata.redelivery_of, original.id);
  assert.equal(redelivered?.metadata.host, "rest");
  assert.ok(
    about("webhook.secret_rotated", sink.id)?.metadata.previous_valid_until,
    "a rotation records until when the previous secret signs",
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
