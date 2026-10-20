import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { clientFor } from "./agent";
import {
  ERIN,
  ERIN_EMAIL,
  MANAGER_EMAIL,
  resetErinWeeks,
  submitErinWeek,
  erinWeek as week,
} from "./helpers";

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

/** Erin submits her week and the manager returns it with a comment. */
async function returnedWeek(comment: string) {
  // Whatever earlier specs left: approved weeks reopen, submitted ones return, then submit.
  await resetErinWeeks();
  const id = await submitErinWeek();
  const manager = await clientFor(MANAGER_EMAIL);
  const returned = await manager.rpc("return_timesheet", { p_id: id, p_comment: comment });
  if (returned.error) throw returned.error;
}

async function clearUnread() {
  const erin = await clientFor(ERIN_EMAIL);
  const cleared = await erin.rpc("mark_notifications_read");
  expect(cleared.error).toBeNull();
}

test("an employee is notified of a returned week, opens it, and the unread count drops", async ({
  page,
}) => {
  const comment = `Please add Thursday's visit ${Date.now()}`;
  // Setup returns the week too; start from nothing unread, then the one that counts.
  await returnedWeek("e2e setup");
  await clearUnread();
  await returnedWeek(comment);

  await signIn(page, ERIN_EMAIL, /\/me$/);
  await page.getByRole("button", { name: "Notifications, 1 unread" }).click();
  const panel = page.getByRole("region", { name: "Notifications" });
  const item = panel.getByRole("listitem").filter({ hasText: comment });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("was returned to you");
  await expectNoA11yViolations(page);

  await item.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/timesheets/${ERIN}\\?week=${week}$`));
  await expect(page.getByRole("status")).toContainText(comment);
  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();

  // The notification stays in the list, read.
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await expect(item).toHaveCount(1);
  await expectNoA11yViolations(page);
});

test("mark all read clears the count, and a manager sees the notifications and the alerts bell", async ({
  page,
}) => {
  await returnedWeek(`Second return ${Date.now()}`);

  await signIn(page, ERIN_EMAIL, /\/me$/);
  const bell = page.getByRole("button", { name: /^Notifications, \d+ unread/ });
  await expect(bell).toBeVisible();
  await bell.click();
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark all read" })).toBeDisabled();

  await page.getByLabel("Account menu for Erin Employee").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await expect(page.getByRole("button", { name: /^Notifications/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Alerts/ })).toBeVisible();
  await expectNoA11yViolations(page);
});
