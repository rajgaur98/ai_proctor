// Settings → Import (#256): an admin downloads a template, uploads a CSV, reads the
// row-by-row errors, fixes the file, imports it, and the same file then reads as
// unchanged. Managers can't open the page. The clients it adds have names no other spec
// uses and end archived, so other specs see the org as they left it. Time entries (#282)
// go on a past day no other spec uses; Lucas's pending one is cancelled at the end.
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { clientFor } from "./agent";
import { expectNoA11yViolations, MANAGER_EMAIL } from "./helpers";

const ADMIN_EMAIL = "admin@acme.test";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

async function upload(page: Page, name: string, csv: string) {
  await page
    .getByLabel(/Spreadsheet/)
    .setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(csv) });
}

const row = (page: Page, n: number) =>
  page.getByRole("row").filter({ has: page.getByRole("cell", { name: String(n), exact: true }) });

test("an admin previews a CSV, fixes its errors, imports it, and the same file is then unchanged", async ({
  page,
}) => {
  const stamp = Date.now();
  const a = `Import Co ${stamp}`;
  const b = `Import Labs ${stamp}`;

  await signIn(page, ADMIN_EMAIL, /\/team/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Import" })
    .click();
  await expect(page).toHaveURL(/\/settings\/import/);
  await expect(page.getByRole("heading", { name: "Import" })).toBeVisible();

  await page.getByRole("radio", { name: "Clients" }).check();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download template" }).click();
  const template = await download;
  expect(template.suggestedFilename()).toBe("ai-proctor-clients-import-template.csv");
  expect(await readFile((await template.path()) ?? "", "utf8")).toBe(
    "name,archived\r\nAcme Corp,no\r\n",
  );

  // A file with a repeated name and a value that isn't yes or no.
  await upload(
    page,
    "clients.csv",
    `Client,Archived,Notes\n${a},yes,x\n${a.toUpperCase()},no,\n${b},maybe,\n`,
  );
  await expect(row(page, 2).getByRole("cell", { name: "New" })).toBeVisible();
  await expect(row(page, 3)).toContainText(`The client "${a.toUpperCase()}" is also on row 2.`);
  await expect(row(page, 4)).toContainText('"maybe" should be yes, no, archived or active.');
  await expect(page.getByText("Not read (no such column): Notes")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Import/ })).toBeDisabled();
  await expectNoA11yViolations(page);

  // Fixed: both new, both archived.
  const fixed = `name,archived\n${a},yes\n${b},archived\n`;
  await upload(page, "clients-fixed.csv", fixed);
  await expect(row(page, 2).getByRole("cell", { name: "New" })).toBeVisible();
  await expect(row(page, 3).getByRole("cell", { name: "New" })).toBeVisible();
  await page.getByRole("button", { name: "Import 2 changes" }).click();
  await expect(page.getByRole("status")).toContainText("Imported: 2 added, 0 updated.");

  // The same file again: nothing to do.
  await expect(row(page, 2).getByRole("cell", { name: "Unchanged" })).toBeVisible();
  await expect(row(page, 3).getByRole("cell", { name: "Unchanged" })).toBeVisible();
  await expect(page.getByText("Everything in this file is already up to date.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Import", exact: true })).toBeDisabled();

  const admin = await clientFor(ADMIN_EMAIL);
  const { data, error } = await admin
    .from("clients")
    .select("name, archived")
    .in("name", [a, b])
    .order("name");
  if (error) throw error;
  expect(data).toEqual([
    { name: a, archived: true },
    { name: b, archived: true },
  ]);
  const audit = await admin
    .from("audit_log")
    .select("metadata")
    .eq("action", "import.applied")
    .eq("metadata->>kind", "clients")
    .order("at", { ascending: false })
    .limit(1)
    .single();
  if (audit.error) throw audit.error;
  expect(audit.data.metadata).toEqual({ kind: "clients", created: 2, updated: 0, rows: 2 });
});

test("an admin imports time entries: pending for an employee, approved for the owner, then unchanged", async ({
  page,
}) => {
  const stamp = Date.now();
  // A day 200 to 3,000 days ago and a minute from the stamp: no other spec's time.
  const day = new Date(stamp - (200 + (stamp % 2800)) * 86_400_000).toISOString().slice(0, 10);
  const minute = String(10 + (Math.floor(stamp / 1000) % 50)).padStart(2, "0");
  const note = `Imported note ${stamp}`;

  await signIn(page, ADMIN_EMAIL, /\/team/);
  await page.goto("/settings/import");
  await page.getByRole("radio", { name: "Time entries" }).check();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download template" }).click();
  const template = await download;
  expect(template.suggestedFilename()).toBe("ai-proctor-time_entries-import-template.csv");
  expect(await readFile((await template.path()) ?? "", "utf8")).toBe(
    "email,date,start,end,project,task,note,reason\r\n" +
      "jane.doe@example.com,2026-10-26,09:00,12:30,Website redesign,Design,Home page wireframes,Logged in our old tool\r\n",
  );

  // Lucas's second row overlaps his first; Internal isn't one of his projects.
  await upload(
    page,
    "time.csv",
    "Email,Start date,Start time,End time,Project,Description\n" +
      `lucas@acme.test,${day},09:${minute},10:30,Website revamp,${note}\n` +
      `lucas@acme.test,${day},10:00,11:00,,\n` +
      `lucas@acme.test,${day},15:00,16:00,Internal,\n`,
  );
  await expect(row(page, 2).getByRole("cell", { name: "New" })).toBeVisible();
  await expect(row(page, 3)).toContainText("Overlaps row 2.");
  await expect(row(page, 4)).toContainText(
    "lucas@acme.test can't log time to Internal. Add them to the project first.",
  );
  await expect(page.getByRole("button", { name: /^Import/ })).toBeDisabled();
  await expectNoA11yViolations(page);

  const fixed =
    "email,date,start,end,project,note,reason\n" +
    `lucas@acme.test,${day},09:${minute},10:30,Website revamp,${note},\n` +
    `admin@acme.test,${day},13:00,14:00,,,Old tool\n`;
  await upload(page, "time-fixed.csv", fixed);
  await expect(row(page, 2).getByRole("cell", { name: "New" })).toBeVisible();
  await expect(row(page, 3).getByRole("cell", { name: "New" })).toBeVisible();
  await page.getByRole("button", { name: "Import 2 changes" }).click();
  await expect(page.getByRole("status")).toContainText("Imported: 2 added, 0 updated.");

  // The same file again: nothing to do.
  await expect(row(page, 2).getByRole("cell", { name: "Unchanged" })).toBeVisible();
  await expect(row(page, 3).getByRole("cell", { name: "Unchanged" })).toBeVisible();
  await expect(page.getByText("Everything in this file is already up to date.")).toBeVisible();

  const admin = await clientFor(ADMIN_EMAIL);
  const { data, error } = await admin
    .from("manual_entries")
    .select("id, user_id, status, note, reason")
    .gte("start_at", `${day}T00:00:00Z`)
    .lt("start_at", `${day}T23:59:59Z`)
    .in("reason", ["Imported", "Old tool"])
    .order("reason");
  if (error) throw error;
  // The seed's Lucas and Ada.
  expect(data.map((e) => [e.user_id, e.status, e.note, e.reason])).toEqual([
    ["00000000-0000-4000-8000-0000000000c2", "pending", note, "Imported"],
    ["00000000-0000-4000-8000-0000000000a1", "approved", null, "Old tool"],
  ]);
  const audit = await admin
    .from("audit_log")
    .select("metadata")
    .eq("action", "import.applied")
    .eq("metadata->>kind", "time_entries")
    .order("at", { ascending: false })
    .limit(1)
    .single();
  if (audit.error) throw audit.error;
  expect(audit.data.metadata).toEqual({
    kind: "time_entries",
    created: 2,
    updated: 0,
    unchanged: 0,
    rows: 2,
  });

  // Leave no pending request behind for Lucas's manager.
  const lucas = await clientFor("lucas@acme.test");
  const pending = data.find((e) => e.status === "pending");
  const cancelled = await lucas.rpc("cancel_manual_entry", { p_id: pending?.id ?? "" });
  if (cancelled.error) throw cancelled.error;
});

test("a manager can't open the import page", async ({ page }) => {
  await signIn(page, MANAGER_EMAIL, /\/team/);
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Import" }),
  ).toHaveCount(0);
  await page.goto("/settings/import");
  await expect(page).toHaveURL(/\/team/);
});
