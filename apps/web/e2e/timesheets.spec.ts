import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { agentFor, clientFor } from "./agent";

const ERIN = "00000000-0000-4000-8000-0000000000c1";
const ERIN_EMAIL = "erin@acme.test";
const MANAGER_EMAIL = "manager@acme.test";

/** Erin's current week, Monday-based like the seed org, in her time zone. */
const week = DateTime.now().setZone("America/Los_Angeles").startOf("week").toISODate() ?? "";

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

/** Leaves Erin's week open to submit again, whatever earlier runs did to it. */
async function resetWeek() {
  const manager = await clientFor(MANAGER_EMAIL);
  const { data, error } = await manager.from("timesheets").select("id, status").eq("user_id", ERIN);
  if (error) throw error;
  for (const sheet of data) {
    if (sheet.status === "approved") {
      const r = await manager.rpc("reopen_timesheet", { p_id: sheet.id, p_reason: "e2e reset" });
      if (r.error) throw r.error;
    }
    if (sheet.status === "approved" || sheet.status === "submitted") {
      const r = await manager.rpc("return_timesheet", { p_id: sheet.id, p_comment: "e2e reset" });
      if (r.error) throw r.error;
    }
  }
}

async function submitAsErin() {
  const erin = await clientFor(ERIN_EMAIL);
  const ensured = await erin.rpc("ensure_timesheet", { p_user_id: ERIN, p_period_start: week });
  if (ensured.error) throw ensured.error;
  const submitted = await erin.rpc("submit_timesheet", { p_id: ensured.data });
  if (submitted.error) throw submitted.error;
}

/** Time Erin was clocked in with a missed check-in: an unverified, flagged segment. */
async function flaggedTime() {
  const erin = await agentFor(ERIN_EMAIL);
  await erin("clock_out", { reason: "manual" });
  await erin("clock_in", { reason: "manual" });
  await erin("checkin", {
    // Scheduled well before it was shown, so it sorts ahead of the check-ins other specs
    // add today (day.spec reads the newest one).
    scheduled_at: new Date(Date.now() - 3_600_000).toISOString(),
    shown_at: new Date().toISOString(),
    outcome: "miss",
    wrong_clicks: 0,
    idle_s_at_show: 0,
    device_state: "active",
    object_keys: [],
    flags: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await erin("clock_out", { reason: "manual" });
}

test("an employee submits her week, the manager excludes flagged time with a reason and approves, and she sees the edit", async ({
  page,
}) => {
  const reason = `Idle before lunch ${Date.now()}`;
  await resetWeek();
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
  await expect(thisWeek).toContainText("Submitted");

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
  await expect(flagged.getByRole("listitem").first()).toBeVisible();
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
  await resetWeek();
  await submitAsErin();

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
  await resetWeek();
  await submitAsErin();
  const manager = await clientFor(MANAGER_EMAIL);
  const sheet = await manager
    .from("timesheets")
    .select("id")
    .eq("user_id", ERIN)
    .eq("period_start", week)
    .single();
  if (sheet.error) throw sheet.error;
  const flagged = await manager.rpc("timesheet_flagged_segments", {
    p_user_id: ERIN,
    p_from: week,
    p_to: DateTime.fromISO(week).plus({ days: 6 }).toISODate() ?? week,
  });
  if (flagged.error) throw flagged.error;
  for (const s of flagged.data) {
    const kept = await manager.rpc("edit_segment", {
      p_timesheet_id: sheet.data.id,
      p_kind: s.decision === "exclude" ? "include" : "keep",
      p_start_at: s.start_at,
      p_end_at: s.end_at,
      p_project_id: null as unknown as string,
      p_reason: "e2e" as string,
    });
    if (kept.error) throw kept.error;
  }
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
