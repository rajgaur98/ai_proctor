import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { clientFor } from "./agent";

const MANAGER_EMAIL = "manager@acme.test";
const ADMIN_EMAIL = "admin@acme.test";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Export rows in the audit log, as the admin who may read it. */
async function exportsLogged() {
  const admin = await clientFor(ADMIN_EMAIL);
  const { count, error } = await admin
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("action", "timesheet.exported");
  if (error) throw error;
  return count ?? 0;
}

test("a manager exports the week as CSV from the Timesheets tab, and it is audit-logged", async ({
  page,
}) => {
  const before = await exportsLogged();
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/timesheets");
  await expect(page.getByRole("heading", { name: "Timesheets" })).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByRole("button", { name: "Export CSV" }).click();
  const dialog = page.getByRole("dialog", { name: "Export CSV" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Employee")).toBeVisible();
  await expect(dialog.getByLabel("Approval status")).toBeVisible();
  await expectNoA11yViolations(page);

  // The dialog opens on the week the tab shows.
  const from = await dialog.getByLabel("From").inputValue();
  const to = await dialog.getByLabel("To").inputValue();
  expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await dialog.getByLabel("View").selectOption("project");

  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`timesheet-project-${from}_${to}.csv`);
  const text = await readFile((await file.path()) ?? "", "utf8");
  const lines = text.replace(/^﻿/, "").split("\r\n");
  expect(lines[0]).toContain("Employee,Email,Client,Project,Billable,Worked (h),Worked (H:MM)");
  expect(lines[0]).toMatch(/Status,Approver$/);
  // Header, the people's rows, then the Total row; nothing after the last CRLF.
  expect(lines.at(-1)).toBe("");
  expect(lines.at(-2)).toMatch(/^Total,/);
  await expect(dialog).not.toBeVisible();

  await expect.poll(exportsLogged).toBe(before + 1);
});

test("a range that ends before it starts is explained and nothing is exported", async ({
  page,
}) => {
  const before = await exportsLogged();
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/timesheets");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const dialog = page.getByRole("dialog", { name: "Export CSV" });
  await dialog.getByLabel("From").fill("2026-03-22");
  await dialog.getByLabel("To").fill("2026-03-16");
  await dialog.getByRole("button", { name: "Download CSV" }).click();
  await expect(dialog.getByRole("alert")).toContainText("same or later");
  await expectNoA11yViolations(page);
  expect(await exportsLogged()).toBe(before);
});
