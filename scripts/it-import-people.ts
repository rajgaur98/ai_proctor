// Integration check for people imports (#256, ORG-03) against a local stack, through the
// import-people Edge Function and Mailpit:
//  - a manager is refused before any Auth user is made;
//  - an email Auth already knows is refused, and so is an import with a bad row: nothing
//    is written, the Auth users made for it are deleted and no email goes out;
//  - an admin's import invites a new manager and someone reporting to them at once;
//    each new person gets one normal invite email after the commit;
//  - importing them again (as updates) sends nothing more and duplicates nobody.
// It never changes the seed people, so the e2e specs can run after it.
// Run it through `pnpm it:import-people` (see scripts/it-import-people.sh).
import assert from "node:assert/strict";

const url = process.env.AI_PROCTOR_SUPABASE_URL ?? "";
const anon = process.env.AI_PROCTOR_SUPABASE_ANON_KEY ?? "";
const service = process.env.AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY ?? "";
const mailpit = process.env.AI_PROCTOR_MAILPIT_URL ?? "";
if (!url || !anon || !service || !mailpit) {
  console.error("Set AI_PROCTOR_SUPABASE_URL, _ANON_KEY, _SERVICE_ROLE_KEY and _MAILPIT_URL.");
  process.exit(2);
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

async function importPeople(token: string, items: unknown[]) {
  const res = await fetch(`${url}/functions/v1/import-people`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { kind: "people", items } }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function rest(path: string, token = service) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: anon, Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, path);
  return (await res.json()) as Record<string, unknown>[];
}

async function authUser(email: string) {
  const res = await fetch(`${url}/auth/v1/admin/users?per_page=1000`, {
    headers: { apikey: service, Authorization: `Bearer ${service}` },
  });
  const { users } = (await res.json()) as { users: { id: string; email: string }[] };
  return users.find((u) => u.email === email) ?? null;
}

async function mails(email: string) {
  const res = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  const body = (await res.json()) as { messages: { Subject: string }[] };
  return body.messages.map((m) => m.Subject);
}

/** Mail delivery is asynchronous: wait for `n` messages to `email`, at most ~10 s. */
async function waitForMails(email: string, n: number) {
  for (let i = 0; i < 40; i++) {
    const got = await mails(email);
    if (got.length >= n) return got;
    await new Promise((r) => setTimeout(r, 250));
  }
  return mails(email);
}

const stamp = Date.now();
const boss = `boss-${stamp}@acme.test`;
const rep = `rep-${stamp}@acme.test`;
const person = (email: string, extra: Record<string, unknown>) => ({
  rows: [2],
  action: "create",
  email,
  full_name: "Imported Person",
  role: "employee",
  manager_email: "admin@acme.test",
  team: null,
  work_country: "US",
  work_state: "NY",
  timezone: "America/New_York",
  ...extra,
});

const ada = await signIn("admin@acme.test");
const max = await signIn("manager@acme.test");

// A manager is refused before anything happens.
const refused = await importPeople(max, [person(boss, {})]);
assert.equal(refused.status, 403);
assert.equal(refused.json.error, "admin_only");
assert.equal(await authUser(boss), null, "no Auth user for a refused import");

// An address Auth already knows (Max signed up) is refused for its row.
const known = await importPeople(ada, [
  person(boss, {}),
  person("manager@acme.test", { rows: [3] }),
]);
assert.equal(known.status, 422);
assert.deepEqual(known.json, { error: "email_exists", detail: "rows: 3" });
assert.equal(await authUser(boss), null, "the Auth user made for row 2 is deleted again");

// A bad row: all or nothing, and the new person's Auth user is deleted again.
const bad = await importPeople(ada, [
  person(boss, { role: "manager" }),
  person(rep, { rows: [3], manager_email: `nobody-${stamp}@acme.test` }),
]);
assert.equal(bad.status, 422);
assert.deepEqual(bad.json, { error: "manager_not_found", detail: "rows: 3" });
assert.equal(await authUser(boss), null, "no Auth user left behind");
assert.equal(await authUser(rep), null);
assert.equal((await rest(`users?email=eq.${boss}`)).length, 0, "nothing written");
await new Promise((r) => setTimeout(r, 1000));
assert.deepEqual(await mails(boss), [], "no email for a failed import");

// The real import: a new manager and someone reporting to them. Seed people are left
// alone, so the e2e specs find the org as they expect it.
const items = [
  person(boss, { role: "manager", full_name: "Bea Boss" }),
  person(rep, { rows: [3], manager_email: boss, full_name: "Rae Report" }),
];
const ok = await importPeople(ada, items);
assert.equal(ok.status, 200, JSON.stringify(ok.json));
assert.deepEqual(ok.json.result, { kind: "people", created: 2, updated: 0 });
assert.deepEqual(ok.json.invites, [
  { email: boss, ok: true },
  { email: rep, ok: true },
]);
assert.deepEqual(await waitForMails(boss, 1), ["You're invited to AI Proctor"]);
assert.deepEqual(await waitForMails(rep, 1), ["You're invited to AI Proctor"]);
const [bossRow] = await rest(`users?email=eq.${boss}&select=id,role,full_name`);
const [repRow] = await rest(`users?email=eq.${rep}&select=manager_id`);
assert.equal(bossRow?.role, "manager");
assert.equal(repRow?.manager_id, bossRow?.id, "the report is under the new manager");
assert.equal((await authUser(boss))?.id, bossRow?.id, "the users row is the invited Auth user");
// The audit log is read through its policy, as the owner.
const applied = await rest(
  "audit_log?action=eq.import.applied&order=id.desc&limit=1&select=metadata",
  ada,
);
assert.deepEqual(applied[0]?.metadata, { kind: "people", created: 2, updated: 0, rows: 2 });

// Again, as updates with one change: nothing new is sent and nobody is duplicated.
const again = await importPeople(
  ada,
  items.map((i) => ({ ...i, action: "update" })),
);
assert.equal(again.status, 200, JSON.stringify(again.json));
assert.deepEqual(again.json.result, { kind: "people", created: 0, updated: 2 });
assert.deepEqual(again.json.invites, []);
const renamed = await importPeople(ada, [
  { ...items[1], action: "update", full_name: "Rae Renamed" },
]);
assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
const [repAfter] = await rest(`users?email=eq.${rep}&select=full_name`);
assert.equal(repAfter?.full_name, "Rae Renamed");
await new Promise((r) => setTimeout(r, 1000));
assert.equal((await mails(boss)).length, 1, "one invite email per new person");
assert.equal((await rest(`users?email=eq.${boss}`)).length, 1);

console.log("import-people: ok");
