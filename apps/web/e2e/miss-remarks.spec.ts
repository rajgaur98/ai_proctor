// #252 (CHK-23): the employee explains a past miss on My data with a quick pick and a
// typed remark; her manager reads both on the day view and on the timesheet.
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { agentFor } from "./agent";
import {
  ERIN,
  ERIN_EMAIL,
  ERIN_ZONE,
  expectNoA11yViolations,
  MANAGER_EMAIL,
  reopenApprovedWeeks,
  timeAt,
} from "./helpers";

// Times are read in the viewer's zone; make it Erin's, so the day and the row's time agree.
test.use({ timezoneId: ERIN_ZONE });

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

test("an employee adds a remark to a past miss and her manager reads it", async ({ page }) => {
  // Yesterday, at a second no other run used, so the spec finds its own row.
  const yesterday = DateTime.now().setZone(ERIN_ZONE).minus({ days: 1 });
  const date = yesterday.toISODate() ?? "";
  const missAt =
    yesterday
      .set({
        hour: 10,
        minute: Math.floor(Math.random() * 60),
        second: Math.floor(Math.random() * 60),
        millisecond: 0,
      })
      .toUTC()
      .toISO({ suppressMilliseconds: false }) ?? "";
  const remark = `Fire drill ${Date.now()}`;

  // An approved week locks the reason; open whatever earlier specs approved.
  await reopenApprovedWeeks(ERIN);
  // The server takes a check-in only while she's clocked in; it may be backdated.
  const erin = await agentFor(ERIN_EMAIL);
  await erin("clock_out", { reason: "manual" });
  await erin("clock_in", { reason: "manual" });
  await erin("checkin", {
    scheduled_at: missAt,
    shown_at: missAt,
    outcome: "miss",
    wrong_clicks: 0,
    idle_s_at_show: 60,
    device_state: "active",
    object_keys: [],
    flags: [],
  });
  await erin("clock_out", { reason: "manual" });

  // Erin, on My data for yesterday: no reason yet, so "Add a reason".
  await signIn(page, ERIN_EMAIL, /\/me$/);
  await page.goto(`/me?date=${date}`);
  const misses = page.getByRole("region", { name: "Missed check-ins" });
  const miss = misses.getByRole("listitem").filter({ has: page.locator(timeAt(missAt)) });
  await expect(miss.getByText("No reason yet")).toBeVisible();
  await miss.getByRole("button", { name: /^Add a reason for the / }).click();

  // "Other" needs a remark; the counter follows what she types.
  const dialog = page.getByRole("dialog", { name: /^Reason for the / });
  await dialog.getByRole("button", { name: "Other" }).click();
  await expect(dialog.getByLabel("Remark (needed for Other)")).toBeVisible();
  await dialog.getByRole("button", { name: "Save reason" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Add a remark for Other.");
  await dialog.getByLabel("Remark (needed for Other)").fill(remark);
  await expect(dialog.getByText(`${remark.length} / 500`)).toBeVisible();
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Save reason" }).click();
  await expect(dialog).toBeHidden();
  await expect(miss.getByText("Reason: Other")).toBeVisible();
  await expect(miss.getByText(`Remark: “${remark}”`)).toBeVisible();

  // She changes it: the dialog opens with what she saved.
  await miss.getByRole("button", { name: /^Edit the reason for the / }).click();
  await expect(dialog.getByRole("button", { name: "Other" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(dialog.getByLabel(/^Remark/)).toHaveValue(remark);
  await dialog.getByRole("button", { name: "Meeting" }).click();
  await expect(dialog.getByLabel("Remark (optional)")).toBeVisible();
  await dialog.getByRole("button", { name: "Save reason" }).click();
  await expect(dialog).toBeHidden();
  await expect(miss.getByText("Reason: Meeting")).toBeVisible();
  await expect(miss.getByText(`Remark: “${remark}”`)).toBeVisible();
  await expectNoA11yViolations(page);

  // Her manager reads the quick pick and the remark on her day view…
  await page.getByLabel("Account menu for Erin Employee").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto(`/team/${ERIN}?date=${date}`);
  const list = page.getByRole("region", { name: "Check-ins" });
  const row = list.getByRole("button").filter({ has: page.locator(timeAt(missAt)) });
  await expect(row).toContainText(`Meeting: “${remark}”`);
  await row.click();
  const details = page.getByRole("region", { name: /^Missed check-in · / });
  await expect(details).toContainText("Employee's reason · Meeting");
  await expect(details).toContainText(`“${remark}”`);
  await expect(details.getByRole("button", { name: /reason for the/ })).toHaveCount(0);
  await expectNoA11yViolations(page);

  // …and next to the week's flagged time on the timesheet.
  // The seed org's weeks start on Monday.
  await page.goto(`/timesheets/${ERIN}?week=${yesterday.startOf("week").toISODate()}`);
  const flagged = page.getByRole("region", { name: "Flagged segments" });
  await expect(flagged).toContainText(`Meeting: “${remark}”`, { timeout: 20_000 });
  await expectNoA11yViolations(page);
});
