// Integration check for the export-my-data Edge Function (#49, EMP-04) against a
// local stack. Erin and Lucas each pass check-ins with a screenshot; Erin also has a
// check-in past the retention window, a miss, and a webcam frame that never uploaded.
// Her manager and she herself open one of her captures. Then:
//  - Erin's export is a ZIP with every dataset (JSON and CSV), the in-retention
//    screenshot byte for byte, no old image, and the manager's view but not her own;
//  - nothing of Lucas's is in it;
//  - the manager's export holds none of Erin's data;
//  - the export is in the audit log; a call without a user's token is refused.
// Run it through `pnpm it:export-my-data` (see scripts/it-export-my-data.sh).
//
// Needs AI_PROCTOR_SUPABASE_URL, AI_PROCTOR_SUPABASE_ANON_KEY and
// AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY (the wrapper script sets them) and `unzip`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env.AI_PROCTOR_SUPABASE_URL ?? "";
const anon = process.env.AI_PROCTOR_SUPABASE_ANON_KEY ?? "";
const service = process.env.AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !anon || !service) {
  console.error(
    "Set AI_PROCTOR_SUPABASE_URL, _ANON_KEY and _SERVICE_ROLE_KEY (pnpm it:export-my-data).",
  );
  process.exit(2);
}

const ORG = "00000000-0000-4000-8000-000000000001";
const ERIN = "00000000-0000-4000-8000-0000000000c1";
const LUCAS = "00000000-0000-4000-8000-0000000000c2";
const MAX = "00000000-0000-4000-8000-0000000000b1";
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

/** Acts as a user's agent through the real sync RPCs. */
async function agent(email: string) {
  const token = await signIn(email);
  const device = await call("/rest/v1/rpc/register_device", token, {
    body: {
      platform: "macos",
      os_version: "26.0",
      agent_version: "0.1.0",
      hardware_hash: `it-export-${randomUUID()}`,
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
  const send = async (
    type: string,
    payload: object,
    at: Date,
    id = randomUUID(),
    mayReject = false,
  ) => {
    seq += 1;
    const sent = await call("/rest/v1/rpc/agent_events", token, {
      body: {
        device_id: deviceId,
        events: [{ id, seq, type, at: at.toISOString(), mono_ms: seq, payload }],
      },
    });
    assert.equal(sent.status, 200, `${type}: ${JSON.stringify(sent.json)}`);
    if (!mayReject) assert.deepEqual(sent.json.rejected, [], `${type} rejected`);
    return id;
  };
  return { token, send };
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const upload = (token: string, path: string) =>
  fetch(`${url}/storage/v1/object/captures/${path}`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "image/webp" },
    body: WEBP,
  });

const base = Date.now();
const ago = (minutes: number) => new Date(base - minutes * 60_000);
const pass = (at: Date, files: string[]) => ({
  scheduled_at: at.toISOString(),
  shown_at: at.toISOString(),
  responded_at: at.toISOString(),
  outcome: "pass",
  response_ms: 2000,
  wrong_clicks: 0,
  object_keys: files,
  flags: [],
});

// Setup ------------------------------------------------------------------------------

const erin = await agent("erin@acme.test");
const lucas = await agent("lucas@acme.test");
// A clock-out first, in case an earlier run left them clocked in (rejected otherwise).
await erin.send("clock_out", { reason: "manual" }, ago(130), randomUUID(), true);
await lucas.send("clock_out", { reason: "manual" }, ago(130), randomUUID(), true);
await erin.send("clock_in", { reason: "manual" }, ago(120));
await lucas.send("clock_in", { reason: "manual" }, ago(120));

const erinPass = await erin.send(
  "checkin",
  pass(ago(60), ["screen-1.webp", "webcam.webp"]),
  ago(60),
);
const erinMiss = await erin.send(
  "checkin",
  {
    scheduled_at: ago(40).toISOString(),
    shown_at: ago(40).toISOString(),
    outcome: "miss",
    wrong_clicks: 0,
    object_keys: [],
    flags: [],
  },
  ago(40),
);
const erinOld = await erin.send("checkin", pass(ago(30), ["screen-1.webp"]), ago(30));
const lucasPass = await lucas.send("checkin", pass(ago(50), ["screen-1.webp"]), ago(50));
await erin.send("clock_out", { reason: "manual" }, ago(5));
await lucas.send("clock_out", { reason: "manual" }, ago(5));

// Only the screenshot arrives (the webcam frame never does).
const pathOf = (user: string, at: Date, checkin: string, file: string) =>
  `${ORG}/${user}/${dayOf(at)}/${checkin}/${file}`;
for (const [token, user, at, id] of [
  [erin.token, ERIN, ago(60), erinPass],
  [lucas.token, LUCAS, ago(50), lucasPass],
] as const) {
  const res = await upload(token, pathOf(user, at, id, "screen-1.webp"));
  assert.equal(res.status, 200, `upload ${await res.clone().text()}`);
}
// Erin's third check-in is moved back past the retention window (30 days) and its
// image put at the old date's path.
const oldAt = new Date(base - 45 * 86_400_000);
const moved = await call(`/rest/v1/checkin_events?id=eq.${erinOld}`, service, {
  method: "PATCH",
  body: { scheduled_at: oldAt.toISOString() },
});
assert.equal(moved.status, 204, `move check-in ${JSON.stringify(moved.json)}`);
const oldPath = pathOf(ERIN, oldAt, erinOld, "screen-1.webp");
const oldUpload = await upload(service, oldPath);
assert.equal(oldUpload.status, 200, `upload old ${await oldUpload.clone().text()}`);

// The manager and Erin herself open her check-in (capture-url, which audit-logs both).
const managerToken = await signIn("manager@acme.test");
const opened = await call("/functions/v1/capture-url", managerToken, {
  body: { checkin_id: erinPass },
});
assert.equal(opened.status, 200, `manager opens captures: ${JSON.stringify(opened.json)}`);
const self = await call("/functions/v1/capture-url", erin.token, {
  body: { checkin_id: erinPass },
});
assert.equal(self.status, 200, "Erin opens her own captures");

// The export ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "export-my-data-"));
try {
  async function exportZip(token: string, name: string) {
    const res = await fetch(`${url}/functions/v1/export-my-data`, {
      method: "POST",
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200, `${name} export: ${res.status}`);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename=".+\.zip"/);
    const file = join(work, `${name}.zip`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const unzip = (...args: string[]) =>
      execFileSync("unzip", args, { maxBuffer: 512 * 1024 * 1024 });
    unzip("-tq", file);
    const names = unzip("-Z1", file).toString().split("\n").filter(Boolean);
    const read = (entry: string) => unzip("-p", file, entry);
    return { names, read, text: (entry: string) => read(entry).toString("utf8") };
  }

  const datasets = [
    "profile",
    "check-ins",
    "clock-sessions",
    "breaks",
    "pauses",
    "status-periods",
    "time-segments",
    "manual-entries",
    "timesheets",
    "timesheet-edits",
    "activity-samples",
    "notice-acknowledgements",
    "capture-views",
    "notifications",
  ];

  // Erin's export.
  const zip = await exportZip(erin.token, "erin");
  const expected = [
    "README.txt",
    "captures/manifest.json",
    ...datasets.flatMap((d) => [`data/${d}.json`, `data/${d}.csv`]),
    `captures/${dayOf(ago(60))}/${erinPass}/screen-1.webp`,
  ];
  for (const entry of expected) assert.ok(zip.names.includes(entry), `missing ${entry}`);
  // Earlier runs may have left check-ins of Erin's; only this run's are asserted on.
  assert.ok(
    !zip.names.some((n) => n.includes(erinOld)),
    "no image of the check-in past the retention window",
  );
  assert.ok(
    !zip.names.includes(`captures/${dayOf(ago(60))}/${erinPass}/webcam.webp`),
    "no webcam frame that was never uploaded",
  );
  assert.ok(
    zip.read(`captures/${dayOf(ago(60))}/${erinPass}/screen-1.webp`).equals(WEBP),
    "the image is byte for byte what was uploaded",
  );
  const manifest = JSON.parse(zip.text("captures/manifest.json"));
  assert.equal(manifest.retention_days, 30);
  assert.ok(manifest.included.includes(`captures/${dayOf(ago(60))}/${erinPass}/screen-1.webp`));
  assert.equal(
    manifest.included.length,
    zip.names.filter((n) => n.endsWith(".webp")).length,
    "the manifest lists every image in the ZIP",
  );
  console.log("ok  Erin's ZIP lists every dataset, the in-retention screenshot, and a manifest");

  const checkIns = JSON.parse(zip.text("data/check-ins.json")) as {
    id: string;
    outcome: string;
  }[];
  const ids = checkIns.map((c) => c.id);
  for (const id of [erinPass, erinMiss, erinOld]) assert.ok(ids.includes(id), `check-in ${id}`);
  assert.equal(checkIns.find((c) => c.id === erinMiss)?.outcome, "miss");
  const csv = zip.text("data/check-ins.csv");
  assert.ok(csv.split("\r\n")[0]?.split(",").includes("id"), "the CSV has a header with id");
  assert.ok(csv.includes(erinPass), "the CSV has the check-in");
  console.log("ok  check-ins in JSON and CSV: the pass, the miss and the old one");

  const profile = JSON.parse(zip.text("data/profile.json")) as { id: string }[];
  assert.deepEqual(
    profile.map((p) => p.id),
    [ERIN],
  );
  const views = JSON.parse(zip.text("data/capture-views.json")) as {
    viewer_id: string;
    viewer_name: string;
    checkin_id: string;
  }[];
  assert.ok(
    views.some((v) => v.viewer_id === MAX && v.checkin_id === erinPass),
    "the manager's view is listed",
  );
  assert.ok(!views.some((v) => v.viewer_id === ERIN), "her own view is not");
  console.log("ok  capture views: the manager's, not her own");

  // Nothing of anyone else's, in any file.
  const everything = zip.names
    .filter((n) => !n.endsWith(".webp"))
    .map((n) => zip.text(n))
    .join("\n");
  for (const needle of [LUCAS, lucasPass, "lucas@acme.test", "Lucas Martin"]) {
    assert.ok(!everything.includes(needle), `Lucas's ${needle} is in Erin's export`);
  }
  assert.ok(
    !zip.names.some((n) => n.includes(lucasPass) || n.includes(LUCAS)),
    "no file of Lucas's",
  );
  console.log("ok  nothing of Lucas's anywhere in Erin's ZIP");

  // The manager's own export holds none of Erin's.
  const managerZip = await exportZip(managerToken, "manager");
  const managerAll = managerZip.names
    .filter((n) => !n.endsWith(".webp"))
    .map((n) => managerZip.text(n))
    .join("\n");
  for (const needle of [ERIN, erinPass, erinMiss, "erin@acme.test"]) {
    assert.ok(!managerAll.includes(needle), `Erin's ${needle} is in the manager's export`);
  }
  assert.ok(!managerZip.names.some((n) => n.endsWith(".webp")), "no captures in the manager's ZIP");
  assert.deepEqual(
    (JSON.parse(managerZip.text("data/profile.json")) as { id: string }[]).map((p) => p.id),
    [MAX],
  );
  console.log("ok  the manager's export has only the manager's data");

  // Audit: both exports are logged with their counts.
  const audit = await call(
    `/rest/v1/audit_log?action=eq.my_data.exported&actor_id=eq.${ERIN}&order=id.desc&limit=1`,
    service,
  );
  assert.equal(audit.json.length, 1, "Erin's export is in the audit log");
  assert.equal(audit.json[0].target_user_id, ERIN);
  assert.equal(audit.json[0].metadata.counts.check_ins, checkIns.length);
  assert.equal(audit.json[0].metadata.counts.capture_images, manifest.included.length);
  console.log("ok  my_data.exported is in the audit log with the row counts");

  // Refusals.
  const noUser = await call("/functions/v1/export-my-data", anon, { body: {} });
  assert.equal(noUser.status, 401, "the anon key is not a user");
  const wrongMethod = await call("/functions/v1/export-my-data", erin.token, { method: "GET" });
  assert.equal(wrongMethod.status, 405, "GET is refused");
  const direct = await call("/rest/v1/rpc/record_my_data_export", erin.token, {
    body: { p_user_id: ERIN, p_counts: {} },
  });
  assert.ok(direct.status >= 400, "a user cannot write their own export audit row");
  console.log("ok  anon key refused (401), GET refused (405), audit helper closed to users");
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log("export-my-data: all checks passed");
