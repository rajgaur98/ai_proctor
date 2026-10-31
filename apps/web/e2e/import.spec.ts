// Settings → Import (#256): an admin downloads a template, uploads a CSV, reads the
// row-by-row errors, fixes the file, imports it, and the same file then reads as
// unchanged. Managers can't open the page. The clients it adds have names no other spec
// uses and end archived, so other specs see the org as they left it.
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
    .order("at", { ascending: false })
    .limit(1)
    .single();
  if (audit.error) throw audit.error;
  expect(audit.data.metadata).toEqual({ kind: "clients", created: 2, updated: 0, rows: 2 });
});

test("a manager can't open the import page", async ({ page }) => {
  await signIn(page, MANAGER_EMAIL, /\/team/);
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Import" }),
  ).toHaveCount(0);
  await page.goto("/settings/import");
  await expect(page).toHaveURL(/\/team/);
});
