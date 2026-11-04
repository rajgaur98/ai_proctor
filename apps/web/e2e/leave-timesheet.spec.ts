// Time off part 2 (#319): a holiday that applies to Erin shows as Leave on her week (LV-05),
// apart from worked time, in the header, the day table, the totals, the day list and the
// grid's Leave row; and the Time off list's filters (LV-06). #327: the Totals and Days
// exports carry it in their own Leave columns, and My data's timesheet card (EMP-02) shows
// it with the same figures. The holiday is on a past week nobody has touched, picked per
// run, for Erin's work location (US / CA), and is removed at the end, so no other spec sees
// it.
import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import {
  ERIN,
  ERIN_EMAIL,
  expectNoA11yViolations,
  freshErinWeek,
  MANAGER_EMAIL,
  weekDays,
} from "./helpers";

const ADMIN_EMAIL = "admin@acme.test";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

const label = (iso: string) => DateTime.fromISO(iso, { zone: "utc" }).toFormat("ccc d LLL");

/** Downloads the panel's export as CSV and returns its lines (without the last, empty one). */
async function exportCsv(page: Page, what: string, scope: Locator): Promise<string[]> {
  await scope.getByRole("button", { name: `Export ${what.toLowerCase()}` }).click();
  const dialog = page.getByRole("dialog", { name: `Export ${what.toLowerCase()}` });
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download CSV" }).click();
  const file = await download;
  const lines = (await readFile((await file.path()) ?? "", "utf8")).split("\r\n");
  expect(lines.at(-1)).toBe("");
  return lines.slice(0, -1);
}

/** A holiday for Erin's work location on `day`, removed after `run`. */
async function withHoliday(day: string, name: string, run: () => Promise<void>) {
  const admin = await clientFor(ADMIN_EMAIL);
  const saved = await admin.rpc("save_holiday", {
    p_id: null as unknown as string,
    p_day: day,
    p_name: name,
    p_country: "US",
    p_state: "CA",
  });
  if (saved.error) throw saved.error;
  try {
    await run();
  } finally {
    // A failure to clean up shows in the log; it mustn't hide the test's own failure.
    const removed = await admin.rpc("delete_holiday", { p_id: saved.data });
    if (removed.error) console.error("couldn't remove the test holiday", removed.error);
  }
}

test("a holiday shows as Leave on Erin's week, apart from her worked time", async ({ page }) => {
  test.setTimeout(90_000);
  const week = await freshErinWeek();
  // Tuesday: Erin's 9-to-5 shift, 8 hours.
  const day = weekDays(week)[1] ?? week;
  const name = `Founders day ${Date.now()}`;

  await withHoliday(day, name, async () => {
    await signIn(page, ERIN_EMAIL, /\/me$/);
    await page.goto(`/timesheets/${ERIN}?week=${week}`);

    // The header: no worked time, 8 hours of leave.
    await expect(page.getByText("8 h 00 min", { exact: true }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("columnheader", { name: "Leave" })).toBeVisible();
    const totals = page.getByRole("region", { name: "Totals" });
    await expect(totals.getByText("Leave", { exact: true })).toBeVisible();
    await expect(totals).toContainText("No worked time.");

    // The day list says it under the day.
    const days = page.getByRole("region", { name: "Days", exact: true });
    const tuesday = days.getByRole("region", { name: label(day) });
    await expect(tuesday).toContainText(`${name} (holiday)`);
    await expect(tuesday).toContainText("8 h 00 min");
    await expectNoA11yViolations(page);

    // #327 (LV-06): both exports carry it in their own Leave columns, not in worked time.
    const totalsCsv = await exportCsv(page, "Totals", totals);
    expect(totalsCsv[0]).toBe(
      "Group,Name,Worked (h),Billable (h),Non-billable (h),Leave (h),Leave (H:MM)",
    );
    expect(totalsCsv[1]).toBe("Total,All worked time,0,0,0,8,8:00");
    const daysCsv = await exportCsv(page, "Days", days);
    expect(daysCsv[0]).toBe(
      "Day,Start,End,Hours,Seconds,Kind,Project,Task,Billable,Note,Leave (h),Leave (H:MM)",
    );
    expect(daysCsv.slice(1)).toEqual([`${day},,,,,Leave,,,No,${name} (holiday),8,8:00`]);

    // The grid's Leave row, under the totals and not in them.
    await page.getByRole("button", { name: "Grid", exact: true }).click();
    const grid = page.getByRole("grid", { name: "Week grid" });
    await expect(
      grid.getByRole("gridcell", { name: `Leave, ${label(day)}: 8 h 00 min, ${name} (holiday)` }),
    ).toBeVisible();
    await expect(grid.getByRole("rowheader", { name: /^Leave/ })).toBeVisible();
    await expectNoA11yViolations(page);
  });
});

test("My data shows Erin's holiday on her week's timesheet card, apart from worked time", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const week = await freshErinWeek();
  // Wednesday: Erin's 9-to-5 shift, 8 hours.
  const day = weekDays(week)[2] ?? week;
  const name = `Harvest day ${Date.now()}`;

  await withHoliday(day, name, async () => {
    await signIn(page, ERIN_EMAIL, /\/me$/);
    await page.goto(`/me?date=${day}`);
    const card = page.getByRole("region", { name: "My timesheet" });
    // The same figures as her timesheet: the day, what it is and its 8 hours.
    const leave = card.getByRole("list", { name: "Leave and holidays" });
    await expect(leave.getByRole("listitem")).toHaveCount(1, { timeout: 20_000 });
    await expect(leave.getByRole("listitem")).toContainText(label(day));
    await expect(leave.getByRole("listitem")).toContainText(`${name} (holiday)`);
    await expect(leave.getByRole("listitem")).toContainText("8 h 00 min");
    await expect(card).toContainText("Not worked time");
    await expectNoA11yViolations(page);

    // Keyboard: from Submit week, Tab reaches the link to all her timesheets.
    const submit = card.getByRole("button", { name: "Submit week" });
    await submit.focus();
    await page.keyboard.press("Tab");
    await expect(card.getByRole("link", { name: "All my timesheets" })).toBeFocused();
  });
});

test("the Time off list filters by person, status and dates", async ({ page }) => {
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Time off" })
    .click();
  await expect(page.getByRole("heading", { name: "Time off", level: 1 })).toBeVisible();
  const filters = page.getByRole("group", { name: "Filter requests" });
  await expect(filters.getByLabel("From")).not.toHaveValue("");
  await expectNoA11yViolations(page);

  // Keyboard: the filters are form fields in order.
  await filters.getByLabel("Person").focus();
  await filters.getByLabel("Person").selectOption({ label: "Lucas Martin" });
  await page.keyboard.press("Tab");
  await expect(filters.getByLabel("Team")).toBeFocused();
  // Someone else picked: their requests only, not Max's own list.
  await expect(page.getByRole("table", { name: "Your time off" })).toHaveCount(0);
  const team = page.getByRole("table", { name: "Your team" });
  const others = page.getByText("No requests match the filters.");
  await expect(team.or(others)).toBeVisible();
  if (await team.isVisible()) {
    await expect(team.getByRole("row").filter({ hasText: "Erin Employee" })).toHaveCount(0);
  }

  // A range that ends before it starts is explained, not sent.
  await filters.getByLabel("To").fill("2020-01-01");
  await expect(filters.getByRole("alert")).toHaveText("The end date is before the start date.");

  await filters.getByRole("button", { name: "Clear filters" }).click();
  await expect(filters.getByLabel("Person")).toHaveValue("");
  await expect(filters.getByLabel("To")).toHaveValue("");
  await expect(filters.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
  await expectNoA11yViolations(page);
});
