// #263 (#254 part 4, TS-30): the week's day list. Erin splits a manual entry, merges it
// back and duplicates it to another day, then edits the copy, with the keyboard where it
// counts; the split keeps every second. Order-independent: the week is one nobody has
// touched, picked per run.
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
 * A past day in a week of Erin's nobody has touched: no segments, no manual entries and
 * no timesheet. The local database keeps every earlier run, so it is picked per run.
 */
async function freshDay(): Promise<string> {
  const manager = await clientFor(MANAGER_EMAIL);
  for (let i = 0; i < 80; i++) {
    const day =
      DateTime.now()
        .setZone(ERIN_ZONE)
        .minus({ days: 400 + ((Date.now() + i * 13) % 900) })
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
    if (segments.count === 0 && entries.count === 0 && sheets.count === 0) return day;
  }
  throw new Error("no fresh week found for Erin");
}

/** "13:00" as the page shows it: in the viewer's zone (the browser's, this machine's). */
const hm = (t: DateTime) => t.toLocal().toFormat("HH:mm");
const dayName = (d: string) => DateTime.fromISO(d, { zone: "utc" }).toFormat("ccc d LLL");

test("day list: Erin splits an entry, merges it back, duplicates and edits it", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  const reason = `Client workshop ${stamp}`;
  const note = `Checkout flows ${stamp}`;
  const day = await freshDay();
  const week = weekOf(day, "monday");
  const days = weekDays(week);
  const copyDay = days[(days.indexOf(day) + 1) % 7] ?? week;
  const label = dayName(day);
  const copyLabel = dayName(copyDay);

  // Erin asked for two hours of offline time that day (the request dialog is #42's spec).
  const start = DateTime.fromISO(`${day}T13:00`, { zone: ERIN_ZONE });
  const mid = start.plus({ hours: 1 });
  const end = start.plus({ hours: 2 });
  const erin = await clientFor(ERIN_EMAIL);
  const requested = await erin.rpc("request_manual_entry", {
    p_start_at: start.toISO() ?? "",
    p_end_at: end.toISO() ?? "",
    p_project_id: REVAMP,
    p_reason: reason,
    p_note: note,
  });
  if (requested.error) throw requested.error;
  const whole = `${hm(start)}–${hm(end)} on ${label}`;

  await signIn(page, ERIN_EMAIL, /\/me$/);
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  const list = page.getByRole("region", { name: "Days", exact: true });
  const theDay = list.getByRole("region", { name: label, exact: true });
  const item = theDay.getByRole("listitem").filter({ hasText: note });
  await expect(item).toContainText("Website revamp");
  await expect(item).toContainText("Billable");
  await expect(item).toContainText("Manual · pending, not counted");
  await expect(item).toContainText("2 h 00 min");
  await expectNoA11yViolations(page);

  // Split it with the keyboard: the dialog opens on the time (the middle, 14:00) and
  // Enter splits.
  await theDay.getByRole("button", { name: `Split ${whole}` }).focus();
  await page.keyboard.press("Enter");
  const split = page.getByRole("dialog", { name: "Split entry" });
  await expect(split).toBeVisible();
  const at = split.getByLabel("Split at");
  await expect(at).toBeFocused();
  await expect(at).toHaveValue(mid.toFormat("HH:mm"));
  await expectNoA11yViolations(page);
  // Enter in the field submits the form (Tab would step through the time's own parts).
  await page.keyboard.press("Enter");
  await expect(split).toBeHidden();
  const first = `${hm(start)}–${hm(mid)} on ${label}`;
  const second = `${hm(mid)}–${hm(end)} on ${label}`;
  await expect(theDay.getByRole("button", { name: `Edit ${first}` })).toBeVisible();
  await expect(theDay.getByRole("button", { name: `Edit ${second}` })).toBeVisible();
  await expect(theDay.getByRole("listitem").filter({ hasText: note })).toHaveCount(2);

  // Not a second lost: the parts add up to the two hours.
  const parts = await erin
    .from("manual_entries")
    .select("start_at, end_at, note, reason, status")
    .eq("user_id", ERIN)
    .gte("start_at", start.toISO() ?? "")
    .lt("start_at", end.toISO() ?? "")
    .order("start_at");
  if (parts.error) throw parts.error;
  expect(parts.data).toHaveLength(2);
  expect(parts.data.every((p) => p.note === note && p.reason === reason)).toBe(true);
  expect(
    parts.data.reduce((s, p) => s + (Date.parse(p.end_at) - Date.parse(p.start_at)) / 1000, 0),
  ).toBe(7200);

  // Merge them back, from the keyboard.
  await theDay.getByRole("button", { name: `Merge ${first} with the next entry` }).focus();
  await page.keyboard.press("Enter");
  await expect(theDay.getByRole("button", { name: `Edit ${whole}` })).toBeVisible();
  await expect(theDay.getByRole("listitem").filter({ hasText: note })).toHaveCount(1);
  await expect(theDay.getByRole("button", { name: /^Merge / })).toHaveCount(0);

  // Duplicate it to the next day of the week: a new pending request.
  await theDay.getByRole("button", { name: `Duplicate ${whole}` }).click();
  const duplicate = page.getByRole("dialog", { name: "Duplicate entry" });
  await duplicate.getByLabel("Day").fill(copyDay);
  await expect(duplicate.getByLabel("Reason")).toHaveValue(reason);
  await expectNoA11yViolations(page);
  await duplicate.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(duplicate).toBeHidden();
  const copyStart = DateTime.fromISO(`${copyDay}T13:00`, { zone: ERIN_ZONE });
  const copyName = `${hm(copyStart)}–${hm(copyStart.plus({ hours: 2 }))} on ${copyLabel}`;
  const nextDay = list.getByRole("region", { name: copyLabel, exact: true });
  const copy = nextDay.getByRole("listitem").filter({ hasText: note });
  await expect(copy).toContainText("Manual · pending, not counted");
  await expect(nextDay.getByRole("button", { name: `Edit ${copyName}` })).toBeVisible();
  // The original is still there.
  await expect(theDay.getByRole("listitem").filter({ hasText: note })).toHaveCount(1);

  // Edit the copy's end and note.
  await nextDay.getByRole("button", { name: `Edit ${copyName}` }).click();
  const edit = page.getByRole("dialog", { name: "Edit entry" });
  await edit.getByLabel("End").fill("15:30");
  await edit.getByLabel("Work done").fill(`Review ${stamp}`);
  await expectNoA11yViolations(page);
  await edit.getByRole("button", { name: "Save entry" }).click();
  await expect(edit).toBeHidden();
  const edited = nextDay.getByRole("listitem").filter({ hasText: `Review ${stamp}` });
  await expect(edited).toContainText("2 h 30 min");
  await expect(
    nextDay.getByRole("button", {
      name: `Edit ${hm(copyStart)}–${hm(copyStart.plus({ minutes: 150 }))} on ${copyLabel}`,
    }),
  ).toBeVisible();
  await expectNoA11yViolations(page);
});
