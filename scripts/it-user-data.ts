// Integration check for export-user-data and delete-user-data (#54, ADM-05, AUD-01)
// against a local stack. A new employee, Dana, works a day (clock in, a pause with a
// private reason, a passed check-in with a screenshot, clock out); the owner views her
// capture and she exports her own data. Then:
//  - peers, managers, the anon key and wrong confirmations are refused, and a refusal
//    changes nothing (a manager with reports and the owner are not deleted either);
//  - the owner's export is the same ZIP as Dana's own, except for the pause reason, and
//    holds nothing of anyone else's; it is in the audit log;
//  - the owner's deletion removes the screenshot from Storage, every row, the devices
//    and the sign-in (her password and her old token stop working), and leaves the
//    audit rows with her name plus one tombstone with no email; Erin and Lucas are
//    untouched; a second deletion finds nobody.
// Run it through `pnpm it:user-data` (see scripts/it-user-data.sh).
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
    "Set AI_PROCTOR_SUPABASE_URL, _ANON_KEY and _SERVICE_ROLE_KEY (pnpm it:user-data).",
  );
  process.exit(2);
}

const ORG = "00000000-0000-4000-8000-000000000001";
const ADA = "00000000-0000-4000-8000-0000000000a1";
const MAX = "00000000-0000-4000-8000-0000000000b1";
const ERIN = "00000000-0000-4000-8000-0000000000c1";
const LUCAS = "00000000-0000-4000-8000-0000000000c2";
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

async function signInResponse(email: string, password = "password123") {
  return fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

async function signIn(email: string) {
  const res = await signInResponse(email);
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
      hardware_hash: `it-user-data-${randomUUID()}`,
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

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const base = Date.now();
const ago = (minutes: number) => new Date(base - minutes * 60_000);

const exportRequest = (token: string, body: unknown) =>
  call("/functions/v1/export-user-data", token, { body });
const deleteRequest = (token: string, body: unknown) =>
  call("/functions/v1/delete-user-data", token, { body });

// Setup: Dana, a new employee under the owner ---------------------------------------------

const email = `dana-${Date.now()}@acme.test`;
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
const DANA = ((await created.json()) as { id: string }).id;
const added = await call("/rest/v1/rpc/add_invited_member", service, {
  body: {
    p_inviter_id: ADA,
    p_user_id: DANA,
    p_email: email,
    p_full_name: "Dana Delete",
    p_role: "employee",
    p_manager_id: ADA,
    p_work_country: "US",
    p_work_state: "CA",
    p_timezone: "America/Los_Angeles",
  },
});
assert.equal(added.status, 204, `add_invited_member: ${JSON.stringify(added.json)}`);

const dana = await agent(email);
await dana.send("clock_in", { reason: "manual" }, ago(120));
await dana.send("pause_start", { planned_min: 5, reason: "private note" }, ago(100));
await dana.send("pause_end", {}, ago(95));
const danaPass = await dana.send(
  "checkin",
  {
    scheduled_at: ago(60).toISOString(),
    shown_at: ago(60).toISOString(),
    responded_at: ago(60).toISOString(),
    outcome: "pass",
    response_ms: 2000,
    wrong_clicks: 0,
    object_keys: ["screen-1.webp"],
    flags: [],
  },
  ago(60),
);
await dana.send("clock_out", { reason: "manual" }, ago(5));
// A late clock-in (SHF-06, #67; written with the service role: Dana has no shift).
const danaSession = await call(
  `/rest/v1/clock_sessions?user_id=eq.${DANA}&order=start_at.desc&limit=1&select=id`,
  service,
);
assert.equal(danaSession.status, 200, `clock session ${JSON.stringify(danaSession.json)}`);
const danaLate = await call("/rest/v1/late_clock_ins", service, {
  body: {
    org_id: ORG,
    user_id: DANA,
    clock_session_id: danaSession.json[0].id,
    day: dayOf(ago(150)),
    shift_start: ago(150).toISOString(),
    clocked_in_at: ago(120).toISOString(),
    late_s: 1800,
    grace_min: 10,
  },
});
assert.equal(danaLate.status, 201, `late_clock_ins ${JSON.stringify(danaLate.json)}`);
const screenshot = `${ORG}/${DANA}/${dayOf(ago(60))}/${danaPass}/screen-1.webp`;
const uploaded = await fetch(`${url}/storage/v1/object/captures/${screenshot}`, {
  method: "POST",
  headers: { apikey: anon, Authorization: `Bearer ${dana.token}`, "Content-Type": "image/webp" },
  body: WEBP,
});
assert.equal(uploaded.status, 200, `upload ${await uploaded.clone().text()}`);

const adaToken = await signIn("admin@acme.test");
const maxToken = await signIn("manager@acme.test");
const lucasToken = await signIn("lucas@acme.test");
const opened = await call("/functions/v1/capture-url", adaToken, {
  body: { checkin_id: danaPass },
});
assert.equal(opened.status, 200, `the owner opens Dana's capture: ${JSON.stringify(opened.json)}`);

// What the others have, to compare after (service role reads everything).
const countOf = async (table: string, user: string) =>
  ((await call(`/rest/v1/${table}?user_id=eq.${user}&select=*`, service)).json as unknown[]).length;
const peerTables = ["checkin_events", "clock_sessions", "time_segments", "devices", "notice_acks"];
const peerCounts = async () =>
  Object.fromEntries(
    await Promise.all(
      [ERIN, LUCAS].flatMap((u) =>
        peerTables.map(async (t) => [`${t}:${u}`, await countOf(t, u)] as const),
      ),
    ),
  );
const peersBefore = await peerCounts();
const danaStillThere = async () =>
  (
    (await call(`/rest/v1/users?id=eq.${DANA}&select=id,active`, adaToken)).json as {
      id: string;
      active: boolean;
    }[]
  )[0];

const work = mkdtempSync(join(tmpdir(), "user-data-"));
try {
  async function zipOf(res: Response, name: string) {
    assert.equal(res.status, 200, `${name}: ${res.status}`);
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename=".+\.zip"/);
    const file = join(work, `${name}.zip`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const unzip = (...args: string[]) =>
      execFileSync("unzip", args, { maxBuffer: 512 * 1024 * 1024 });
    unzip("-tq", file);
    const names = unzip("-Z1", file).toString().split("\n").filter(Boolean).sort();
    const read = (entry: string) => unzip("-p", file, entry);
    return { names, read, text: (entry: string) => read(entry).toString("utf8") };
  }
  const request = (token: string, body: unknown) =>
    fetch(`${url}/functions/v1/export-user-data`, {
      method: "POST",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  // Refusals: nothing is read, removed or stopped ------------------------------------------

  for (const [fn, send] of [
    ["export-user-data", exportRequest],
    ["delete-user-data", deleteRequest],
  ] as const) {
    const ok = { user_id: DANA, email };
    const noUser = await send(anon, ok);
    assert.equal(noUser.status, 401, `${fn}: the anon key is not a user`);
    const wrongMethod = await call(`/functions/v1/${fn}`, adaToken, { method: "GET" });
    assert.equal(wrongMethod.status, 405, `${fn}: GET is refused`);
    for (const bad of [
      {},
      { user_id: "x", email },
      { user_id: DANA },
      { user_id: DANA, email: 5 },
    ]) {
      const r = await send(adaToken, bad);
      assert.equal(r.status, 400, `${fn}: ${JSON.stringify(bad)} is an invalid request`);
      assert.equal(r.json.error, "invalid_request");
    }
    for (const [who, token] of [
      ["an employee", lucasToken],
      ["a manager", maxToken],
    ] as const) {
      const r = await send(token, ok);
      assert.equal(r.status, 403, `${fn}: ${who} is refused`);
      assert.equal(r.json.error, "admin_only");
    }
    const wrong = await send(adaToken, { user_id: DANA, email: "someone@acme.test" });
    assert.equal(wrong.status, 400, `${fn}: a wrong email is refused`);
    assert.equal(wrong.json.error, "email_mismatch");
    const nobody = await send(adaToken, { user_id: randomUUID(), email });
    assert.equal(nobody.status, 404, `${fn}: an unknown person`);
    assert.equal(nobody.json.error, "user_not_found");
  }
  const refusedDelete = await deleteRequest(adaToken, { user_id: ADA, email: "admin@acme.test" });
  assert.equal(refusedDelete.status, 409, "the owner cannot delete themselves");
  assert.equal(refusedDelete.json.error, "cannot_delete_self");
  const adminDelete = await deleteRequest(maxToken, { user_id: ADA, email: "admin@acme.test" });
  assert.equal(adminDelete.status, 403, "a manager cannot delete the owner");
  const manager = await deleteRequest(adaToken, { user_id: MAX, email: "manager@acme.test" });
  assert.equal(manager.status, 409, "a manager with reports is refused");
  assert.equal(manager.json.error, "has_reports");
  assert.ok(
    String(manager.json.reports).includes("Erin Employee") &&
      String(manager.json.reports).includes("Lucas Martin"),
    `the reports are named: ${manager.json.reports}`,
  );
  const maxRow = (await call(`/rest/v1/users?id=eq.${MAX}&select=active`, adaToken)).json[0];
  assert.equal(maxRow.active, true, "the refused manager is still active");
  assert.equal((await danaStillThere())?.active, true, "and so is Dana: refusals change nothing");
  assert.equal(
    (await signInResponse(email)).status,
    200,
    "Dana can still sign in after all the refusals",
  );
  console.log(
    "ok  anon (401), GET (405), bad input (400), employee and manager (403), wrong email",
  );
  console.log("ok  (400), unknown person (404), self, owner and a manager with reports refused");

  // Export -------------------------------------------------------------------------------

  const own = await zipOf(
    await fetch(`${url}/functions/v1/export-my-data`, {
      method: "POST",
      headers: { apikey: anon, Authorization: `Bearer ${dana.token}` },
    }),
    "dana-self",
  );
  const asAdmin = await zipOf(await request(adaToken, { user_id: DANA, email }), "dana-admin");
  assert.deepEqual(asAdmin.names, own.names, "the admin's ZIP has the same files as her own");
  for (const dataset of [
    "profile",
    "check-ins",
    "clock-sessions",
    "status-periods",
    "time-segments",
    "timesheets",
    "late-clock-ins",
  ]) {
    assert.deepEqual(
      JSON.parse(asAdmin.text(`data/${dataset}.json`)),
      JSON.parse(own.text(`data/${dataset}.json`)),
      `${dataset} is the same in both`,
    );
  }
  assert.ok(
    asAdmin.read(`captures/${dayOf(ago(60))}/${danaPass}/screen-1.webp`).equals(WEBP),
    "the screenshot is byte for byte what was uploaded",
  );
  const profile = JSON.parse(asAdmin.text("data/profile.json")) as { id: string; email: string }[];
  assert.deepEqual(
    profile.map((p) => p.id),
    [DANA],
  );
  const adminLate = JSON.parse(asAdmin.text("data/late-clock-ins.json")) as Record<
    string,
    unknown
  >[];
  assert.equal(adminLate.length, 1, "her late clock-in is in the admin's export");
  assert.equal(adminLate[0]?.late_s, 1800, "in raw seconds");
  assert.equal(adminLate[0]?.user_id, DANA);
  const selfPauses = JSON.parse(own.text("data/pauses.json")) as { private_reason?: string }[];
  assert.equal(selfPauses[0]?.private_reason, "private note", "her own export has her reason");
  const adminPauses = JSON.parse(asAdmin.text("data/pauses.json")) as Record<string, unknown>[];
  assert.equal(adminPauses.length, 1, "the pause is in the admin's export");
  assert.ok(!("private_reason" in (adminPauses[0] ?? {})), "but not the reason");
  const everything = asAdmin.names
    .filter((n) => !n.endsWith(".webp"))
    .map((n) => asAdmin.text(n))
    .join("\n");
  assert.ok(!everything.includes("private note"), "the reason is nowhere in the admin's ZIP");
  for (const needle of [ERIN, LUCAS, MAX, "erin@acme.test", "lucas@acme.test", "Lucas Martin"]) {
    assert.ok(!everything.includes(needle), `${needle} is in Dana's export`);
  }
  const views = JSON.parse(asAdmin.text("data/capture-views.json")) as { viewer_id: string }[];
  assert.ok(
    views.some((v) => v.viewer_id === ADA),
    "the owner's view of her capture is listed",
  );
  assert.equal((await danaStillThere())?.active, true, "an export changes nothing");
  console.log("ok  the admin's export is the employee's ZIP (same files and data), the image byte");
  console.log("ok  for byte, without the pause reason and with nothing of anyone else's");

  const exported = await call(
    `/rest/v1/audit_log?action=eq.user_data.exported&target_user_id=eq.${DANA}&select=*`,
    adaToken,
  );
  assert.equal(exported.json.length, 1, "the export is in the audit log, once");
  assert.equal(exported.json[0].actor_id, ADA);
  assert.equal(exported.json[0].actor_name, "Ada Admin");
  assert.equal(exported.json[0].target_name, "Dana Delete");
  assert.equal(exported.json[0].metadata.counts.capture_images, 1);
  assert.equal(exported.json[0].metadata.counts.check_ins, 1);
  const notAllowed = await call("/rest/v1/rpc/record_user_data_export", adaToken, {
    body: { p_actor_id: ADA, p_user_id: DANA, p_counts: {} },
  });
  assert.ok(notAllowed.status >= 400, "an admin cannot write the export audit row themselves");
  console.log(
    "ok  user_data.exported is in the audit log with the counts; the audit helper is closed",
  );

  // Deletion -------------------------------------------------------------------------------

  const wrongConfirm = await deleteRequest(adaToken, { user_id: DANA, email: "dana@acme.test" });
  assert.equal(wrongConfirm.status, 400, "a wrong typed email deletes nothing");
  assert.equal((await danaStillThere())?.active, true);
  const found = await call(`/storage/v1/object/captures/${screenshot}`, service);
  assert.equal(found.status, 200, "the screenshot is still there");

  const deleted = await deleteRequest(adaToken, {
    user_id: DANA,
    email: ` ${email.toUpperCase()} `,
  });
  assert.equal(deleted.status, 200, `delete: ${JSON.stringify(deleted.json)}`);
  assert.equal(deleted.json.ok, true);
  assert.equal(deleted.json.images_removed, 1, "the screenshot was removed");
  assert.equal(deleted.json.counts.clock_sessions, 1);
  assert.equal(deleted.json.counts.checkin_events, 1);
  assert.equal(deleted.json.counts.devices, 1);
  console.log("ok  delete-user-data reports what it removed");

  // The files, the rows, the sign-in.
  const gone = await fetch(`${url}/storage/v1/object/captures/${screenshot}`, {
    headers: { apikey: service, Authorization: `Bearer ${service}` },
  });
  assert.notEqual(gone.status, 200, "the screenshot is gone from Storage");
  const listing = await call("/storage/v1/object/list/captures", service, {
    body: { prefix: `${ORG}/${DANA}`, limit: 100 },
  });
  assert.deepEqual(listing.json, [], "and so is her folder");
  for (const table of [
    "devices",
    "device_sessions",
    "checkin_events",
    "clock_sessions",
    "breaks",
    "pauses",
    "status_periods",
    "time_segments",
    "timesheets",
    "timesheet_edits",
    "manual_entries",
    "activity_samples",
    "agent_events_raw",
    "notifications",
    "late_clock_ins",
    "notice_acks",
    "presence",
    "last_seen",
    "dirty_days",
  ]) {
    const rows = await call(`/rest/v1/${table}?user_id=eq.${DANA}&select=*`, service);
    assert.equal(rows.status, 200, `${table}: ${JSON.stringify(rows.json)}`);
    assert.deepEqual(rows.json, [], `${table} has nothing of Dana's`);
  }
  const user = await call(`/rest/v1/users?id=eq.${DANA}&select=id`, service);
  assert.deepEqual(user.json, [], "her users row is gone");
  const authUser = await fetch(`${url}/auth/v1/admin/users/${DANA}`, {
    headers: { apikey: service, Authorization: `Bearer ${service}` },
  });
  assert.equal(authUser.status, 404, "and her Auth account");
  assert.equal((await signInResponse(email)).status, 400, "she cannot sign in");
  const oldToken = await call("/functions/v1/export-my-data", dana.token, { body: {} });
  assert.equal(oldToken.status, 401, "her old token no longer works");
  console.log("ok  Storage, every table, the devices and the Auth account are gone; her password");
  console.log("ok  and her old token stop working");

  // The audit log: her rows stay with her name, plus one tombstone.
  const rows = (
    await call(`/rest/v1/audit_log?target_user_id=eq.${DANA}&select=*&order=id`, adaToken)
  ).json as {
    action: string;
    actor_id: string;
    actor_name: string;
    target_name: string;
    metadata: { counts?: Record<string, number>; role?: string };
  }[];
  const actions = rows.map((r) => r.action);
  for (const action of [
    "member.invited",
    "capture.viewed",
    "my_data.exported",
    "user_data.exported",
    "member.deactivated",
    "user_data.deleted",
  ]) {
    assert.ok(actions.includes(action), `audit rows about Dana include ${action}: ${actions}`);
  }
  assert.ok(
    rows.every((r) => r.target_name === "Dana Delete"),
    "every row about her still carries her name",
  );
  const own2 = rows.find((r) => r.action === "my_data.exported");
  assert.equal(own2?.actor_name, "Dana Delete", "the row she made says who she was");
  const tombstones = rows.filter((r) => r.action === "user_data.deleted");
  assert.equal(tombstones.length, 1, "exactly one tombstone");
  assert.equal(tombstones[0]?.actor_id, ADA);
  assert.equal(tombstones[0]?.actor_name, "Ada Admin");
  assert.equal(tombstones[0]?.metadata.role, "employee");
  assert.equal(tombstones[0]?.metadata.counts?.clock_sessions, 1);
  assert.ok(
    !JSON.stringify(tombstones[0]).toLowerCase().includes(email.toLowerCase()),
    "the tombstone has no email address",
  );
  const stopped = rows.find((r) => r.action === "member.deactivated");
  assert.equal(
    stopped?.metadata && (stopped.metadata as { reason?: string }).reason,
    "data_deletion",
  );
  console.log("ok  the audit rows about her stay with her name; one tombstone, no email");

  // Others untouched, and a second deletion finds nobody.
  assert.deepEqual(await peerCounts(), peersBefore, "Erin and Lucas keep every row");
  await signIn("erin@acme.test");
  await signIn("lucas@acme.test");
  const again = await deleteRequest(adaToken, { user_id: DANA, email });
  assert.equal(again.status, 404, "a second deletion finds nobody");
  assert.equal(again.json.error, "user_not_found");
  const reExport = await request(adaToken, { user_id: DANA, email });
  assert.equal(reExport.status, 404, "and there is nothing to export");
  console.log("ok  Erin and Lucas untouched; deleting or exporting her again: 404");
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log("user data requests: all checks passed");
