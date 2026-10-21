import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { acknowledgeLatestNotice, asEmployee, clientFor } from "./agent";
import { expectNoA11yViolations } from "./helpers";

// Erin has the current version whatever ran before (publishing in the notice spec resets everyone).
test.beforeAll(async () => {
  await asEmployee("erin@acme.test", async (db) => {
    await acknowledgeLatestNotice(db);
    return { error: null };
  });
});

test("an admin sees who has acknowledged, filters, and exports a CSV that is audit-logged", async ({
  page,
}) => {
  const email = `blake-${Date.now()}@acme.test`;
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("admin@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });

  // Someone just invited has never acknowledged anything.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "People" })
    .click();
  await page.getByRole("button", { name: "Invite people" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite people" });
  await dialog.getByLabel("Work email").fill(email);
  await dialog.getByLabel("Full name").fill("Blake Blocked");
  await dialog.getByLabel("Direct manager").selectOption({ label: "Max Manager" });
  await dialog.getByLabel("State").selectOption("NY");
  await dialog.getByRole("button", { name: "Send invites" }).click();
  await expect(dialog.getByRole("list", { name: "Invite results" })).toContainText(
    `${email}: invited`,
    { timeout: 15_000 },
  );
  await dialog.getByRole("button", { name: "Close" }).click();

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Monitoring notice" })
    .click();
  await expect(page.getByRole("heading", { name: "Who has acknowledged" })).toBeVisible();
  const erin = page.getByRole("row").filter({ hasText: "Erin Employee" });
  const blake = page.getByRole("row").filter({ hasText: email });
  await expect(erin).toContainText("Up to date");
  await expect(erin).toContainText(/Version \d+ · /);
  await expect(blake).toContainText("Blocked from clocking in");
  await expect(blake).toContainText("Never");
  await expect(page.getByText(/\d+ of \d+ acknowledged version \d+/)).toContainText(
    /never acknowledged and cannot clock in/,
  );
  await expectNoA11yViolations(page);

  await page.getByLabel("Show").selectOption("not_yet");
  await expect(blake).toBeVisible();
  await expect(erin).toHaveCount(0);
  await page.getByLabel("Show").selectOption("acknowledged_current");
  await expect(erin).toBeVisible();
  await expect(blake).toHaveCount(0);
  await page.getByLabel("Show").selectOption("all");
  await expect(blake).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^notice-acknowledgements-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = readFileSync(await download.path(), "utf8")
    .trimEnd()
    .split("\r\n");
  expect(lines[0]).toBe(
    "Name,Email,Role,Manager,Acknowledged version,Acknowledged at (UTC),Acknowledged current version,Blocked from clocking in",
  );
  expect(
    lines.find((l) => l.startsWith("Erin Employee,erin@acme.test,Employee,Max Manager,")),
  ).toMatch(/,Yes,No$/);
  expect(lines).toContain(`Blake Blocked,${email},Employee,Max Manager,,,No,Yes`);

  // The export is in the audit log with its filter and row count.
  const admin = await clientFor("admin@acme.test");
  const { data, error } = await admin
    .from("audit_log")
    .select("metadata")
    .eq("action", "notice.ack_report_exported")
    .order("at", { ascending: false })
    .limit(1)
    .single();
  expect(error).toBeNull();
  expect(data?.metadata).toMatchObject({ status: "all", row_count: lines.length - 1 });
  await expectNoA11yViolations(page);
});

test("an employee does not see the report", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("erin@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/me$/, { timeout: 15_000 });
  await page.goto("/notice");
  await expect(page.getByRole("heading", { name: "Monitoring notice" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who has acknowledged" })).toHaveCount(0);
});
