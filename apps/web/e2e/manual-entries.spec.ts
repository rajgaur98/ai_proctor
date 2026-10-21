import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { expectNoA11yViolations } from "./helpers";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

test("an employee requests manual time and her manager approves it", async ({ page }) => {
  // A past day nobody has clocked in on, picked per run: the local database keeps
  // earlier runs, and entries can't overlap.
  const day = DateTime.now()
    .minus({ days: 30 + (Date.now() % 1000) })
    .toISODate();
  const reason = `Client visit ${Date.now()}`;

  await signIn(page, "erin@acme.test", /\/me$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "My day" })
    .click();
  await expect(page).toHaveURL(/\/team\/[0-9a-f-]{36}$/);
  const erinDay = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { name: "Erin Employee" })).toBeVisible();
  // Employees open only their own day.
  await page.goto("/team/00000000-0000-4000-8000-0000000000b1");
  await expect(page).toHaveURL(/\/me$/);

  await page.goto(`${erinDay}?date=${day}`);
  const entries = page.getByRole("region", { name: "Manual entries" });
  await expect(entries).toContainText("No manual entries on this day.");
  await page.getByRole("button", { name: "Request manual time" }).click();
  const dialog = page.getByRole("dialog", { name: "Request manual time" });
  await dialog.getByLabel("Start").fill("10:00");
  await dialog.getByLabel("End").fill("11:30");
  await dialog.getByLabel("Project").selectOption({ label: "Website revamp" });
  await dialog.getByLabel("Reason").fill(reason);
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(dialog).toBeHidden();

  const row = entries.getByRole("listitem").filter({ hasText: reason });
  await expect(row).toContainText("Pending, not counted");
  await expect(row).toContainText("1 h 30 min");
  await expect(row).toContainText("Website revamp");
  await expect(row.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expectNoA11yViolations(page);

  // An overlapping request is explained, not lost.
  await page.getByRole("button", { name: "Request manual time" }).click();
  await dialog.getByLabel("Start").fill("11:00");
  await dialog.getByLabel("End").fill("12:00");
  await dialog.getByLabel("Reason").fill("Overlaps the first");
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("That overlaps another manual entry.");
  await dialog.getByRole("button", { name: "Close" }).click();

  await page.getByLabel("Account menu for Erin Employee").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await signIn(page, "manager@acme.test", /\/team$/);
  await page.goto(`${erinDay}?date=${day}`);
  const managerRow = page
    .getByRole("region", { name: "Manual entries" })
    .getByRole("listitem")
    .filter({ hasText: reason });
  await expect(managerRow).toContainText("Pending, not counted");
  await expect(managerRow.getByRole("button", { name: "Cancel request" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Request manual time" })).toHaveCount(0);
  await managerRow.getByLabel("Note for the decision (optional)").fill("Thanks");
  await expectNoA11yViolations(page);
  await managerRow.getByRole("button", { name: "Approve" }).click();

  await expect(managerRow).toContainText("Approved");
  await expect(managerRow).toContainText("Manager's note: Thanks");
  await expect(managerRow.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expectNoA11yViolations(page);
});
