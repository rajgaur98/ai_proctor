import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import {
  ERIN,
  ERIN_EMAIL,
  erinWeek,
  expectNoA11yViolations,
  MANAGER_EMAIL,
  resetErinWeeks,
  settleErinFlagged,
  submitErinWeek,
} from "./helpers";

const ADA = "00000000-0000-4000-8000-0000000000a1";
const OWNER_EMAIL = "admin@acme.test";

/** The same for Ada, who is in New York. */
const adaWeek = DateTime.now().setZone("America/New_York").startOf("week").toISODate() ?? "";

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

/** Leaves Max with no live delegation and Erin's week open to submit, whatever earlier runs did. */
async function resetState() {
  const manager = await clientFor(MANAGER_EMAIL);
  const live = await manager.rpc("my_delegations");
  if (live.error) throw live.error;
  for (const d of live.data) {
    const r = await manager.rpc("end_delegation", { p_id: d.id });
    if (r.error) throw r.error;
  }
  await resetErinWeeks();
}

test("a manager sets a delegate, the delegate decides and approves, then the manager ends it", async ({
  page,
}) => {
  // Opening the day and the week each rebuild segments through the Edge Function.
  test.setTimeout(90_000);
  const reason = `Client visit ${Date.now()}`;
  // A past day nobody has clocked in on, picked per run: the local database keeps earlier runs.
  const day = DateTime.now()
    .minus({ days: 400 + (Date.now() % 1000) })
    .toISODate();
  await resetState();
  await submitErinWeek();

  const erin = await clientFor(ERIN_EMAIL);
  const requested = await erin.rpc("request_manual_entry", {
    p_start_at:
      DateTime.fromISO(`${day}T10:00`, { zone: "America/Los_Angeles" }).toUTC().toISO() ?? "",
    p_end_at:
      DateTime.fromISO(`${day}T11:00`, { zone: "America/Los_Angeles" }).toUTC().toISO() ?? "",
    p_project_id: null as unknown as string,
    p_reason: reason,
  });
  if (requested.error) throw requested.error;

  // The manager names the owner as delegate (the seed has no second manager).
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Timesheets" })
    .click();
  const section = page.getByRole("region", { name: "Delegation" });
  await expect(section).toContainText("No delegate.");
  await page.getByRole("button", { name: "Set a delegate" }).click();
  const dialog = page.getByRole("dialog", { name: "Set a delegate" });
  await dialog.getByRole("button", { name: "Set delegate" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Choose who approves for you.");
  await dialog.getByLabel("Delegate").selectOption({ label: "Ada Admin" });
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Set delegate" }).click();
  await expect(dialog).toBeHidden();
  await expect(section).toContainText("Ada Admin approves for you");
  await expect(section).toContainText("Active");
  await expectNoA11yViolations(page);
  await signOut(page, "Max Manager");

  // The delegate sees it, decides Erin's manual entry on her day, and approves her week.
  await signIn(page, OWNER_EMAIL, /\/team$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Timesheets" })
    .click();
  await expect(page.getByRole("region", { name: "Delegation" })).toContainText(
    "You approve for Max Manager",
  );
  await expect(page.getByRole("button", { name: /^End delegation/ })).toHaveCount(0);

  await page.goto(`/team/${ERIN}?date=${day}`);
  const entry = page.getByRole("region", { name: "Manual entries" }).getByRole("listitem").filter({
    hasText: reason,
  });
  await expect(entry).toContainText("Pending");
  await entry.getByRole("button", { name: "Approve" }).click();
  await expect(entry).toContainText("Approved");
  await expectNoA11yViolations(page);

  // Settle Erin's flagged time and any pending requests in the week first (other specs add them).
  const owner = await clientFor(OWNER_EMAIL);
  const sheet = await owner
    .from("timesheets")
    .select("id, status")
    .eq("user_id", ERIN)
    .eq("period_start", erinWeek)
    .single();
  if (sheet.error) throw sheet.error;
  const pending = await owner
    .from("manual_entries")
    .select("id")
    .eq("user_id", ERIN)
    .eq("status", "pending");
  if (pending.error) throw pending.error;
  for (const e of pending.data) {
    const r = await owner.rpc("decide_manual_entry", { p_id: e.id, p_approve: false });
    if (r.error) throw r.error;
  }
  // The timesheet page rebuilds the week when it opens, which can add flagged time
  // other specs left behind; the helper rebuilds first so every flagged segment is settled.
  await settleErinFlagged(owner, sheet.data.id);
  // Still the week Erin submitted above (a failure here is state, not the page).
  expect(sheet.data.status).toBe("submitted");

  await page.goto(`/timesheets/${ERIN}?week=${erinWeek}`);
  await expect(page.getByText(/^Submitted · /)).toBeVisible({ timeout: 15_000 });
  // Approve is enabled once the page has rebuilt the week and found nothing to decide.
  await expect(page.getByRole("button", { name: "Approve week" })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole("button", { name: "Approve week" }).click();
  await expect(page.getByText(/^Approved · /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reopen week" })).toBeVisible();
  await expectNoA11yViolations(page);
  await signOut(page, "Ada Admin");

  // The manager ends it; the delegate can no longer decide.
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Timesheets" })
    .click();
  await page.getByRole("button", { name: "End delegation to Ada Admin" }).click();
  await expect(page.getByRole("region", { name: "Delegation" })).toContainText("No delegate.");
  const decide = await owner.rpc("can_decide_timesheet", { target: ERIN });
  if (decide.error) throw decide.error;
  expect(decide.data).toBe(false);
});

test("the owner reopens their own auto-approved week with a reason", async ({ page }) => {
  const reason = `Missed Friday ${Date.now()}`;
  const owner = await clientFor(OWNER_EMAIL);
  const ensured = await owner.rpc("ensure_timesheet", { p_user_id: ADA, p_period_start: adaWeek });
  if (ensured.error) throw ensured.error;
  const sheet = await owner.from("timesheets").select("status").eq("id", ensured.data).single();
  if (sheet.error) throw sheet.error;
  if (sheet.data.status !== "approved") {
    const submitted = await owner.rpc("submit_timesheet", { p_id: ensured.data });
    if (submitted.error) throw submitted.error;
  }

  await signIn(page, OWNER_EMAIL, /\/team$/);
  await page.goto(`/timesheets/${ADA}?week=${adaWeek}`);
  await expect(page.getByText(/^Approved · /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve week" })).toHaveCount(0);
  await page.getByRole("button", { name: "Reopen week" }).click();
  const dialog = page.getByRole("dialog", { name: "Reopen week" });
  await dialog.getByRole("button", { name: "Reopen week" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Give a reason");
  await dialog.getByLabel("Reason").fill(reason);
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Reopen week" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit week" })).toBeVisible();
  await expectNoA11yViolations(page);
});
