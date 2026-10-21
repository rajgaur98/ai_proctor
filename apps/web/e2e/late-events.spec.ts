import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { agentFor, clientFor } from "./agent";
import { expectNoA11yViolations } from "./helpers";

const LUCAS = "00000000-0000-4000-8000-0000000000c2";
const LUCAS_EMAIL = "lucas@acme.test";
const MANAGER_EMAIL = "manager@acme.test";

// Lucas's previous week (Monday-based like the seed org, in his time zone): nothing else
// touches it, and its last day is inside the 7 days the server takes events for.
const thisWeek = DateTime.now().setZone("America/Chicago").startOf("week");
const week = thisWeek.minus({ weeks: 1 }).toISODate() ?? "";

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

/** Lucas submits his previous week and the manager approves it, whatever earlier runs left. */
async function approvedWeek(): Promise<string> {
  const lucas = await clientFor(LUCAS_EMAIL);
  const manager = await clientFor(MANAGER_EMAIL);
  const ensured = await lucas.rpc("ensure_timesheet", { p_user_id: LUCAS, p_period_start: week });
  if (ensured.error) throw ensured.error;
  const id = ensured.data;
  const sheet = await manager.from("timesheets").select("status").eq("id", id).single();
  if (sheet.error) throw sheet.error;
  if (sheet.data.status === "approved") {
    const r = await manager.rpc("reopen_timesheet", { p_id: id, p_reason: "e2e reset" });
    if (r.error) throw r.error;
  }
  if (sheet.data.status === "approved" || sheet.data.status === "submitted") {
    const r = await manager.rpc("return_timesheet", { p_id: id, p_comment: "e2e reset" });
    if (r.error) throw r.error;
  }
  const submitted = await lucas.rpc("submit_timesheet", { p_id: id });
  if (submitted.error) throw submitted.error;
  // Segments left by an earlier run's reopen: keep them so the week can be approved.
  const flagged = await manager.rpc("timesheet_flagged_segments", {
    p_user_id: LUCAS,
    p_from: week,
    p_to: DateTime.fromISO(week).plus({ days: 6 }).toISODate() ?? week,
  });
  if (flagged.error) throw flagged.error;
  for (const s of flagged.data) {
    const kept = await manager.rpc("edit_segment", {
      p_timesheet_id: id,
      p_kind: s.decision === "exclude" ? "include" : "keep",
      p_start_at: s.start_at,
      p_end_at: s.end_at,
      p_project_id: null as unknown as string,
      p_reason: "e2e" as string,
    });
    if (kept.error) throw kept.error;
  }
  const approved = await manager.rpc("approve_timesheet", { p_id: id });
  if (approved.error) throw approved.error;
  return id;
}

/** Late-data notices the manager has for one timesheet. */
async function lateNotices(id: string): Promise<number> {
  const manager = await clientFor(MANAGER_EMAIL);
  const { data, error } = await manager
    .from("notifications")
    .select("payload")
    .eq("kind", "timesheet.late_data");
  if (error) throw error;
  return data.filter((n) => (n.payload as { timesheet_id?: string }).timesheet_id === id).length;
}

/** Lucas's agent was offline: a shift on the last day of the approved week syncs now. */
async function lateShift() {
  const lucas = await agentFor(LUCAS_EMAIL);
  await lucas("clock_out", { reason: "manual" });
  const at = (minutes: number) => thisWeek.minus({ minutes }).toJSDate().toISOString();
  await lucas("clock_in", { reason: "manual" }, crypto.randomUUID(), at(10));
  await lucas("clock_out", { reason: "manual" }, crypto.randomUUID(), at(5));
}

test("events that sync after approval flag the week for the manager, and reopening clears it", async ({
  page,
}) => {
  const id = await approvedWeek();
  const before = await lateNotices(id);

  await lateShift();
  // One notice for the week, not one per event.
  expect(await lateNotices(id)).toBe(before + 1);

  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Timesheets" })
    .click();
  await page.getByRole("button", { name: "Previous week" }).click();
  const row = page.getByRole("row").filter({ hasText: "Lucas Martin" });
  await expect(row).toContainText("Approved");
  await expect(row).toContainText("New data");
  await expectNoA11yViolations(page);

  await page.goto(`/timesheets/${LUCAS}?week=${week}`);
  await expect(page.getByText(/^Approved · /)).toBeVisible({ timeout: 15_000 });
  const banner = page.getByRole("status");
  await expect(banner).toContainText(
    /New data arrived after approval \(\d+ events? since .+\)\. Reopen to include it\./,
  );
  await expectNoA11yViolations(page);

  await page.getByRole("button", { name: "Reopen week" }).click();
  const dialog = page.getByRole("dialog", { name: "Reopen week" });
  await dialog.getByLabel("Reason").fill("New data arrived");
  await dialog.getByRole("button", { name: "Reopen week" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/^Submitted · /)).toBeVisible();
  await expect(page.getByText(/New data arrived after approval/)).toHaveCount(0);
  await expectNoA11yViolations(page);
  await signOut(page, "Max Manager");

  // The employee reads the same week: reopened, so no banner.
  await signIn(page, LUCAS_EMAIL, /\/me$/);
  await page.goto(`/timesheets/${LUCAS}?week=${week}`);
  await expect(page.getByText(/^Submitted · /)).toBeVisible();
  await expect(page.getByText(/New data arrived after approval/)).toHaveCount(0);
});

test("the employee sees an info line on an approved week with late data", async ({ page }) => {
  await approvedWeek();
  await lateShift();

  await signIn(page, LUCAS_EMAIL, /\/me$/);
  await page.goto(`/timesheets/${LUCAS}?week=${week}`);
  await expect(page.getByText(/^Approved · /)).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    /New data arrived after approval \(\d+ events? since .+\)\. Your manager can reopen the week to include it\./,
  );
  await expect(page.getByRole("button", { name: "Reopen week" })).toHaveCount(0);
  await expectNoA11yViolations(page);
});
