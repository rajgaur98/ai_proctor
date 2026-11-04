// Time off (#304, LV-01..03): Erin asks for days off, her manager approves, she cancels it
// before it starts; an admin keeps the leave types and the holiday calendar. Dates are
// picked per run far ahead (the local database keeps earlier runs), and the holiday is for
// a place nobody works in, so no other spec sees a day off.
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import { ERIN_EMAIL, ERIN_ZONE, expectNoA11yViolations, MANAGER_EMAIL } from "./helpers";

const ADMIN_EMAIL = "admin@acme.test";

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

async function openTimeOff(page: Page) {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Time off" })
    .click();
  await expect(page.getByRole("heading", { name: "Time off", level: 1 })).toBeVisible();
}

/** Cancels Erin's open requests from earlier runs, so the lists stay short. */
async function cancelErinsOpenRequests() {
  const erin = await clientFor(ERIN_EMAIL);
  const { data, error } = await erin.rpc("leave_requests_list");
  if (error) throw error;
  for (const r of (data as { id: string; can_cancel: boolean }[]).filter((x) => x.can_cancel)) {
    const c = await erin.rpc("cancel_leave", { p_request_id: r.id });
    if (c.error) throw c.error;
  }
}

test("Erin asks for time off, her manager approves it and she cancels it before it starts", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await cancelErinsOpenRequests();
  // A Monday to Wednesday 60 to 300 days ahead, picked per run.
  const first = DateTime.now()
    .setZone(ERIN_ZONE)
    .plus({ days: 60 + (Date.now() % 240) })
    .startOf("week");
  const firstDay = first.toISODate() ?? "";
  const lastDay = first.plus({ days: 2 }).toISODate() ?? "";
  const note = `Family trip ${Date.now()}`;
  const when = `${first.toFormat("ccc d LLL")} – ${first.plus({ days: 2 }).toFormat("ccc d LLL yyyy")}`;

  await signIn(page, ERIN_EMAIL, /\/me$/);
  await openTimeOff(page);
  await expectNoA11yViolations(page);

  // Keyboard: the request dialog opens from the button and takes the whole form.
  await page.getByRole("button", { name: "Request time off" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Request time off" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Type").selectOption({ label: "Vacation" });
  await dialog.getByLabel("First day").fill(firstDay);
  await dialog.getByLabel("Last day").fill(lastDay);
  await dialog.getByLabel("Note (optional)").fill(note);
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(dialog).toBeHidden();

  const mine = page.getByRole("table", { name: "Your time off" });
  const row = mine.getByRole("row").filter({ hasText: note });
  await expect(row).toContainText(when);
  await expect(row).toContainText("3 days");
  await expect(row).toContainText("Pending");
  await signOut(page, "Erin Employee");

  // Max decides: the request waits for him, with Erin's name.
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await openTimeOff(page);
  const toDecide = page.getByRole("table", { name: "To decide" });
  await expect(toDecide.getByRole("row").filter({ hasText: note })).toContainText("Erin Employee");
  await expectNoA11yViolations(page);
  await toDecide.getByRole("button", { name: `Approve Erin Employee's Vacation, ${when}` }).click();
  await expect(toDecide.getByRole("row").filter({ hasText: note })).toHaveCount(0);
  const team = page.getByRole("table", { name: "Your team" });
  await expect(team.getByRole("row").filter({ hasText: note })).toContainText("Approved");
  await signOut(page, "Max Manager");

  // Erin was told, and cancels it: it hasn't started.
  await signIn(page, ERIN_EMAIL, /\/me$/);
  await openTimeOff(page);
  await expect(row).toContainText("Approved");
  await expect(row).toContainText("by Max Manager");
  await row.getByRole("button", { name: `Cancel Vacation, ${when}` }).click();
  const confirm = page.getByRole("dialog", { name: "Cancel this request?" });
  await confirm.getByRole("button", { name: "Cancel request" }).click();
  await expect(row).toContainText("Cancelled");

  const erin = await clientFor(ERIN_EMAIL);
  const { data, error } = await erin
    .from("notifications")
    .select("kind")
    .eq("kind", "leave.approved")
    .contains("payload", { first_day: firstDay });
  if (error) throw error;
  expect(data).toHaveLength(1);
});

test("an admin keeps the leave types and the holiday calendar", async ({ page }) => {
  const stamp = Date.now();
  const typeName = `Training ${stamp}`;
  const holidayName = `Founders day ${stamp}`;
  const day =
    DateTime.now()
      .plus({ days: 30 + (stamp % 300) })
      .toISODate() ?? "";

  await signIn(page, ADMIN_EMAIL, /\/team$/);
  await openTimeOff(page);

  // Leave types: the four defaults are there; a new unpaid one is added, then archived.
  await page.getByRole("button", { name: "Leave types" }).click();
  const types = page.getByRole("region", { name: "Leave types" });
  for (const name of ["Vacation", "Sick", "Personal", "Unpaid"]) {
    await expect(types.getByRole("cell", { name, exact: true }).first()).toBeVisible();
  }
  await expectNoA11yViolations(page);
  await types.getByRole("button", { name: "New leave type" }).click();
  const newType = page.getByRole("dialog", { name: "New leave type" });
  await newType.getByLabel("Name").fill(typeName);
  await newType.getByRole("checkbox", { name: "Paid" }).uncheck();
  await newType.getByRole("button", { name: "Save" }).click();
  const typeRow = types.getByRole("row").filter({ hasText: typeName });
  await expect(typeRow).toContainText("Unpaid");
  await typeRow.getByRole("button", { name: `Edit ${typeName}` }).click();
  const editType = page.getByRole("dialog", { name: `Edit ${typeName}` });
  await editType.getByRole("checkbox", { name: /^Archived/ }).check();
  await editType.getByRole("button", { name: "Save" }).click();
  await expect(typeRow).toContainText("Archived");

  // Holidays, by keyboard: open the tab, add one for a place nobody works in, remove it.
  await page.getByRole("button", { name: "Holidays" }).focus();
  await page.keyboard.press("Enter");
  const holidays = page.getByRole("region", { name: "Holidays" });
  await expect(holidays).toBeVisible();
  await holidays.getByRole("button", { name: "Add holiday" }).focus();
  await page.keyboard.press("Enter");
  const add = page.getByRole("dialog", { name: "Add holiday" });
  await add.getByLabel("Date").fill(day);
  await add.getByLabel("Name").fill(holidayName);
  await add.getByLabel("Country (empty: everyone)").fill("zz");
  await expectNoA11yViolations(page);
  await page.keyboard.press("Enter");
  await expect(add).toBeHidden();
  const holidayRow = holidays.getByRole("row").filter({ hasText: holidayName });
  await expect(holidayRow).toContainText("ZZ");
  await expectNoA11yViolations(page);
  await holidayRow.getByRole("button", { name: `Remove ${holidayName}` }).click();
  await expect(holidayRow).toHaveCount(0);

  const admin = await clientFor(ADMIN_EMAIL);
  const { data, error } = await admin
    .from("audit_log")
    .select("action")
    .in("action", ["holiday.added", "holiday.removed"])
    .contains("metadata", { name: holidayName });
  if (error) throw error;
  expect(data.map((r) => r.action).sort()).toEqual(["holiday.added", "holiday.removed"]);
});
