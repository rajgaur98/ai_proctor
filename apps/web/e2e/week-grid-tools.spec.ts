// #264 (TS-34): the week grid's shortcuts. Erin pins a row and finds it on another week,
// then unpins it; adds time with quick add (a start and end, like any request); and copies
// last week: its rows alone, then with its hours, where one entry is skipped because it
// overlaps one already there. Order-independent: the weeks are ones nobody has touched,
// picked per run, and the pins are cleared before and after.
import { weekOf } from "@ai-proctor/core";
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import {
  clearErinFavourites,
  ERIN,
  ERIN_EMAIL,
  ERIN_ZONE,
  expectNoA11yViolations,
  MANAGER_EMAIL,
  pressUntilFocused,
  weekDays,
} from "./helpers";

const REVAMP = "00000000-0000-4000-8000-0000000000f1";
const INTERNAL = "00000000-0000-4000-8000-0000000000f2";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/**
 * Two past weeks of Erin's in a row that nobody has touched (no segments, manual entries
 * or timesheets); returns the later one. The local database keeps every earlier run, so
 * they are picked per run.
 */
async function freshWeekPair(): Promise<string> {
  const manager = await clientFor(MANAGER_EMAIL);
  for (let i = 0; i < 80; i++) {
    const day =
      DateTime.now()
        .setZone(ERIN_ZONE)
        .minus({ days: 400 + ((Date.now() + i * 23) % 900) })
        .toISODate() ?? "";
    const week = weekOf(day, "monday");
    const first = DateTime.fromISO(week).minus({ days: 7 }).toISODate() ?? week;
    const last = weekDays(week).at(-1) ?? week;
    const [segments, entries, sheets] = await Promise.all([
      manager
        .from("time_segments")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ERIN)
        .gte("day", first)
        .lte("day", last),
      manager
        .from("manual_entries")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ERIN)
        .gte("start_at", DateTime.fromISO(first, { zone: ERIN_ZONE }).minus({ days: 1 }).toISO())
        .lte("start_at", DateTime.fromISO(last, { zone: ERIN_ZONE }).plus({ days: 2 }).toISO()),
      manager
        .from("timesheets")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ERIN)
        .gte("period_start", first)
        .lte("period_start", week),
    ]);
    for (const r of [segments, entries, sheets]) if (r.error) throw r.error;
    if (segments.count === 0 && entries.count === 0 && sheets.count === 0) return week;
  }
  throw new Error("no fresh pair of weeks found for Erin");
}

const dayName = (d: string) => DateTime.fromISO(d, { zone: "utc" }).toFormat("ccc d LLL");

async function openGrid(page: Page, week: string) {
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  const grid = page.getByRole("grid", { name: "Week grid" });
  await expect(grid).toBeVisible();
  return grid;
}

test.beforeEach(clearErinFavourites);
test.afterEach(clearErinFavourites);

test("week grid: Erin pins a row to every week, unpins it, and quick-adds time", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const week = await freshWeekPair();
  const lastWeek = DateTime.fromISO(week).minus({ days: 7 }).toISODate() ?? week;
  const days = weekDays(week);
  const reason = `Quick add ${Date.now()}`;

  await signIn(page, ERIN_EMAIL, /\/me$/);
  let grid = await openGrid(page, week);
  const rowheaders = () => grid.locator("tbody").getByRole("rowheader");
  await expect(rowheaders()).toHaveText(["Unassigned"]);
  // Unassigned is always a row: nothing to pin.
  await expect(grid.getByRole("button", { name: /^Pin / })).toHaveCount(0);

  // Pin a row from its header.
  await page.getByRole("button", { name: "Add a row" }).click();
  const addRow = page.getByRole("dialog", { name: "Add a row" });
  await addRow.getByLabel("Project").selectOption(REVAMP);
  await addRow.getByRole("button", { name: "Add row" }).click();
  const pin = grid.getByRole("button", { name: "Pin Website revamp" });
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(grid.getByRole("rowheader", { name: "Website revamp" })).toBeVisible();
  await expectNoA11yViolations(page);

  // It's a row of every week, and stays one after a reload: it's kept server-side.
  grid = await openGrid(page, lastWeek);
  await expect(rowheaders()).toHaveText(["Website revamp", "Unassigned"]);
  await page.reload();
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await expect(rowheaders()).toHaveText(["Website revamp", "Unassigned"]);

  // Unpinned, it's gone from a week it has no time in.
  await grid.getByRole("button", { name: "Pin Website revamp" }).click();
  await expect(rowheaders()).toHaveText(["Unassigned"]);

  // Quick add: a day, a start and an end, a project, a reason and a note.
  grid = await openGrid(page, week);
  await page.getByRole("button", { name: "Quick add" }).click();
  const quick = page.getByRole("region", { name: "Quick add" });
  await expect(page.getByRole("button", { name: "Quick add" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await quick.getByLabel("Day").selectOption(days[1] ?? week);
  await quick.getByLabel("Start").fill("09:00");
  await quick.getByLabel("End").fill("10:30");
  await quick.getByLabel("Project").selectOption(INTERNAL);
  await quick.getByLabel("Reason").fill(reason);
  await quick.getByLabel("Work done (optional)").fill("Planning notes");
  await expectNoA11yViolations(page);
  await quick.getByRole("button", { name: "Add time" }).click();
  await expect(quick.getByRole("status")).toHaveText(
    `Asked for 09:00–10:30 on ${dayName(days[1] ?? week)}.`,
  );
  // It's a request like any other: pending, with its note, in the row's cell.
  await expect(
    grid.getByRole("gridcell", { name: new RegExp(`^Internal, ${dayName(days[1] ?? week)}:`) }),
  ).toHaveAccessibleName(
    `Internal, ${dayName(days[1] ?? week)}: 0 min tracked, 0 min manual, 1 h 30 min pending`,
  );
  const erin = await clientFor(ERIN_EMAIL);
  const entry = await erin
    .from("manual_entries")
    .select("start_at, end_at, project_id, note, status")
    .eq("reason", reason)
    .single();
  if (entry.error) throw entry.error;
  expect(entry.data).toMatchObject({
    project_id: INTERNAL,
    note: "Planning notes",
    status: "pending",
  });
  expect(
    DateTime.fromISO(entry.data.start_at, { zone: ERIN_ZONE }).toFormat("yyyy-MM-dd HH:mm"),
  ).toBe(`${days[1]} 09:00`);

  // A bad one is refused before it's sent.
  await quick.getByLabel("Start").fill("12:00");
  await quick.getByLabel("End").fill("11:00");
  await quick.getByLabel("Reason").fill("Backwards");
  await quick.getByRole("button", { name: "Add time" }).click();
  await expect(quick.getByRole("alert")).toHaveText("The end must be after the start");
});

test("week grid: Erin copies last week's rows, then its hours, one skipped", async ({ page }) => {
  test.setTimeout(120_000);
  const week = await freshWeekPair();
  const lastWeek = DateTime.fromISO(week).minus({ days: 7 }).toISODate() ?? week;
  const last = weekDays(lastWeek);
  const days = weekDays(week);
  const at = (d: string | undefined, t: string) =>
    DateTime.fromISO(`${d}T${t}`, { zone: ERIN_ZONE }).toISO() ?? "";

  // Last week: a workshop on Monday (Website revamp) and an hour on Tuesday (Internal).
  // This week already has Tuesday 09:30-10:30, which the Tuesday copy would overlap.
  const erin = await clientFor(ERIN_EMAIL);
  for (const [start, end, project, reason] of [
    [at(last[0], "10:00"), at(last[0], "12:00"), REVAMP, "Client workshop"],
    [at(last[1], "09:00"), at(last[1], "10:00"), INTERNAL, "Planning"],
    [at(days[1], "09:30"), at(days[1], "10:30"), null, "Already there"],
  ] as const) {
    const r = await erin.rpc("request_manual_entry", {
      p_start_at: start,
      p_end_at: end,
      p_project_id: project as string,
      p_reason: reason,
    });
    if (r.error) throw r.error;
  }
  const thisWeekEntries = async () => {
    const r = await erin
      .from("manual_entries")
      .select("reason, start_at, status")
      .eq("user_id", ERIN)
      .gte("start_at", at(days[0], "00:00"))
      .lt("start_at", at(days[6], "23:59"))
      .order("start_at");
    if (r.error) throw r.error;
    return r.data;
  };

  await signIn(page, ERIN_EMAIL, /\/me$/);
  const grid = await openGrid(page, week);
  const rowheaders = grid.locator("tbody").getByRole("rowheader");
  await expect(rowheaders).toHaveText(["Unassigned"]);

  // By default only the rows: empty, no time copied.
  await page.getByRole("button", { name: "Copy last week" }).click();
  const dialog = page.getByRole("dialog", { name: "Copy last week" });
  await expect(dialog.getByRole("listitem")).toHaveText(["Website revamp", "Internal"]);
  await expect(dialog.getByLabel("Include hours")).not.toBeChecked();
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Added 2 rows: Website revamp, Internal.");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expect(rowheaders).toHaveText(["Internal", "Website revamp", "Unassigned"]);
  expect(await thisWeekEntries()).toHaveLength(1);

  // With hours: each entry is asked for again on the same day and time; the Tuesday one
  // overlaps the entry already there and is skipped, with its reason.
  await page.getByRole("button", { name: "Copy last week" }).click();
  await dialog.getByLabel("Include hours").check();
  const toCopy = dialog.getByRole("list", { name: "Entries to copy" }).getByRole("listitem");
  await expect(toCopy).toHaveCount(2);
  await expect(toCopy.first()).toContainText(dayName(days[0] ?? week));
  await expect(toCopy.first()).toContainText("Website revamp");
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  const status = dialog.getByRole("status");
  await expect(status).toContainText("Copied 1 of 2 manual entries; 1 skipped.");
  const copied = status.getByRole("list", { name: "Copied entries" }).getByRole("listitem");
  await expect(copied.nth(0)).toContainText("Website revamp");
  await expect(copied.nth(0)).toContainText("Copied");
  await expect(copied.nth(1)).toContainText("Internal");
  await expect(copied.nth(1)).toContainText("Skipped: It overlaps another manual entry.");
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Done" }).click();

  // The copy is a new request, pending, in Monday's Website revamp cell.
  await expect(
    grid.getByRole("gridcell", {
      name: new RegExp(`^Website revamp, ${dayName(days[0] ?? week)}:`),
    }),
  ).toHaveAccessibleName(
    `Website revamp, ${dayName(days[0] ?? week)}: 0 min tracked, 0 min manual, 2 h 00 min pending`,
  );
  const after = await thisWeekEntries();
  expect(after.map((e) => [e.reason, e.status])).toEqual([
    ["Client workshop", "pending"],
    ["Already there", "pending"],
  ]);
  expect(
    DateTime.fromISO(after[0]?.start_at ?? "", { zone: ERIN_ZONE }).toFormat("yyyy-MM-dd HH:mm"),
  ).toBe(`${days[0]} 10:00`);
});

// #267: quick add and copy last week with only the keyboard, axe with each open.
test("week grid: Erin quick-adds time and copies last week with only the keyboard", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const week = await freshWeekPair();
  const lastWeek = DateTime.fromISO(week).minus({ days: 7 }).toISODate() ?? week;
  const days = weekDays(week);
  const reason = `Keyboard quick add ${Date.now()}`;
  const erin = await clientFor(ERIN_EMAIL);
  const lastMonday = DateTime.fromISO(`${lastWeek}T10:00`, { zone: ERIN_ZONE });
  const r = await erin.rpc("request_manual_entry", {
    p_start_at: lastMonday.toISO() ?? "",
    p_end_at: lastMonday.plus({ hours: 1 }).toISO() ?? "",
    p_project_id: REVAMP,
    p_reason: "Standup",
  });
  if (r.error) throw r.error;

  await signIn(page, ERIN_EMAIL, /\/me$/);
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  const gridView = page.getByRole("button", { name: "Grid", exact: true });
  await pressUntilFocused(page, gridView, "Tab", 120);
  await page.keyboard.press("Enter");
  const grid = page.getByRole("grid", { name: "Week grid" });
  await expect(grid).toBeVisible();

  // Quick add: Enter opens the form, typed fields, the day and project by their names.
  const quickAdd = page.getByRole("button", { name: "Quick add" });
  await pressUntilFocused(page, quickAdd);
  await page.keyboard.press("Enter");
  await expect(quickAdd).toHaveAttribute("aria-expanded", "true");
  const quick = page.getByRole("region", { name: "Quick add" });
  await pressUntilFocused(page, quick.getByLabel("Day"));
  await page.keyboard.type(dayName(days[1] ?? week));
  await expect(quick.getByLabel("Day")).toHaveValue(days[1] ?? week);
  await pressUntilFocused(page, quick.getByLabel("Start"));
  await page.keyboard.type("0900");
  await pressUntilFocused(page, quick.getByLabel("End"));
  await page.keyboard.type("1030");
  await pressUntilFocused(page, quick.getByLabel("Project"));
  await page.keyboard.type("Internal");
  await expect(quick.getByLabel("Project")).toHaveValue(INTERNAL);
  await pressUntilFocused(page, quick.getByLabel("Reason"));
  await page.keyboard.type(reason);
  await expectNoA11yViolations(page);
  // Enter in a field sends it.
  await page.keyboard.press("Enter");
  await expect(quick.getByRole("status")).toHaveText(
    `Asked for 09:00–10:30 on ${dayName(days[1] ?? week)}.`,
  );
  await expect(
    grid.getByRole("gridcell", { name: new RegExp(`^Internal, ${dayName(days[1] ?? week)}:`) }),
  ).toHaveAccessibleName(
    `Internal, ${dayName(days[1] ?? week)}: 0 min tracked, 0 min manual, 1 h 30 min pending`,
  );
  // The focus stays in the form, ready for the next one.
  await expect(quick.getByLabel("Reason")).toBeFocused();
  await expectNoA11yViolations(page);

  // The next one sent from Add time: it's disabled while sending, and the focus comes back.
  // Back to Day, then forward into Start: Shift+Tab into a time field lands on its minutes.
  await pressUntilFocused(page, quick.getByLabel("Day"), "Shift+Tab");
  await pressUntilFocused(page, quick.getByLabel("Start"));
  await page.keyboard.type("1100");
  await pressUntilFocused(page, quick.getByLabel("End"));
  await page.keyboard.type("1200");
  await pressUntilFocused(page, quick.getByLabel("Reason"));
  await page.keyboard.type(`${reason} again`);
  const addTime = quick.getByRole("button", { name: "Add time" });
  await pressUntilFocused(page, addTime);
  await page.keyboard.press("Enter");
  await expect(quick.getByRole("status")).toHaveText(
    `Asked for 11:00–12:00 on ${dayName(days[1] ?? week)}.`,
  );
  await expect(addTime).toBeFocused();

  // Copy last week, with its hours: Space ticks the box, Enter copies, Done closes, and the
  // focus is back on the button that opened it.
  const copyButton = page.getByRole("button", { name: "Copy last week" });
  await pressUntilFocused(page, copyButton, "Shift+Tab");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Copy last week" });
  await pressUntilFocused(page, dialog.getByLabel("Include hours"));
  await page.keyboard.press("Space");
  await expect(dialog.getByLabel("Include hours")).toBeChecked();
  await expect(
    dialog.getByRole("list", { name: "Entries to copy" }).getByRole("listitem"),
  ).toHaveCount(1);
  await expectNoA11yViolations(page);
  await pressUntilFocused(page, dialog.getByRole("button", { name: "Copy", exact: true }));
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("status")).toContainText("Copied 1 of 1 manual entry.");
  // The summary replaces the form, Copy with it: the focus moves to Done, not lost.
  const done = dialog.getByRole("button", { name: "Done" });
  await expect(done).toBeFocused();
  await expectNoA11yViolations(page);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(copyButton).toBeFocused();
  await expect(
    grid.getByRole("gridcell", {
      name: new RegExp(`^Website revamp, ${dayName(days[0] ?? week)}:`),
    }),
  ).toHaveAccessibleName(
    `Website revamp, ${dayName(days[0] ?? week)}: 0 min tracked, 0 min manual, 1 h 00 min pending`,
  );
});
