// #262 (TS-32): the week as a project/task grid. Erin adds a row, moves to a cell with the
// arrow keys, adds manual time there with a start and end, and edits it; once it's
// approved the row, day and week totals count it; once she submits the week the grid is
// read-only. Order-independent: the week is one nobody has touched, picked per run.
import { weekOf } from "@ai-proctor/core";
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import {
  ERIN,
  ERIN_EMAIL,
  ERIN_ZONE,
  expectNoA11yViolations,
  MANAGER_EMAIL,
  rebuildSegments,
  weekDays,
} from "./helpers";

const REVAMP = "00000000-0000-4000-8000-0000000000f1";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/**
 * A past week of Erin's nobody has touched: no segments, no manual entries and no
 * timesheet. The local database keeps every earlier run, so it is picked per run.
 */
async function freshWeek(): Promise<string> {
  const manager = await clientFor(MANAGER_EMAIL);
  for (let i = 0; i < 80; i++) {
    const day =
      DateTime.now()
        .setZone(ERIN_ZONE)
        .minus({ days: 400 + ((Date.now() + i * 17) % 900) })
        .toISODate() ?? "";
    const week = weekOf(day, "monday");
    const last = weekDays(week).at(-1) ?? week;
    const [segments, entries, sheets] = await Promise.all([
      manager
        .from("time_segments")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ERIN)
        .gte("day", week)
        .lte("day", last),
      manager
        .from("manual_entries")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ERIN)
        .gte("start_at", DateTime.fromISO(week, { zone: ERIN_ZONE }).minus({ days: 1 }).toISO())
        .lte("start_at", DateTime.fromISO(last, { zone: ERIN_ZONE }).plus({ days: 2 }).toISO()),
      manager
        .from("timesheets")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ERIN)
        .eq("period_start", week),
    ]);
    for (const r of [segments, entries, sheets]) if (r.error) throw r.error;
    if (segments.count === 0 && entries.count === 0 && sheets.count === 0) return week;
  }
  throw new Error("no fresh week found for Erin");
}

/** "13:00" as the page shows it: in the viewer's zone (the browser's, this machine's). */
const hm = (t: DateTime) => t.toLocal().toFormat("HH:mm");
const dayName = (d: string) => DateTime.fromISO(d, { zone: "utc" }).toFormat("ccc d LLL");

test("week grid: Erin adds time from a cell, the totals count it, and it locks", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const reason = `Whiteboard session ${Date.now()}`;
  const week = await freshWeek();
  const days = weekDays(week);
  const day = days[2] ?? week;
  const label = dayName(day);
  const start = DateTime.fromISO(`${day}T13:00`, { zone: ERIN_ZONE });

  await signIn(page, ERIN_EMAIL, /\/me$/);
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  const grid = page.getByRole("grid", { name: "Week grid" });
  await expect(grid).toBeVisible();
  // Unassigned is always a row; nothing else yet.
  await expect(grid.locator("tbody").getByRole("rowheader")).toHaveText(["Unassigned"]);
  await expectNoA11yViolations(page);

  // Add a row: it has no time yet, and the focus lands on its first cell.
  await page.getByRole("button", { name: "Add a row" }).click();
  const addRow = page.getByRole("dialog", { name: "Add a row" });
  await addRow.getByLabel("Project").selectOption(REVAMP);
  await expectNoA11yViolations(page);
  await addRow.getByRole("button", { name: "Add row" }).click();
  await expect(addRow).toBeHidden();
  await expect(grid.locator("tbody").getByRole("rowheader")).toHaveText([
    "Website revamp",
    "Unassigned",
  ]);
  const cell = (row: string, d: string) =>
    grid.getByRole("gridcell", { name: new RegExp(`^${row}, ${dayName(d)}:`) });
  await expect(cell("Website revamp", days[0] ?? week)).toBeFocused();

  // The arrow keys move between cells, and stop at the grid's edges.
  await page.keyboard.press("ArrowLeft");
  await expect(cell("Website revamp", days[0] ?? week)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(cell("Website revamp", day)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(cell("Unassigned", day)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(cell("Website revamp", day)).toBeFocused();
  await expect(cell("Website revamp", day)).toHaveAttribute("tabindex", "0");
  await expect(cell("Website revamp", days[0] ?? week)).toHaveAttribute("tabindex", "-1");

  // Enter opens the cell; Add entry asks for time with a start and end, prefilled with
  // the cell's day and project.
  await page.keyboard.press("Enter");
  const cellDialog = page.getByRole("dialog", { name: `Website revamp · ${label}` });
  await expect(cellDialog).toBeVisible();
  await expect(cellDialog).toContainText("No manual entries.");
  await cellDialog.getByRole("button", { name: "Add entry" }).click();
  const request = page.getByRole("dialog", { name: "Request manual time" });
  await expect(request.getByLabel("Date")).toHaveValue(day);
  await expect(request.getByLabel("Project")).toHaveValue(REVAMP);
  await request.getByLabel("Start").fill("13:00");
  await request.getByLabel("End").fill("15:00");
  await request.getByLabel("Reason").fill(reason);
  await expectNoA11yViolations(page);
  await request.getByRole("button", { name: "Send request" }).click();
  await expect(request).toBeHidden();

  // It's in the cell, pending: shown, not counted.
  await expect(cellDialog.getByRole("listitem")).toContainText("Pending, not counted");
  await expect(cellDialog.getByRole("listitem")).toContainText("2 h 00 min");
  await expectNoA11yViolations(page);

  // Edit it from the cell: a later end.
  await cellDialog
    .getByRole("button", { name: `Edit ${hm(start)}–${hm(start.plus({ hours: 2 }))}` })
    .click();
  const edit = page.getByRole("dialog", { name: "Edit entry" });
  await edit.getByLabel("End").fill("15:30");
  await edit.getByRole("button", { name: "Save entry" }).click();
  await expect(edit).toBeHidden();
  await expect(cellDialog.getByRole("listitem")).toContainText("2 h 30 min");

  // Escape closes the cell and gives the focus back to it.
  await page.keyboard.press("Escape");
  await expect(cellDialog).toBeHidden();
  await expect(cell("Website revamp", day)).toBeFocused();
  await expect(cell("Website revamp", day)).toHaveAccessibleName(
    `Website revamp, ${label}: 0 min tracked, 0 min manual, 2 h 30 min pending`,
  );
  await expect(grid.getByRole("gridcell", { name: "Website revamp, week:" })).toHaveAccessibleName(
    "Website revamp, week: 0 min, 2 h 30 min pending",
  );

  // The manager approves it: the cell's manual time, and the row, day and week totals,
  // count it.
  const erin = await clientFor(ERIN_EMAIL);
  const entry = await erin
    .from("manual_entries")
    .select("id")
    .eq("user_id", ERIN)
    .eq("reason", reason)
    .single();
  if (entry.error) throw entry.error;
  const manager = await clientFor(MANAGER_EMAIL);
  const decided = await manager.rpc("decide_manual_entry", {
    p_id: entry.data.id,
    p_approve: true,
    p_note: "",
  });
  if (decided.error) throw decided.error;
  await rebuildSegments(ERIN, [day]);
  await page.reload();
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(cell("Website revamp", day)).toHaveAccessibleName(
    `Website revamp, ${label}: 0 min tracked, 2 h 30 min manual`,
  );
  await expect(cell("Website revamp", day)).toContainText("2 h 30 min manual");
  await expect(grid.getByRole("gridcell", { name: "Website revamp, week:" })).toHaveAccessibleName(
    "Website revamp, week: 2 h 30 min",
  );
  await expect(grid.getByRole("gridcell", { name: new RegExp(`^${label}:`) })).toHaveAccessibleName(
    `${label}: 2 h 30 min`,
  );
  await expect(grid.getByRole("gridcell", { name: /^Week:/ })).toHaveAccessibleName(
    "Week: 2 h 30 min",
  );

  // Erin submits the week: the grid is read-only. Cells still open, without changes.
  const ensured = await erin.rpc("ensure_timesheet", { p_user_id: ERIN, p_period_start: week });
  if (ensured.error) throw ensured.error;
  const submitted = await erin.rpc("submit_timesheet", { p_id: ensured.data });
  if (submitted.error) throw submitted.error;
  await page.reload();
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(cell("Website revamp", day)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a row" })).toHaveCount(0);
  await cell("Website revamp", day).click();
  await expect(cellDialog).toBeVisible();
  await expect(cellDialog.getByRole("listitem")).toContainText("Approved");
  await expect(cellDialog.getByRole("button", { name: "Add entry" })).toHaveCount(0);
  await expect(cellDialog.getByRole("button", { name: /^Edit / })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await page.keyboard.press("Escape");
  await expect(cellDialog).toBeHidden();
});
