// Integration check for the rebuild-segments Edge Function (#41) against a local
// stack: Erin clocks in, passes a check-in, misses one, passes again and clocks
// out (through the same RPCs the agent uses); the function, called as the cron
// would (service-role key), turns that into time_segments with exact seconds; and
// the signed-in path and RLS are exercised. Run it through
// `pnpm it:rebuild-segments`, on a freshly reset stack (see CLAUDE.md).
//
// Needs AI_PROCTOR_SUPABASE_URL, AI_PROCTOR_SUPABASE_ANON_KEY and
// AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY (the wrapper script sets them).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.AI_PROCTOR_SUPABASE_URL ?? "";
const anon = process.env.AI_PROCTOR_SUPABASE_ANON_KEY ?? "";
const service = process.env.AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !anon || !service) {
  console.error(
    "Set AI_PROCTOR_SUPABASE_URL, _ANON_KEY and _SERVICE_ROLE_KEY (pnpm it:rebuild-segments).",
  );
  process.exit(2);
}

const ERIN = "00000000-0000-4000-8000-0000000000c1";
const ERIN_ZONE = "America/Los_Angeles";

function parse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function call(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${url}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? parse(text) : null };
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

const rebuild = (token: string, body: unknown) =>
  call("/functions/v1/rebuild-segments", token, { body });
const segmentsOf = async (token: string) =>
  (await call(`/rest/v1/time_segments?user_id=eq.${ERIN}&order=start_at`, token)).json as {
    type: string;
    start_at: string;
    end_at: string;
    counted: boolean;
    flagged: boolean;
    day: string;
    source: string;
  }[];
const epoch = (iso: string) => Math.round(Date.parse(iso) / 1000);

// Fresh state: no earlier run's shifts mixed in.
const before = await call(`/rest/v1/clock_sessions?user_id=eq.${ERIN}&select=id`, service);
assert.equal(
  before.json.length,
  0,
  "Erin already has shifts: run scripts/stack.sh reset and scripts/stack-secrets.sh first",
);

// Agent side: events, through the RPC.
const erin = await signIn("erin@acme.test");
const device = await call("/rest/v1/rpc/register_device", erin, {
  body: {
    platform: "macos",
    os_version: "26.0",
    agent_version: "0.1.0",
    hardware_hash: `it-${randomUUID()}`,
  },
});
assert.equal(device.status, 200, "register_device");
const deviceId = (Array.isArray(device.json) ? device.json[0] : device.json).device_id as string;

// Whole seconds, so the expectations are exact. The scripted hour has to sit inside one of
// Erin's local days, or the rebuild rightly cuts it at her midnight (#295): within the hour
// after midnight, it ends a minute before it instead.
const now = Math.floor(Date.now() / 1000);
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: ERIN_ZONE,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})
  .format(new Date(now * 1000))
  .split(":")
  .map(Number);
const sinceMidnight = clock[0] * 3600 + clock[1] * 60 + clock[2];
const base = sinceMidnight < 3600 ? now - sinceMidnight - 60 : now;
const at = (minutesAgo: number) => new Date((base - minutesAgo * 60) * 1000).toISOString();
const checkin = (minutesAgo: number, outcome: "pass" | "miss") => ({
  scheduled_at: at(minutesAgo),
  shown_at: at(minutesAgo),
  responded_at: outcome === "pass" ? at(minutesAgo - 0.1) : null,
  outcome,
  wrong_clicks: 0,
  object_keys: [],
  flags: [],
});
const script: [string, number, object][] = [
  ["clock_in", 60, { reason: "manual" }],
  ["checkin", 50, checkin(50, "pass")],
  ["checkin", 40, checkin(40, "miss")],
  ["checkin", 20, checkin(20, "pass")],
  ["clock_out", 5, { reason: "manual" }],
];
const events = script.map(([type, minutesAgo, payload], i) => ({
  id: randomUUID(),
  seq: i + 1,
  type,
  at: at(minutesAgo),
  mono_ms: i + 1,
  payload,
}));
const sent = await call("/rest/v1/rpc/agent_events", erin, {
  body: { device_id: deviceId, events },
});
assert.equal(sent.status, 200, "agent_events");
assert.deepEqual(sent.json.rejected, [], "no event rejected");
assert.equal(sent.json.accepted.length, events.length);

// The events marked Erin's days dirty.
const dirty = await call(`/rest/v1/dirty_days?user_id=eq.${ERIN}`, service);
assert.ok(dirty.json.length >= 1, "the events marked a day dirty");

// Cron side: the service role works through the dirty days.
const cron = await rebuild(service, {});
assert.equal(cron.status, 200, JSON.stringify(cron.json));
assert.equal(cron.json.failed, 0, JSON.stringify(cron.json));
assert.ok(cron.json.rebuilt >= 1, "cron rebuilt Erin's day");
assert.equal(
  (await call(`/rest/v1/dirty_days?user_id=eq.${ERIN}`, service)).json.length,
  0,
  "dirty marks cleared",
);

// Verified for 20 min, unverified for 20 min (from the missed card until the next
// pass), then verified for 15 min until clock-out.
const expected = [
  { type: "verified", start: base - 3600, end: base - 2400, counted: true, flagged: false },
  { type: "unverified", start: base - 2400, end: base - 1200, counted: true, flagged: true },
  { type: "verified", start: base - 1200, end: base - 300, counted: true, flagged: false },
];
const rows = await segmentsOf(service);
assert.deepEqual(
  rows.map((r) => ({
    type: r.type,
    start: epoch(r.start_at),
    end: epoch(r.end_at),
    counted: r.counted,
    flagged: r.flagged,
  })),
  expected,
);
assert.ok(rows.every((r) => r.source === "auto"));
const worked = rows
  .filter((r) => r.counted)
  .reduce((s, r) => s + epoch(r.end_at) - epoch(r.start_at), 0);
assert.equal(worked, 55 * 60, "55 minutes worked, from raw seconds");
console.log("ok  cron rebuild: verified 1200 s, unverified 1200 s (flagged), verified 900 s");

// Signed-in path: one day, only for someone the caller may view.
const day = new Intl.DateTimeFormat("en-CA", { timeZone: ERIN_ZONE }).format(
  new Date((base - 3600) * 1000),
);
const own = await rebuild(erin, { user_id: ERIN, day });
assert.equal(own.status, 200, JSON.stringify(own.json));
assert.equal(own.json.failed, 0);
assert.deepEqual(
  (await segmentsOf(service)).map((r) => r.type),
  expected.map((e) => e.type),
  "rebuilding twice gives the same segments",
);
assert.equal((await rebuild(erin, { user_id: ERIN, day: "2026-13-40" })).status, 400, "bad day");
const lucas = await signIn("lucas@acme.test");
assert.equal(
  (await rebuild(lucas, { user_id: ERIN, day })).status,
  403,
  "a peer can't ask for Erin's day",
);
assert.equal((await rebuild(anon, { user_id: ERIN, day })).status, 401, "anonymous");
console.log("ok  signed-in path: own day rebuilt, peer 403, anonymous 401");

// RLS on the result: Erin and her manager read the segments, a peer doesn't.
const manager = await signIn("manager@acme.test");
assert.equal((await segmentsOf(erin)).length, expected.length, "Erin reads her own");
assert.equal((await segmentsOf(manager)).length, expected.length, "her manager reads them");
assert.equal((await segmentsOf(lucas)).length, 0, "a peer reads none");
console.log("ok  row-level security: employee and manager read, peer doesn't");

// A day that fails every time (#126): a date the database can't turn into timestamps.
// The cron run records the failure and backs the day off instead of retrying it first
// on every run.
const POISON = "294277-01-01";
const poisonRow = () =>
  call(`/rest/v1/dirty_days?user_id=eq.${ERIN}&day=eq.${POISON}`, service).then(
    (r) => r.json[0] as { attempts: number; last_error: string | null; next_attempt_at: string },
  );
const inserted = await call("/rest/v1/dirty_days", service, {
  body: { user_id: ERIN, day: POISON },
});
assert.ok(inserted.status < 300, `insert poison day: ${JSON.stringify(inserted.json)}`);
const failing = await rebuild(service, {});
assert.equal(failing.status, 200, JSON.stringify(failing.json));
assert.equal(failing.json.failed, 1, JSON.stringify(failing.json));
const failed = await poisonRow();
assert.equal(failed.attempts, 1, "the failure was counted");
assert.ok(failed.last_error, "and its error kept");
assert.ok(
  Date.parse(failed.next_attempt_at) > Date.now() + 4 * 60 * 1000,
  "and the day backed off",
);
const quiet = await rebuild(service, {});
assert.equal(quiet.json.days.length, 0, "a backed-off day isn't picked again");
assert.equal((await poisonRow()).attempts, 1, "and isn't counted again");
const cleaned = await call(`/rest/v1/dirty_days?user_id=eq.${ERIN}&day=eq.${POISON}`, service, {
  method: "DELETE",
});
assert.ok(cleaned.status < 300, "poison day removed");
console.log("ok  poison day: failure recorded, backed off, not retried until due");
