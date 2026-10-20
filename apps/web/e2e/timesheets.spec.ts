import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { clientFor } from "./agent";
import {
  ERIN,
  ERIN_EMAIL,
  flaggedTime,
  MANAGER_EMAIL,
  resetErinWeeks,
  settleErinFlagged,
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

async function signOut(page: Page, name: string) {
  await page.getByLabel(`Account menu for ${name}`).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("an employee submits her week, the manager excludes flagged time with a reason and approves, and she sees the edit", async ({
  page,
}) => {
  // Submitting and opening the week each rebuild seven days through the Edge Function.
  test.setTimeout(60_000);
  const reason = `Idle before lunch ${Date.now()}`;
  await resetErinWeeks();
  await flaggedTime();

  await signIn(page, ERIN_EMAIL, /\/me$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "My timesheet" })
    .click();
  await expect(page.getByRole("heading", { name: "My timesheet" })).toBeVisible();
  const thisWeek = page.getByRole("listitem").first();
  await expect(thisWeek).toContainText(/Draft|Returned/);
  await expectNoA11yViolations(page);
  await thisWeek.getByRole("button", { name: /^Submit Week of/ }).click();
  // Submitting rebuilds the week through the Edge Function first.
  await expect(thisWeek).toContainText("Submitted", { timeout: 20_000 });

  await thisWeek.getByRole("link", { name: /^Week of/ }).click();
  await expect(page.getByRole("heading", { name: /Erin Employee · Week of/ })).toBeVisible();
  await expect(page.getByText(/^Submitted · /)).toBeVisible();
  // The employee reads her week; the review controls are the manager's.
  await expect(page.getByRole("button", { name: "Approve week" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Flagged segments" })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await signOut(page, "Erin Employee");

  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Timesheets" })
    .click();
  await expect(page.getByRole("heading", { name: "Timesheets" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Status" })).toBeVisible();
  await expectNoA11yViolations(page);
  await page.getByRole("link", { name: "Review Erin Employee's timesheet" }).click();

  const approve = page.getByRole("button", { name: "Approve week" });
  const flagged = page.getByRole("region", { name: "Flagged segments" });
  // The list fills in once the page has rebuilt the week.
  await expect(flagged.getByRole("listitem").first()).toBeVisible({ timeout: 20_000 });
  await expect(approve).toBeDisabled();
  await expect(page.getByText(/Decide on \d+ flagged segments? first/)).toBeVisible();
  await expectNoA11yViolations(page);

  // Keep everything but Erin's newest flagged segment, and exclude that one with a reason.
  const items = flagged.getByRole("listitem");
  const count = await items.count();
  for (let i = 0; i < count - 1; i++) {
    await items.nth(i).getByRole("button", { name: "Keep", exact: true }).click();
    await expect(items.nth(i).getByRole("button", { name: "Keep", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }
  const newest = items.nth(count - 1);
  await newest.getByRole("button", { name: "Exclude", exact: true }).click();
  await newest.getByRole("button", { name: "Save exclusion" }).click();
  await expect(newest.getByRole("alert")).toHaveText("Give a reason");
  await newest.getByLabel(/Reason for excluding/).fill(reason);
  await expectNoA11yViolations(page);
  await newest.getByRole("button", { name: "Save exclusion" }).click();
  await expect(newest).toContainText(`Excluded: ${reason}`);
  await expect(newest.getByRole("button", { name: "Exclude", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("region", { name: "Edits so far" })).toContainText(reason);

  await expect(approve).toBeEnabled();
  await expect(page.getByText("Ready to approve")).toBeVisible();
  await approve.click();
  await expect(page.getByText(/^Approved · /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reopen week" })).toBeVisible();
  await expect(approve).toHaveCount(0);
  await expectNoA11yViolations(page);
  await signOut(page, "Max Manager");

  await signIn(page, ERIN_EMAIL, /\/me$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "My timesheet" })
    .click();
  await page
    .getByRole("link", { name: /^Week of/ })
    .first()
    .click();
  await expect(page.getByText(/^Approved · /)).toBeVisible();
  const edits = page.getByRole("region", { name: "Edits to your time" });
  await expect(edits).toContainText("Excluded flagged time");
  await expect(edits).toContainText(`Reason: ${reason}`);
  // Keep is a review decision, not an edit: she doesn't see it.
  await expect(edits).not.toContainText("Kept");
  await expectNoA11yViolations(page);
});

test("a manager returns a week with a comment and the employee sees it", async ({ page }) => {
  const comment = `Please add Thursday's visit ${Date.now()}`;
  await resetErinWeeks();
  await submitErinWeek();

  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  await expect(page.getByText(/^Submitted · /)).toBeVisible();
  await page.getByRole("button", { name: "Return with comment" }).click();
  const dialog = page.getByRole("dialog", { name: "Return with comment" });
  await dialog.getByRole("button", { name: "Return week" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Add a comment");
  await dialog.getByLabel("Comment").fill(comment);
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Return week" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/^Returned · /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve week" })).toHaveCount(0);
  await signOut(page, "Max Manager");

  await signIn(page, ERIN_EMAIL, /\/me$/);
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  await expect(page.getByRole("status")).toContainText(comment);
  await expect(page.getByRole("button", { name: "Submit again" })).toBeVisible();
  await expectNoA11yViolations(page);
});

test("a manager reopens an approved week and the employee is notified", async ({ page }) => {
  const reason = `Forgot the Friday visit ${Date.now()}`;
  await resetErinWeeks();
  await submitErinWeek();
  const manager = await clientFor(MANAGER_EMAIL);
  const sheet = await manager
    .from("timesheets")
    .select("id")
    .eq("user_id", ERIN)
    .eq("period_start", week)
    .single();
  if (sheet.error) throw sheet.error;
  await settleErinFlagged(manager, sheet.data.id);
  const approved = await manager.rpc("approve_timesheet", { p_id: sheet.data.id });
  if (approved.error) throw approved.error;

  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  await expect(page.getByText(/^Approved · /)).toBeVisible();
  await page.getByRole("button", { name: "Reopen week" }).click();
  const dialog = page.getByRole("dialog", { name: "Reopen week" });
  await dialog.getByRole("button", { name: "Reopen week" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Give a reason");
  await dialog.getByLabel("Reason").fill(reason);
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Reopen week" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/^Submitted · /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve week" })).toBeVisible();

  const erin = await clientFor(ERIN_EMAIL);
  const notices = await erin
    .from("notifications")
    .select("payload")
    .eq("kind", "timesheet.reopened");
  if (notices.error) throw notices.error;
  expect(notices.data.map((n) => (n.payload as { reason?: string }).reason)).toContain(reason);
});
