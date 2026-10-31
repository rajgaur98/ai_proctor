// Integration check for delete-checkin-parts (#253; EMP-06, CAP-09, AUD-01) against a
// local stack. A new employee, Pia, passes a check-in with a screenshot and a webcam
// frame (both uploaded) while a browser is in front. Then:
//  - her manager, the owner, a peer and the anon key are refused, and nothing changes;
//  - she removes the webcam frame only: it is gone from Storage, the screenshot is not,
//    the agent can't upload the frame again, the manager's capture view lists only the
//    screenshot and says the webcam was removed, the check-in still passed;
//  - she removes the rest (screen, apps, domains): nothing of the check-in is left in
//    Storage or in the minute's activity, and the audit log has capture.deleted and
//    activity.deleted rows with her as actor and subject.
// Run it through `pnpm it:checkin-parts` (see scripts/it-checkin-parts.sh).
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
    "Set AI_PROCTOR_SUPABASE_URL, _ANON_KEY and _SERVICE_ROLE_KEY (pnpm it:checkin-parts).",
  );
  process.exit(2);
}

const ORG = "00000000-0000-4000-8000-000000000001";
const ADA = "00000000-0000-4000-8000-0000000000a1";
// A 1×1 WebP.
const WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

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
    headers: {
      apikey: token === service ? service : anon,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
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

/** Acts as a user's agent through the real sync RPCs. */
async function agent(email: string) {
  const token = await signIn(email);
  const device = await call("/rest/v1/rpc/register_device", token, {
    body: {
      platform: "macos",
      os_version: "26.0",
      agent_version: "0.1.0",
      hardware_hash: `it-checkin-parts-${randomUUID()}`,
    },
  });
  assert.equal(device.status, 200, "register_device");
  const deviceId = (Array.isArray(device.json) ? device.json[0] : device.json).device_id as string;
  const notice = await call("/rest/v1/notices?select=id&order=version.desc&limit=1", token);
  const ack = await call("/rest/v1/rpc/acknowledge_notice", token, {
    body: { p_notice_id: notice.json[0].id },
  });
  assert.equal(ack.status, 204, `acknowledge_notice ${JSON.stringify(ack.json)}`);

  let seq = 0;
  const send = async (type: string, payload: object, at: Date, id = randomUUID()) => {
    seq += 1;
    const sent = await call("/rest/v1/rpc/agent_events", token, {
      body: {
        device_id: deviceId,
        events: [{ id, seq, type, at: at.toISOString(), mono_ms: seq, payload }],
      },
    });
    assert.equal(sent.status, 200, `${type}: ${JSON.stringify(sent.json)}`);
    assert.deepEqual(sent.json.rejected, [], `${type} rejected`);
    return id;
  };
  return { token, send };
}

/** Whether a file is in the captures bucket, asked of Storage itself with the service role. */
async function inStorage(path: string): Promise<boolean> {
  const res = await fetch(`${url}/storage/v1/object/captures/${path}`, {
    headers: { apikey: service, Authorization: `Bearer ${service}` },
  });
  await res.arrayBuffer();
  return res.status === 200;
}

async function upload(path: string, token: string) {
  const res = await fetch(`${url}/storage/v1/object/captures/${path}`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "image/webp" },
    body: WEBP,
  });
  return { status: res.status, text: await res.text() };
}

const base = Date.now();
const ago = (minutes: number) => new Date(base - minutes * 60_000);
const remove = (token: string, body: unknown) =>
  call("/functions/v1/delete-checkin-parts", token, { body });

// Setup: Pia, a new employee under the owner ----------------------------------------------

const email = `pia-${Date.now()}@acme.test`;
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
const PIA = ((await created.json()) as { id: string }).id;
const added = await call("/rest/v1/rpc/add_invited_member", service, {
  body: {
    p_inviter_id: ADA,
    p_user_id: PIA,
    p_email: email,
    p_full_name: "Pia Parts",
    p_role: "employee",
    p_manager_id: ADA,
    p_work_country: "US",
    p_work_state: "CA",
    p_timezone: "America/Los_Angeles",
  },
});
assert.equal(added.status, 204, `add_invited_member: ${JSON.stringify(added.json)}`);

const pia = await agent(email);
await pia.send("clock_in", { reason: "manual" }, ago(120));
// Answered 20 s into a whole minute an hour ago, with a browser in front.
const minute = new Date(Math.floor(ago(60).getTime() / 60_000) * 60_000);
const answered = new Date(minute.getTime() + 20_000);
const checkinId = await pia.send(
  "checkin",
  {
    scheduled_at: answered.toISOString(),
    shown_at: answered.toISOString(),
    responded_at: answered.toISOString(),
    outcome: "pass",
    response_ms: 2000,
    wrong_clicks: 0,
    object_keys: ["screen-1.webp", "webcam.webp"],
    flags: [],
  },
  answered,
);
await pia.send(
  "app_session",
  {
    app: "Safari",
    title: "Payroll - Example",
    domain: "payroll.example.com",
    start: minute.toISOString(),
    end: new Date(minute.getTime() + 50_000).toISOString(),
  },
  new Date(minute.getTime() + 50_000),
);
await pia.send("clock_out", { reason: "manual" }, ago(5));

const folder = `${ORG}/${PIA}/${answered.toISOString().slice(0, 10)}/${checkinId}`;
const screen = `${folder}/screen-1.webp`;
const webcam = `${folder}/webcam.webp`;
for (const path of [screen, webcam]) {
  const up = await upload(path, pia.token);
  assert.equal(up.status, 200, `upload ${path}: ${up.text}`);
}
assert.ok((await inStorage(screen)) && (await inStorage(webcam)), "setup: both files in Storage");

const samples = async () =>
  (
    await call(
      `/rest/v1/activity_samples?user_id=eq.${PIA}&minute=eq.${encodeURIComponent(minute.toISOString())}&select=app_name,domain,window_title`,
      service,
    )
  ).json as { app_name: string; domain: string | null; window_title: string | null }[];
assert.equal((await samples()).length, 1, "setup: the minute's sample");

const checkin = async () =>
  (
    await call(
      `/rest/v1/checkin_events?id=eq.${checkinId}&select=outcome,webcam_deleted_at,screen_deleted_at,apps_deleted_at,domains_deleted_at`,
      service,
    )
  ).json[0] as Record<string, string | null>;

// Nobody but Pia --------------------------------------------------------------------------

const adaToken = await signIn("admin@acme.test");
const maxToken = await signIn("manager@acme.test");
const lucasToken = await signIn("lucas@acme.test");
for (const [who, token] of [
  ["the owner", adaToken],
  ["a manager", maxToken],
  ["a peer", lucasToken],
] as const) {
  const r = await remove(token, { checkin_id: checkinId, parts: ["webcam", "screen"] });
  assert.equal(r.status, 404, `${who} is refused: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.error, "checkin_not_found");
}
const anonymous = await remove(anon, { checkin_id: checkinId, parts: ["webcam"] });
assert.equal(anonymous.status, 401, `the anon key is refused: ${JSON.stringify(anonymous.json)}`);
const bad = await remove(pia.token, { checkin_id: checkinId, parts: ["titles"] });
assert.equal(bad.status, 400, "an unknown part is refused");
assert.ok((await inStorage(screen)) && (await inStorage(webcam)), "a refusal removes nothing");
assert.equal((await checkin()).webcam_deleted_at, null, "and sets no tombstone");

// The webcam frame only ---------------------------------------------------------------------

const first = await remove(pia.token, { checkin_id: checkinId, parts: ["webcam"] });
assert.equal(first.status, 200, `Pia removes the webcam frame: ${JSON.stringify(first.json)}`);
assert.equal(first.json.objects_removed, 1, "one object removed");
assert.equal(await inStorage(webcam), false, "the webcam frame is gone from Storage");
assert.equal(await inStorage(screen), true, "the screenshot is still there");
const reupload = await upload(webcam, pia.token);
assert.notEqual(reupload.status, 200, "the agent can't upload the webcam frame again");
assert.equal(await inStorage(webcam), false, "still gone");

const view = await call("/functions/v1/capture-url", adaToken, { body: { checkin_id: checkinId } });
assert.equal(view.status, 200, `the owner opens the capture: ${JSON.stringify(view.json)}`);
assert.deepEqual(
  view.json.files.map((f: { name: string }) => f.name),
  ["screen-1.webp"],
  "only the screenshot is listed",
);
assert.ok(view.json.removed.webcam, "and the webcam frame reads as removed");
assert.equal(view.json.app, "Safari", "the app is still there");
const afterWebcam = await checkin();
assert.equal(afterWebcam.outcome, "pass", "the check-in still passed");
assert.ok(afterWebcam.webcam_deleted_at && !afterWebcam.screen_deleted_at, "webcam tombstone only");

// Everything else ---------------------------------------------------------------------------

const rest = await remove(pia.token, {
  checkin_id: checkinId,
  parts: ["screen", "apps", "domains"],
});
assert.equal(rest.status, 200, `Pia removes the rest: ${JSON.stringify(rest.json)}`);
assert.equal(await inStorage(screen), false, "the screenshot is gone from Storage");
assert.deepEqual(await samples(), [], "the minute's activity is gone");
const all = await checkin();
assert.equal(all.outcome, "pass", "still a pass");
for (const part of ["webcam", "screen", "apps", "domains"]) {
  assert.ok(all[`${part}_deleted_at`], `${part} has its tombstone`);
}
const raw = await call(
  `/rest/v1/agent_events_raw?user_id=eq.${PIA}&type=eq.app_session&select=payload`,
  service,
);
assert.equal(raw.status, 200, `raw events: ${JSON.stringify(raw.json)}`);
for (const r of raw.json as { payload: Record<string, unknown> }[]) {
  assert.ok(!("app" in r.payload) && !("domain" in r.payload), "no app or domain in the raw event");
}

const again = await remove(pia.token, { checkin_id: checkinId, parts: ["webcam", "screen"] });
assert.equal(again.status, 200, "running it again is fine");
assert.equal(again.json.objects_removed, 0, "and removes nothing more");

const audit = await call(
  `/rest/v1/audit_log?target_user_id=eq.${PIA}&action=in.(capture.deleted,activity.deleted)&select=action,actor_id,metadata&order=id`,
  // The audit log is read by owners and admins (AUD-02).
  adaToken,
);
assert.equal(audit.status, 200, `audit: ${JSON.stringify(audit.json)}`);
assert.deepEqual(
  (audit.json as { action: string; actor_id: string; metadata: { parts: string[] } }[]).map((a) => [
    a.action,
    a.actor_id,
    a.metadata.parts,
  ]),
  [
    ["capture.deleted", PIA, ["webcam"]],
    ["capture.deleted", PIA, ["screen"]],
    ["activity.deleted", PIA, ["apps", "domains"]],
  ],
  "one audit row per kind of data per removal, Pia as the actor",
);

console.log("it-checkin-parts: ok");
