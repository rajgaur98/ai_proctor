// Integration check for the export-timesheet Edge Function (#45, #65) against a local
// stack: seeded segments for Erin and Lucas (past weeks, so nothing else touches them),
// the three CSV views as manager, employee and peer, totals against timesheet_totals and
// timesheet_breakdown, the filters, the formula guard and the audit rows; then XLSX
// (same cells as the CSV, overtime highlighting with the org's thresholds, the format in
// the audit row). Run it through `pnpm it:export-timesheet`; it can be run again on the
// same database.
//
// Needs AI_PROCTOR_SUPABASE_URL, AI_PROCTOR_SUPABASE_ANON_KEY and
// AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY (the wrapper script sets them).
import assert from "node:assert/strict";
import { readXlsx, XLSX_MIME } from "../packages/core/src/xlsx.ts";
import { readZip } from "../packages/core/src/zip.ts";

const url = process.env.AI_PROCTOR_SUPABASE_URL ?? "";
const anon = process.env.AI_PROCTOR_SUPABASE_ANON_KEY ?? "";
const service = process.env.AI_PROCTOR_SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !anon || !service) {
  console.error(
    "Set AI_PROCTOR_SUPABASE_URL, _ANON_KEY and _SERVICE_ROLE_KEY (pnpm it:export-timesheet).",
  );
  process.exit(2);
}

const ORG = "00000000-0000-4000-8000-000000000001";
const MAX = "00000000-0000-4000-8000-0000000000b1";
const ERIN = "00000000-0000-4000-8000-0000000000c1";
const LUCAS = "00000000-0000-4000-8000-0000000000c2";
const REVAMP = "00000000-0000-4000-8000-0000000000f1";
const INTERNAL = "00000000-0000-4000-8000-0000000000f2";
const NORTHWIND = "00000000-0000-4000-8000-0000000000e1";
const EVIL = "00000000-0000-4000-8000-0000000000f9";
const WEEK_A = ["2026-01-05", "2026-01-11"];
const RANGE = ["2026-01-05", "2026-01-18"];

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function call(
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
  return { status: res.status, json: text ? parseJson(text) : null };
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

/** A strict RFC 4180 reader; drops the byte order mark. */
function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && body[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  return rows;
}

interface Filters {
  from: string;
  to: string;
  user_ids?: string[];
  manager_id?: string;
  client_ids?: string[];
  project_ids?: string[];
  statuses?: string[];
}

async function exportCsv(token: string, view: string, filters: Filters) {
  const res = await fetch(`${url}/functions/v1/export-timesheet`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ view, filters }),
  });
  // fetch's text() drops the byte order mark; keep it to check for it.
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const table = res.status === 200 ? parseCsv(text) : [];
  const [header = [], ...lines] = table;
  const col = (name: string) => header.indexOf(name);
  const rows = lines
    .slice(0, -1)
    .map((l) => Object.fromEntries(header.map((h, i) => [h, l[i] ?? ""])));
  const total = Object.fromEntries(header.map((h, i) => [h, lines.at(-1)?.[i] ?? ""]));
  return {
    status: res.status,
    res,
    text,
    header,
    rows,
    total,
    col,
    json: res.status === 200 ? null : parseJson(text),
  };
}

const range = (r: string[]) => ({ from: r[0] as string, to: r[1] as string });
const minutes = (hmm: string) => {
  const [h, m] = hmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

// Seed -------------------------------------------------------------------------------------

const erin = await signIn("erin@acme.test");
const lucas = await signIn("lucas@acme.test");
const manager = await signIn("manager@acme.test");

const seg = (
  user: string,
  day: string,
  start: string,
  end: string,
  zone: string,
  type: string,
  project: string | null,
  extra: { counted?: boolean; flagged?: boolean; excluded?: boolean } = {},
) => ({
  org_id: ORG,
  user_id: user,
  day,
  start_at: `${day}T${start}${zone}`,
  end_at: `${day}T${end}${zone}`,
  type,
  project_id: project,
  counted: extra.counted ?? true,
  flagged: extra.flagged ?? false,
  excluded: extra.excluded ?? false,
});
const PST = "-08:00";
const CST = "-06:00";
const segments = [
  // Erin, Monday of week A (Los Angeles).
  seg(ERIN, "2026-01-05", "09:00:00", "11:00:00", PST, "verified", REVAMP),
  seg(ERIN, "2026-01-05", "11:00:00", "11:20:00", PST, "idle", REVAMP, { flagged: true }),
  seg(ERIN, "2026-01-05", "11:20:00", "11:45:00", PST, "unverified", REVAMP, {
    flagged: true,
    excluded: true,
  }),
  seg(ERIN, "2026-01-05", "11:45:00", "12:00:00", PST, "break", REVAMP, { counted: false }),
  seg(ERIN, "2026-01-05", "12:00:00", "13:00:07", PST, "verified", null),
  seg(ERIN, "2026-01-05", "13:30:00", "14:00:00", PST, "manual", INTERNAL),
  seg(ERIN, "2026-01-06", "09:00:00", "17:00:20", PST, "verified", REVAMP),
  // Erin, week B.
  seg(ERIN, "2026-01-12", "09:00:00", "10:00:00", PST, "verified", INTERNAL),
  // Lucas (Chicago), week A.
  seg(LUCAS, "2026-01-05", "08:00:00", "12:00:31", CST, "verified", REVAMP),
  seg(LUCAS, "2026-01-05", "12:00:31", "12:10:00", CST, "idle", REVAMP, { flagged: true }),
  // A project whose name is a spreadsheet formula (names are user text).
  seg(LUCAS, "2026-01-07", "09:00:00", "09:30:00", CST, "verified", EVIL),
];

async function seed() {
  const users = `user_id=in.(${ERIN},${LUCAS})&day=gte.2026-01-01&day=lte.2026-01-31`;
  const ok = (r: { status: number; json: unknown }, what: string) =>
    assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.json)}`);
  ok(
    await call(`/rest/v1/time_segments?${users}`, service, { method: "DELETE" }),
    "clear segments",
  );
  ok(
    await call(
      `/rest/v1/timesheets?user_id=in.(${ERIN},${LUCAS})&period_start=gte.2026-01-01&period_start=lte.2026-01-31`,
      service,
      { method: "DELETE" },
    ),
    "clear timesheets",
  );
  ok(await call(`/rest/v1/projects?id=eq.${EVIL}`, service, { method: "DELETE" }), "clear project");
  ok(
    await call("/rest/v1/projects", service, {
      body: { id: EVIL, org_id: ORG, client_id: null, name: "=SUM(1,2)", billable: true },
      prefer: "return=minimal",
    }),
    "formula project",
  );
  ok(
    await call("/rest/v1/time_segments", service, { body: segments, prefer: "return=minimal" }),
    "segments",
  );
  ok(
    await call("/rest/v1/timesheets", service, {
      body: [
        {
          org_id: ORG,
          user_id: ERIN,
          period_start: "2026-01-05",
          status: "approved",
          approver_id: MAX,
          approved_at: new Date().toISOString(),
          submitted_at: null,
        },
        {
          org_id: ORG,
          user_id: ERIN,
          period_start: "2026-01-12",
          status: "submitted",
          approver_id: null,
          approved_at: null,
          submitted_at: new Date().toISOString(),
        },
      ],
      prefer: "return=minimal",
    }),
    "timesheets",
  );
}
await seed();

// The log is append-only and closed to the service role (#53): an admin reads it.
const admin = await signIn("admin@acme.test");
const exportCount = async () =>
  (
    await call("/rest/v1/rpc/export_audit_log", admin, {
      body: { p_actions: ["timesheet.exported"] },
    })
  ).json.row_count as number;
const lastExport = async (actor?: string) =>
  (
    await call("/rest/v1/rpc/search_audit_log", admin, {
      body: { p_actions: ["timesheet.exported"], p_actor_id: actor ?? null, p_limit: 1 },
    })
  ).json[0];
let audited = await exportCount();

// The three views, as the manager -------------------------------------------------------------

const daily = await exportCsv(manager, "daily", range(RANGE));
assert.equal(daily.status, 200, daily.text);
assert.match(daily.res.headers.get("content-type") ?? "", /^text\/csv/);
assert.equal(
  daily.res.headers.get("content-disposition"),
  'attachment; filename="timesheet-daily-2026-01-05_2026-01-18.csv"',
);
assert.ok(daily.text.startsWith("﻿"), "byte order mark for Excel");
assert.ok(daily.text.endsWith("\r\n"), "CRLF rows");
assert.deepEqual(daily.header.slice(0, 5), [
  "Employee",
  "Email",
  "Date",
  "Worked (h)",
  "Worked (H:MM)",
]);
// #254 (TS-25): the per-day view ends with Work done.
assert.deepEqual(daily.header.slice(-3), ["Status", "Approver", "Work done"]);
for (const name of ["Flagged", "Excluded", "Break", "Manual", "Billable", "Non-billable"]) {
  assert.ok(daily.col(`${name} (h)`) > 0 && daily.col(`${name} (H:MM)`) > 0, `${name} columns`);
}
assert.deepEqual(
  daily.rows.map((r) => [r.Employee, r.Date, r.Status, r.Approver]),
  [
    ["Erin Employee", "2026-01-05", "approved", "Max Manager"],
    ["Erin Employee", "2026-01-06", "approved", "Max Manager"],
    ["Erin Employee", "2026-01-12", "submitted", ""],
    ["Lucas Martin", "2026-01-05", "draft", ""],
    ["Lucas Martin", "2026-01-07", "draft", ""],
  ],
);
console.log("ok  daily view: a row per employee and day, status and approver");

const project = await exportCsv(manager, "project", range(RANGE));
assert.equal(project.status, 200, project.text);
// #254 (PRJ-05): Task comes between Project and Billable.
assert.deepEqual(project.header.slice(project.col("Project"), project.col("Billable") + 1), [
  "Project",
  "Task",
  "Billable",
]);
const projectRows = project.rows.map(
  (r) => `${r.Employee}|${r.Client}|${r.Project}|${r.Billable}|${r.Status}`,
);
// Blank client first within a person; Unassigned last. A project named like a formula
// comes out with the guard's leading apostrophe.
assert.deepEqual(projectRows, [
  "Erin Employee||Internal|No|Mixed",
  "Erin Employee|Northwind|Website revamp|Yes|approved",
  "Erin Employee||Unassigned|No|approved",
  "Lucas Martin||'=SUM(1,2)|Yes|draft",
  "Lucas Martin|Northwind|Website revamp|Yes|draft",
]);
const unassigned = project.rows.find((r) => r.Project === "Unassigned");
assert.equal(unassigned?.["Worked (h)"], "1.00", "Erin's unassigned 3607 s is its own row");
assert.equal(unassigned?.["Worked (H:MM)"], "1:00");
assert.equal(unassigned?.["Billable (h)"], "0.00");
assert.equal(unassigned?.["Non-billable (h)"], "1.00");
console.log("ok  project view: Unassigned is its own row, mixed weeks say Mixed");

const segmentsView = await exportCsv(manager, "segments", range(RANGE));
assert.equal(segmentsView.status, 200, segmentsView.text);
assert.equal(segmentsView.rows.length, segments.length, "one row per segment");
assert.deepEqual(
  segmentsView.rows.slice(0, 2).map((r) => [r.Start, r.End, r.Type, r["Time zone"], r.Project]),
  [
    [
      "2026-01-05 09:00:00",
      "2026-01-05 11:00:00",
      "verified",
      "America/Los_Angeles",
      "Website revamp",
    ],
    ["2026-01-05 11:00:00", "2026-01-05 11:20:00", "idle", "America/Los_Angeles", "Website revamp"],
  ],
);
console.log("ok  segment view: one row per segment, local times");

// Formula guard ---------------------------------------------------------------------------------

assert.ok(
  segmentsView.text.includes(`"'=SUM(1,2)"`),
  "a formula-looking project name is defused and quoted",
);
assert.ok(
  !segmentsView.rows.some((r) => /^[=+\-@\t\r]/.test(r.Project)),
  "no cell starts with a formula character",
);
console.log("ok  formula guard");

// Totals match the dashboard ---------------------------------------------------------------------

const totalsOf = async (token: string, r: string[]) =>
  (await call("/rest/v1/rpc/timesheet_totals", token, { body: { p_from: r[0], p_to: r[1] } }))
    .json as {
    user_id: string;
    worked_s: number;
    flagged_s: number;
    excluded_s: number;
  }[];
/** The CSV's formatted total must be the formatted raw seconds: H:MM exact, decimals within half a hundredth. */
function assertDuration(csv: Record<string, string>, label: string, seconds: number) {
  assert.equal(
    minutes(csv[`${label} (H:MM)`] ?? ""),
    Math.round(seconds / 60),
    `${label} H:MM for ${seconds} s`,
  );
  assert.ok(
    Math.abs(Number(csv[`${label} (h)`]) - seconds / 3600) <= 0.005 + 1e-9,
    `${label} decimal ${csv[`${label} (h)`]} for ${seconds} s`,
  );
  assert.match(csv[`${label} (h)`] ?? "", /^\d+\.\d{2}$/);
}

const durationsOf = (row: Record<string, string>) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => /\((h|H:MM)\)$/.test(k)));
const allTotals = await totalsOf(manager, RANGE);
const sum = (key: "worked_s" | "flagged_s" | "excluded_s", users = allTotals) =>
  users.reduce((s, t) => s + Number(t[key]), 0);
for (const view of [daily, project, segmentsView]) {
  assertDuration(view.total, "Worked", sum("worked_s"));
  assertDuration(view.total, "Flagged", sum("flagged_s"));
  assertDuration(view.total, "Excluded", sum("excluded_s"));
  assert.deepEqual(
    durationsOf(view.total),
    durationsOf(daily.total),
    "every view has the same totals",
  );
}
for (const [user, name] of [
  [ERIN, "Erin"],
  [LUCAS, "Lucas"],
] as const) {
  const mine = await exportCsv(manager, "daily", { ...range(RANGE), user_ids: [user] });
  const t = allTotals.filter((x) => x.user_id === user);
  assert.equal(t.length, 1, `${name} in timesheet_totals`);
  assertDuration(mine.total, "Worked", sum("worked_s", t));
  assertDuration(mine.total, "Flagged", sum("flagged_s", t));
  assertDuration(mine.total, "Excluded", sum("excluded_s", t));
}
// Erin's week A, by hand: 42627 s worked (37220 billable, 5407 not), 1200 flagged,
// 1500 excluded, 900 break, 1800 manual.
const erinA = await exportCsv(manager, "daily", { ...range(WEEK_A), user_ids: [ERIN] });
assert.deepEqual(
  ["Worked", "Flagged", "Excluded", "Break", "Manual", "Billable", "Non-billable"].map(
    (l) => `${erinA.total[`${l} (h)`]} ${erinA.total[`${l} (H:MM)`]}`,
  ),
  ["11.84 11:50", "0.33 0:20", "0.42 0:25", "0.25 0:15", "0.50 0:30", "10.34 10:20", "1.50 1:30"],
);
// The days of that week match timesheet_breakdown, the dashboard's own query.
const breakdown = (
  await call("/rest/v1/rpc/timesheet_breakdown", manager, {
    body: { p_user_id: ERIN, p_from: WEEK_A[0], p_to: WEEK_A[1] },
  })
).json as { day: string; counted: boolean; excluded: boolean; seconds: number }[];
for (const row of erinA.rows) {
  const worked = breakdown
    .filter((b) => b.day === row.Date && b.counted && !b.excluded)
    .reduce((s, b) => s + Number(b.seconds), 0);
  assertDuration(row, "Worked", worked);
}
console.log(
  "ok  totals: CSV equals timesheet_totals and timesheet_breakdown, by hand for Erin's week",
);

// Filters -----------------------------------------------------------------------------------------------

const byClient = await exportCsv(manager, "project", { ...range(RANGE), client_ids: [NORTHWIND] });
assert.deepEqual(
  new Set(byClient.rows.map((r) => r.Client)),
  new Set(["Northwind"]),
  "client filter",
);
const byProject = await exportCsv(manager, "segments", {
  ...range(RANGE),
  project_ids: [INTERNAL],
});
assert.deepEqual(
  new Set(byProject.rows.map((r) => r.Project)),
  new Set(["Internal"]),
  "project filter",
);
assert.equal(byProject.rows.length, 2);
const approved = await exportCsv(manager, "daily", { ...range(RANGE), statuses: ["approved"] });
assert.deepEqual(
  approved.rows.map((r) => r.Date),
  ["2026-01-05", "2026-01-06"],
  "status filter",
);
const draftWeek = await exportCsv(manager, "daily", {
  ...range(RANGE),
  statuses: ["draft", "submitted"],
});
assert.deepEqual(new Set(draftWeek.rows.map((r) => r.Status)), new Set(["draft", "submitted"]));
const oneDay = await exportCsv(manager, "daily", { from: "2026-01-06", to: "2026-01-06" });
assert.deepEqual(
  oneDay.rows.map((r) => r.Date),
  ["2026-01-06"],
  "date range",
);
const team = await exportCsv(manager, "daily", { ...range(RANGE), manager_id: MAX });
assert.equal(team.rows.length, daily.rows.length, "the manager's team");
console.log("ok  filters: client, project, status, date range, manager");

// Access -----------------------------------------------------------------------------------------------------

const own = await exportCsv(erin, "daily", range(RANGE));
assert.equal(own.status, 200, own.text);
assert.deepEqual(
  new Set(own.rows.map((r) => r.Employee)),
  new Set(["Erin Employee"]),
  "an employee exports her own time",
);
assert.equal(
  (await exportCsv(erin, "daily", { ...range(RANGE), user_ids: [LUCAS] })).status,
  403,
  "not a peer's",
);
assert.equal(
  (await exportCsv(lucas, "segments", { ...range(RANGE), user_ids: [ERIN] })).status,
  403,
  "peer: Erin's time",
);
const peer = await exportCsv(lucas, "daily", range(RANGE));
assert.deepEqual(
  new Set(peer.rows.map((r) => r.Employee)),
  new Set(["Lucas Martin"]),
  "a peer gets only their own",
);
assert.equal((await exportCsv(anon, "daily", range(RANGE))).status, 401, "anonymous");
console.log("ok  access: employee own, peer refused (403), anonymous 401");

// Invalid requests ---------------------------------------------------------------------------------------------

for (const [what, view, filters] of [
  ["unknown view", "weekly", range(RANGE)],
  ["end before start", "daily", { from: "2026-01-18", to: "2026-01-05" }],
  ["more than a year", "daily", { from: "2024-01-01", to: "2026-01-05" }],
  ["bad day", "daily", { from: "2026-13-40", to: "2026-01-05" }],
  ["bad user id", "daily", { ...range(RANGE), user_ids: ["nope"] }],
  ["bad status", "daily", { ...range(RANGE), statuses: ["pending"] }],
] as [string, string, Filters][]) {
  assert.equal((await exportCsv(manager, view, filters)).status, 400, what);
}
console.log("ok  invalid requests: 400");

// Audit ---------------------------------------------------------------------------------------------------------

// Successful exports so far: the three views, one per employee (2), Erin's week (1), the
// six filter calls, then Erin's own and Lucas's own (2). Refused and invalid ones are
// not logged.
const now = await exportCount();
assert.equal(
  now - audited,
  3 + 2 + 1 + 6 + 2,
  "every export that returned a file was logged, no others",
);
const log = await lastExport(MAX);
// The last of the manager's calls was the team one.
assert.equal(log.metadata.view, "daily");
assert.equal(log.metadata.from, "2026-01-05");
assert.equal(log.metadata.to, "2026-01-18");
assert.equal(log.metadata.manager_id, MAX);
assert.equal(log.metadata.row_count, segments.length);
audited = now;
const direct = await call("/rest/v1/rpc/timesheet_export_rows", manager, {
  body: { p_from: RANGE[0], p_to: RANGE[1], p_view: "segments" },
});
assert.equal(direct.status, 200, JSON.stringify(direct.json));
assert.equal(direct.json.row_count, segments.length);
assert.equal(
  await exportCount(),
  audited + 1,
  "calling the database function directly is logged too",
);
const last = await lastExport();
assert.equal(last.metadata.row_count, segments.length, "the row count in the log");
console.log("ok  audit: every export logged with its filters and row count, direct RPC calls too");

// XLSX (#65: TS-20, TS-19) ---------------------------------------------------------------------

async function exportXlsx(token: string, view: string, filters: Filters) {
  const res = await fetch(`${url}/functions/v1/export-timesheet`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ view, format: "xlsx", filters }),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, res, bytes };
}
const setOvertime = async (daily: number | null, weekly: number | null) => {
  const r = await call("/rest/v1/rpc/update_policy", admin, {
    body: { p_policy: { overtime_daily_hours: daily, overtime_weekly_hours: weekly } },
  });
  assert.equal(r.status, 200, `update_policy: ${JSON.stringify(r.json)}`);
};
/** A cell as the CSV writes it: numbers with the CSV's 2 decimals, blanks as "". */
const asCsv = (value: string | number | null | undefined, csv: string) =>
  value === null || value === undefined
    ? ""
    : typeof value === "number"
      ? /^\d+\.\d{2}$/.test(csv)
        ? value.toFixed(2)
        : String(value)
      : value;

// Off by default: one sheet, the CSV's cells, nothing highlighted.
await setOvertime(null, null);
for (const [view, csv] of [
  ["daily", daily],
  ["project", project],
  ["segments", segmentsView],
] as const) {
  const x = await exportXlsx(manager, view, range(RANGE));
  assert.equal(x.status, 200, new TextDecoder().decode(x.bytes));
  assert.equal(x.res.headers.get("content-type"), XLSX_MIME);
  assert.equal(
    x.res.headers.get("content-disposition"),
    `attachment; filename="timesheet-${view}-2026-01-05_2026-01-18.xlsx"`,
  );
  assert.deepEqual(
    readZip(x.bytes).map((e) => e.name),
    [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ],
    `${view}: the parts of a workbook, every CRC checked`,
  );
  const [sheet] = readXlsx(x.bytes);
  const table = [
    csv.header,
    ...csv.rows.map((r) => csv.header.map((h) => r[h] ?? "")),
    csv.header.map((h) => csv.total[h] ?? ""),
  ];
  // The CSV's guard apostrophe is the only difference: XLSX text is never a formula.
  const unguard = (v: string) => v.replace(/^'(?=[=+\-@\t\r])/, "");
  assert.deepEqual(
    sheet?.rows.map((row, r) => (table[r] ?? []).map((v, i) => asCsv(row[i]?.value, v))),
    table.map((line) => line.map(unguard)),
    `${view}: the same cells as the CSV`,
  );
  assert.ok(
    !sheet?.rows.some((row) => row.some((c) => c.style.highlight)),
    `${view}: nothing highlighted with the thresholds off`,
  );
}
console.log("ok  xlsx: three views, the CSV's cells, the formula-looking name as plain text");

// Thresholds on: Erin's 2026-01-06 (8 h 0 min 20 s) is over 8 h a day; her week A (11.84 h)
// is over 10 h a week. Lucas works 4 h 10 min and 30 min that week.
await setOvertime(8, 10);
const over = await exportXlsx(manager, "daily", range(RANGE));
assert.equal(over.status, 200);
const [perDay, weekly] = readXlsx(over.bytes);
const heads = (perDay?.rows[0] ?? []).map((c) => c.value);
const dateCol = heads.indexOf("Date");
const lit = (sheet: typeof perDay) =>
  (sheet?.rows ?? []).flatMap((row, r) =>
    row.some((c) => c.style.highlight)
      ? [
          `${row[0]?.value} ${row[2]?.value}: ${row
            .flatMap((c, i) => (c.style.highlight ? [String(sheet?.rows[0]?.[i]?.value)] : []))
            .join(", ")} (row ${r})`,
        ]
      : [],
  );
assert.deepEqual(lit(perDay), [`Erin Employee 2026-01-06: Worked (h), Worked (H:MM) (row 2)`]);
assert.equal(perDay?.rows[2]?.[dateCol]?.value, "2026-01-06");
assert.equal(weekly?.name, "Weekly totals");
assert.deepEqual(
  weekly?.rows.map((r) => r.map((c) => c.value)),
  [
    ["Employee", "Email", "Week starting", "Worked (h)", "Worked (H:MM)"],
    ["Erin Employee", "erin@acme.test", "2026-01-05", 11.84, "11:50"],
    ["Erin Employee", "erin@acme.test", "2026-01-12", 1, "1:00"],
    ["Lucas Martin", "lucas@acme.test", "2026-01-05", 4.67, "4:40"],
  ],
);
assert.deepEqual(lit(weekly), [`Erin Employee 2026-01-05: Worked (h), Worked (H:MM) (row 1)`]);
console.log("ok  xlsx: days over 8 h and weeks over 10 h highlighted, no others");

// An employee's own XLSX uses the same thresholds; the format is audit-logged.
const ownX = await exportXlsx(erin, "daily", { ...range(WEEK_A), user_ids: [ERIN] });
assert.equal(ownX.status, 200);
assert.equal(readXlsx(ownX.bytes)[1]?.rows.length, 2, "Erin's week A only");
assert.equal((await lastExport()).metadata.format, "xlsx");
assert.equal((await lastExport(MAX)).metadata.format, "xlsx");
assert.equal(
  (
    await call("/rest/v1/rpc/search_audit_log", admin, {
      body: { p_actions: ["timesheet.exported"], p_limit: 50 },
    })
  ).json.filter((r: { metadata: { format?: string } }) => r.metadata.format === "csv").length > 0,
  true,
  "CSV exports say csv",
);
const badFormat = await fetch(`${url}/functions/v1/export-timesheet`, {
  method: "POST",
  headers: { apikey: anon, Authorization: `Bearer ${manager}`, "Content-Type": "application/json" },
  body: JSON.stringify({ view: "daily", format: "pdf", filters: range(RANGE) }),
});
assert.equal(badFormat.status, 400, "an unknown format");
await setOvertime(null, null);
console.log(
  "ok  xlsx: an employee's own file, the format in the audit row, an unknown format refused",
);

// Leave the database as the seed has it for other runs.
await call(
  `/rest/v1/time_segments?user_id=in.(${ERIN},${LUCAS})&day=gte.2026-01-01&day=lte.2026-01-31`,
  service,
  { method: "DELETE" },
);
await call(
  `/rest/v1/timesheets?user_id=in.(${ERIN},${LUCAS})&period_start=gte.2026-01-01&period_start=lte.2026-01-31`,
  service,
  { method: "DELETE" },
);
await call(`/rest/v1/projects?id=eq.${EVIL}`, service, { method: "DELETE" });
console.log("done");
