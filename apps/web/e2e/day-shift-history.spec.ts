import { expect, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import { ERIN, ERIN_ZONE, expectNoA11yViolations, MANAGER_EMAIL } from "./helpers";

// #344 (SHF-01): the day page draws a past day with the shift that applied that day. Max
// moves Erin from her weekday 09:00–17:00 to 13:00–15:00 every day, today; today shows the
// new shift and her last weekday before today still shows the old one.
test.use({ timezoneId: ERIN_ZONE });

const today = DateTime.now().setZone(ERIN_ZONE).startOf("day");
// Her last weekday before today (the seed's shift runs Monday to Friday).
let past = today.minus({ days: 1 });
while (past.weekday > 5) past = past.minus({ days: 1 });

// Back to the seed's shift, so the specs after this one see it today.
test.afterEach(async () => {
  const manager = await clientFor(MANAGER_EMAIL);
  const { error } = await manager.rpc("set_shifts", {
    p_user_id: ERIN,
    p_shifts: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", timezone: ERIN_ZONE }],
  });
  if (error) throw error;
});

test("editing a shift today leaves earlier days showing the shift they had", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(MANAGER_EMAIL);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });

  await page.goto(`/team/${ERIN}`);
  await expect(page.getByRole("heading", { name: "Erin Employee" })).toBeVisible();
  await page.getByRole("button", { name: "Schedule" }).click();
  const dialog = page.getByRole("dialog", { name: "Erin Employee's schedule" });
  for (const remove of await dialog.getByRole("button", { name: /^Remove shift/ }).all()) {
    await remove.click();
  }
  await dialog.getByRole("button", { name: "Add shift" }).click();
  await dialog.getByText("Sat", { exact: true }).click();
  await dialog.getByText("Sun", { exact: true }).click();
  await dialog.getByLabel("Shift 1 start").fill("13:00");
  await dialog.getByLabel("Shift 1 end").fill("15:00");
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  await expect(dialog.getByRole("button", { name: "Schedule saved" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  // Today: the new shift.
  await expect(page.getByText(/Shift 13:00–15:00 \(/)).toBeVisible();

  // Her last weekday: the shift that applied then.
  await page.goto(`/team/${ERIN}?date=${past.toISODate()}`);
  await expect(page.getByRole("heading", { name: "Erin Employee" })).toBeVisible();
  await expect(page.getByText(/Shift 09:00–17:00 \(/)).toBeVisible();
  await expect(page.getByText(/Shift 13:00–15:00/)).toHaveCount(0);
  await expectNoA11yViolations(page);
});
