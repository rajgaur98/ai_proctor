// List page exports (#255, TS-20 extended, AUD-01): the shared Export button downloads
// what the page shows with its filters, and every export leaves an `export.created` row.
// Part 2 adds the live grid, the day view (a table picker) and the report by task. Each
// test finds its own audit row by actor, page and time, so it passes alone and after any
// other spec.
import { readFile } from "node:fs/promises";
import { readXlsx } from "@ai-proctor/core";
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { agentFor, clientFor } from "./agent";
import { expectNoA11yViolations } from "./helpers";

const ADMIN_EMAIL = "admin@acme.test";
const MANAGER_EMAIL = "manager@acme.test";
const ADA = "00000000-0000-4000-8000-0000000000a1";
const MAX = "00000000-0000-4000-8000-0000000000b1";
const ERIN = "00000000-0000-4000-8000-0000000000c1";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/** `actorId`'s export rows for `page` since `since`, newest first, read as the admin. */
async function exportsSince(actorId: string, page: string, since: string) {
  const admin = await clientFor(ADMIN_EMAIL);
  const { data, error } = await admin
    .from("audit_log")
    .select("metadata, at")
    .eq("action", "export.created")
    .eq("actor_id", actorId)
    .gte("at", since)
    .order("at", { ascending: false });
  if (error) throw error;
  return data.map((r) => r.metadata as Record<string, unknown>).filter((m) => m.page === page);
}

// The database's clock and this machine's may differ by a little.
const sinceNow = () => DateTime.now().minus({ seconds: 30 }).toUTC().toISO() ?? "";

/** A downloaded CSV's lines, without the empty one after the last CRLF. */
async function csvLines(file: { path: () => Promise<string | null> }): Promise<string[]> {
  const lines = (await readFile((await file.path()) ?? "", "utf8")).split("\r\n");
  expect(lines.at(-1)).toBe("");
  return lines.slice(0, -1);
}

test("an admin exports the filtered People list as CSV, and the export is audit-logged", async ({
  page,
}) => {
  const since = sinceNow();
  await signIn(page, ADMIN_EMAIL, /\/team$/);
  await page.goto("/people");
  await expect(page.getByRole("heading", { name: "People", exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search people" }).fill("Erin");
  // The people table (the enrollment tokens' table follows it).
  await expect(page.locator("table").first().locator("tbody tr")).toHaveCount(1);

  await page.getByRole("button", { name: "Export people" }).click();
  const dialog = page.getByRole("dialog", { name: "Export people" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("search: Erin");
  await expectNoA11yViolations(page);

  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^people-erin-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = (await readFile((await file.path()) ?? "", "utf8")).split("\r\n");
  expect(lines[0]).toBe(
    "Name,Email,Role,Manager,Team,Country,State,Time zone,Status,Approval required,Assistive input",
  );
  // The one row the search leaves, then nothing after the last CRLF.
  expect(lines).toHaveLength(3);
  expect(lines[1]).toMatch(/^Erin Employee,erin@acme\.test,Employee,Max Manager,/);
  await expect(dialog).not.toBeVisible();

  await expect
    .poll(async () => (await exportsSince(ADA, "people", since)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const [logged] = await exportsSince(ADA, "people", since);
  expect(logged).toMatchObject({ format: "csv", row_count: 1, filters: { search: "Erin" } });
  await expectNoA11yViolations(page);
});

test("a manager exports alert history as XLSX with the page's filters, and it is audit-logged", async ({
  page,
}) => {
  const since = sinceNow();
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/alerts");
  await expect(page.getByRole("heading", { name: "Alerts", exact: true })).toBeVisible();
  await page.getByLabel("Status").selectOption("unread");
  // The button waits for the filtered list.
  await expect(page.getByRole("button", { name: "Export alerts" })).toBeEnabled();
  await expect(page.getByText("Loading…")).toHaveCount(0);
  await expectNoA11yViolations(page);

  await page.getByRole("button", { name: "Export alerts" }).click();
  const dialog = page.getByRole("dialog", { name: "Export alerts" });
  await expect(dialog).toContainText("status: Unread");
  const format = dialog.getByRole("radiogroup", { name: "Format" });
  await format.getByText("XLSX").click();
  await expect(format.getByLabel("XLSX")).toBeChecked();
  await expectNoA11yViolations(page);

  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download XLSX" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^alerts-unread-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const [sheet] = readXlsx(new Uint8Array(await readFile((await file.path()) ?? "")));
  expect(sheet?.name).toBe("Alerts");
  expect(sheet?.rows[0]?.map((c) => c.value)).toEqual([
    "Triggered",
    "Employee",
    "Kind",
    "Alert",
    "Status",
  ]);
  // Only unread alerts, however many other specs left.
  const rows = sheet?.rows.slice(1) ?? [];
  for (const row of rows) expect(row[4]?.value).toBe("Unread");

  await expect
    .poll(async () => (await exportsSince(MAX, "alerts", since)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const [logged] = await exportsSince(MAX, "alerts", since);
  expect(logged).toMatchObject({
    format: "xlsx",
    row_count: rows.length,
    filters: { status: "Unread" },
  });
});

test("a manager exports the live grid's snapshot with its search, and it is audit-logged", async ({
  page,
}) => {
  const since = sinceNow();
  const erin = await agentFor("erin@acme.test");
  // Erin on shift, so the snapshot has her row; whatever an earlier run left, from clocked out.
  await erin("clock_out", { reason: "manual" });
  await erin("clock_in", { reason: "manual" });
  try {
    await signIn(page, MANAGER_EMAIL, /\/team$/);
    await expect(page.getByRole("heading", { name: "Live team", exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search people" }).fill("Erin");
    await expect(page.getByRole("row").filter({ hasText: "Erin Employee" })).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole("button", { name: "Export live team" }).click();
    const dialog = page.getByRole("dialog", { name: "Export live team" });
    await expect(dialog).toContainText("search: Erin");
    await expectNoA11yViolations(page);

    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^live-team-erin-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = await csvLines(file);
    expect(lines[0]).toBe(
      "Name,Team,Status,Since,Last check-in,Last check-in result,Check-ins passed today,Check-ins shown today,Project",
    );
    expect(lines).toHaveLength(2);
    // Her status, and since when, with the viewer's offset.
    expect(lines[1]).toMatch(
      /^Erin Employee,[^,]*,Active,\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2}),/,
    );

    await expect
      .poll(async () => (await exportsSince(MAX, "live-team", since)).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const [logged] = await exportsSince(MAX, "live-team", since);
    expect(logged).toMatchObject({ format: "csv", row_count: 1, filters: { search: "Erin" } });
  } finally {
    await erin("clock_out", { reason: "manual" });
  }
});

test("a manager exports a day's check-ins and segments, each its own audit-logged file", async ({
  page,
}) => {
  const since = sinceNow();
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto(`/team/${ERIN}`);
  await expect(page.getByRole("heading", { name: "Erin Employee", exact: true })).toBeVisible();
  const date = await page.getByLabel("Day", { exact: true }).inputValue();

  await page.getByRole("button", { name: "Export day" }).click();
  const dialog = page.getByRole("dialog", { name: "Export day" });
  await expect(dialog).toContainText("person: Erin Employee");
  await expect(dialog).toContainText(`date: ${date}`);
  const table = dialog.getByRole("radiogroup", { name: "Table" });
  await expect(table.getByLabel("Check-ins")).toBeChecked();
  await expectNoA11yViolations(page);

  // The check-ins as CSV: what happened, never the captures themselves.
  let download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download CSV" }).click();
  const checkins = await download;
  expect(checkins.suggestedFilename()).toMatch(
    new RegExp(`^day-checkins-erin-employee_${date}-\\d{4}-\\d{2}-\\d{2}\\.csv$`),
  );
  const lines = await csvLines(checkins);
  expect(lines[0]).toBe(
    "Time,Outcome,Response (s),Reason,Remark,Project,Screenshots,Webcam frame,Removed parts,Removed at,No face detected,Needs review",
  );
  for (const line of lines.slice(1)) expect(line).not.toMatch(/https?:|\.webp/);
  await expect(dialog).not.toBeVisible();

  // The segments as XLSX, picked in the same dialog.
  await page.getByRole("button", { name: "Export day" }).click();
  await table.getByText("Segments").click();
  await expect(table.getByLabel("Segments")).toBeChecked();
  const format = dialog.getByRole("radiogroup", { name: "Format" });
  await format.getByText("XLSX").click();
  download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download XLSX" }).click();
  const segments = await download;
  expect(segments.suggestedFilename()).toMatch(/^day-segments-erin-employee_.*\.xlsx$/);
  const [sheet] = readXlsx(new Uint8Array(await readFile((await segments.path()) ?? "")));
  expect(sheet?.name).toBe("Segments");
  expect(sheet?.rows[0]?.map((c) => c.value)).toEqual([
    "Start",
    "End",
    "Type",
    "Project",
    "Task",
    "Hours",
    "Seconds",
    "Counted",
    "Flagged",
    "Excluded",
  ]);

  await expect
    .poll(
      async () =>
        (await exportsSince(MAX, "day-checkins", since)).length +
        (await exportsSince(MAX, "day-segments", since)).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(1);
  const [checkinsLogged] = await exportsSince(MAX, "day-checkins", since);
  expect(checkinsLogged).toMatchObject({
    format: "csv",
    row_count: lines.length - 1,
    filters: { person: "Erin Employee", date },
  });
  const [segmentsLogged] = await exportsSince(MAX, "day-segments", since);
  expect(segmentsLogged).toMatchObject({
    format: "xlsx",
    row_count: (sheet?.rows.length ?? 1) - 1,
    filters: { person: "Erin Employee", date },
  });
  await expectNoA11yViolations(page);
});

test("a manager exports the report grouped by task, and it is audit-logged", async ({ page }) => {
  const since = sinceNow();
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  await page.getByLabel("Group by").selectOption("task");
  const from = await page.getByLabel("From", { exact: true }).inputValue();
  const to = await page.getByLabel("To", { exact: true }).inputValue();

  await page.getByRole("button", { name: "Export report" }).click();
  const dialog = page.getByRole("dialog", { name: "Export report" });
  await expect(dialog).toContainText(`from: ${from}`);
  await expectNoA11yViolations(page);

  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    new RegExp(`^report-tasks-${from}_${to}-\\d{4}-\\d{2}-\\d{2}\\.csv$`),
  );
  const lines = await csvLines(file);
  expect(lines[0]).toBe("Project,Task,Worked (h),Flagged (h),People");
  // Projects and their tasks, then the Total row, as the table shows them.
  expect(lines.at(-1)).toMatch(/^Total,,\d+(\.\d+)?,\d+(\.\d+)?,\d+$/);

  await expect
    .poll(async () => (await exportsSince(MAX, "report-tasks", since)).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  const [logged] = await exportsSince(MAX, "report-tasks", since);
  expect(logged).toMatchObject({
    format: "csv",
    row_count: lines.length - 1,
    filters: { from, to },
  });
});
