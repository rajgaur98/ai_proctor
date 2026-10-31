import { expect, test } from "@playwright/test";
import { agentFor, asEmployee } from "./agent";
import { ERIN, expectNoA11yViolations, reopenApprovedWeeks, timeAt } from "./helpers";

test("a manager opens an employee's day and reads a missed and a deferred check-in", async ({
  page,
}) => {
  const erin = await agentFor("erin@acme.test");
  await erin("clock_out", { reason: "manual" });
  await erin("clock_in", { reason: "manual" });
  const now = Date.now();
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  const missId = crypto.randomUUID();
  await erin(
    "checkin",
    {
      scheduled_at: ago(30),
      shown_at: ago(29),
      outcome: "miss",
      wrong_clicks: 0,
      idle_s_at_show: 420,
      device_state: "active",
      object_keys: [],
      flags: [],
    },
    missId,
  );
  // CHK-23: she explains it (the tray does this with #37), which an approved week refuses.
  await reopenApprovedWeeks(ERIN);
  await asEmployee("erin@acme.test", (db) =>
    db.rpc("set_miss_reason", { p_checkin_id: missId, p_kind: "meeting", p_note: "Client call" }),
  );
  // Due while sharing the screen: held back, nothing shown or captured (CHK-03).
  await erin("checkin", {
    scheduled_at: ago(20),
    outcome: "deferred",
    deferral_reason: "screen_share",
    wrong_clicks: 0,
    object_keys: [],
    flags: [],
  });
  await erin("checkin", {
    scheduled_at: ago(10),
    shown_at: ago(9),
    responded_at: ago(5),
    outcome: "pass",
    response_ms: 4200,
    wrong_clicks: 1,
    object_keys: [],
    flags: [],
  });

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("manager@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  await page.getByRole("link", { name: "View day for Erin Employee" }).click();

  await expect(page.getByRole("heading", { name: "Erin Employee" })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Time over the day: / })).toBeVisible();
  // Markers this close overlap on the bar; the list below reaches each one.
  await expect(page.getByRole("button", { name: /^Missed check-in at / }).last()).toBeVisible();
  const list = page.getByRole("region", { name: "Check-ins" });
  // Other specs add check-ins on today: pick this spec's rows by the time each was shown.
  const row = (iso: string) => list.getByRole("button").filter({ has: page.locator(timeAt(iso)) });
  await row(ago(29)).filter({ hasText: "Missed" }).click();
  const details = page.getByRole("region", { name: /^Missed check-in · / });
  await expect(details).toContainText("Idle before check-in");
  await expect(details).toContainText("7 min");
  await expect(details).toContainText("Meeting");
  await expect(details).toContainText("“Client call”");
  await expect(details).toContainText("Review in timesheet");

  // A deferral has its own marker and row, with the reason, and is not a miss.
  await expect(
    page.getByRole("button", { name: /^Deferred check-in at \d\d:\d\d \(screen shared\)$/ }).last(),
  ).toBeVisible();
  await row(ago(20)).filter({ hasText: "Screen shared" }).click();
  const deferred = page.getByRole("region", { name: /^Deferred check-in · / });
  await expect(deferred).toContainText("Reason");
  await expect(deferred).toContainText("Screen shared");
  await expect(deferred).toContainText("not counted as missed");

  await row(ago(9)).filter({ hasText: "in 4 s" }).click();
  const passed = page.getByRole("region", { name: /^Check-in · / });
  await expect(passed).toContainText("Passed · 4.2 s");
  await expect(passed).toContainText("Answered in");

  await expectNoA11yViolations(page);

  // Max manages Erin, so he can set her schedule from here.
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByRole("dialog", { name: "Erin Employee's schedule" })).toBeVisible();

  // Past days work too.
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Previous day" }).click();
  await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}/);
  await expect(page.getByRole("button", { name: "Next day" })).toBeEnabled();

  await erin("clock_out", { reason: "manual" });
});
