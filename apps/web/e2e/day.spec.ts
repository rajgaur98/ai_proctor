import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { agentFor, asEmployee } from "./agent";

test("a manager opens an employee's day and reads a missed and a deferred check-in", async ({
  page,
}) => {
  const erin = await agentFor("erin@acme.test");
  await erin("clock_out", { reason: "manual" });
  await erin("clock_in", { reason: "manual" });
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
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
  // CHK-23: she explains it (the tray does this with #37).
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
  await expect(page.getByRole("img", { name: /Status over the day: Active/ })).toBeVisible();
  // Markers this close overlap on the bar; the list below reaches each one.
  await expect(page.getByRole("button", { name: /^Missed check-in at / }).last()).toBeVisible();
  const list = page.getByRole("list").filter({ hasText: "Missed check-in" });
  // Newest last: earlier runs may have left check-ins on today.
  await list
    .getByRole("button", { name: /Missed check-in/ })
    .last()
    .click();
  const details = page.getByRole("region", { name: "Missed check-in" });
  await expect(details).toContainText("Idle when shown");
  await expect(details).toContainText("7 min");
  await expect(details).toContainText("Meeting: Client call");

  // A deferral has its own marker and row, with the reason, and is not a miss.
  await expect(
    page.getByRole("button", { name: /^Deferred check-in at \d\d:\d\d \(screen shared\)$/ }).last(),
  ).toBeVisible();
  await list
    .getByRole("button", { name: /Deferred check-in/ })
    .filter({ hasText: "Screen shared" })
    .last()
    .click();
  const deferred = page.getByRole("region", { name: "Deferred check-in" });
  await expect(deferred).toContainText("Reason");
  await expect(deferred).toContainText("Screen shared");
  await expect(deferred).toContainText("not counted as missed");

  await list
    .getByRole("button", { name: /Passed check-in/ })
    .filter({ hasText: "in 4 s" })
    .last()
    .click();
  await expect(page.getByRole("region", { name: "Passed check-in" })).toContainText("4.2 s");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

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
