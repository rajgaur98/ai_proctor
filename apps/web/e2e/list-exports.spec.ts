// List page exports (#255, TS-20 extended, AUD-01): the shared Export button downloads
// what the page shows with its filters, and every export leaves an `export.created` row.
// Each test finds its own audit row by actor, page and time, so it passes alone and
// after any other spec.
import { readFile } from "node:fs/promises";
import { readXlsx } from "@ai-proctor/core";
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import { expectNoA11yViolations } from "./helpers";

const ADMIN_EMAIL = "admin@acme.test";
const MANAGER_EMAIL = "manager@acme.test";
const ADA = "00000000-0000-4000-8000-0000000000a1";
const MAX = "00000000-0000-4000-8000-0000000000b1";

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
