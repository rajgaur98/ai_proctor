// #254 part 1 (PRJ-05, TS-24, TS-25): an admin adds a task to a project; the employee logs
// manual time on it with a work note and writes a note for the day; her manager sees both
// while reviewing, and the export carries the task and the notes.
import { readFile } from "node:fs/promises";
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

/**
 * A past day in a week of Erin's nobody has touched: no segments, no manual entries and
 * no timesheet, so the week is a fresh draft. The local database keeps every earlier run,
 * so it is picked per run.
 */
async function freshDay(): Promise<string> {
  const manager = await clientFor(MANAGER_EMAIL);
  for (let i = 0; i < 80; i++) {
    const day =
      DateTime.now()
        .setZone(ERIN_ZONE)
        .minus({ days: 400 + ((Date.now() + i * 11) % 900) })
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

/** A CSV download from the Export dialog on the Timesheets tab, as header-keyed rows. */
async function exportCsv(page: Page, view: string, week: string) {
  await page.goto("/timesheets");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export timesheets" });
  await dialog.getByLabel("From", { exact: true }).fill(week);
  await dialog.getByLabel("To", { exact: true }).fill(weekDays(week).at(-1) ?? week);
  await dialog.getByLabel("Employee").selectOption({ label: "Erin Employee" });
  await dialog.getByLabel("View").selectOption(view);
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download CSV" }).click();
  const text = await readFile((await (await download).path()) ?? "", "utf8");
  return parseCsv(text.replace(/^﻿/, ""));
}

/** RFC 4180 rows (quoted cells may hold commas and line breaks) keyed by the header. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  const [header = [], ...lines] = rows;
  return lines.map((l) => Object.fromEntries(header.map((h, i) => [h, l[i] ?? ""])));
}

test("tasks and work notes: added, logged, reviewed and exported", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const task = `Design ${stamp}`;
  const reason = `Offline at the client ${stamp}`;
  const entryNote = `Wireframes for checkout ${stamp}`;
  const dayNote = `Sprint planning and the checkout spec ${stamp}`;
  const day = await freshDay();
  const week = weekOf(day, "monday");
  const dayLabel = DateTime.fromISO(day, { zone: "utc" }).toFormat("ccc d LLL");

  // The admin adds a task to Website revamp.
  await signIn(page, ADMIN_EMAIL, /\/team$/);
  await page.goto("/projects");
  await page.getByRole("button", { name: "Tasks of Website revamp" }).click();
  const tasks = page.getByRole("dialog", { name: "Tasks for Website revamp" });
  await expect(tasks).toContainText("New tasks are billable, like the project.");
  await tasks.getByLabel("New task name").fill(task);
  await tasks.getByRole("button", { name: "Add task" }).click();
  await expect(tasks.getByLabel(`Name of ${task}`)).toHaveValue(task);
  await expect(tasks.getByLabel(`Billable for ${task}`)).toBeChecked();
  await expectNoA11yViolations(page);
  await tasks.getByRole("button", { name: "Close" }).click();
  await signOut(page, "Ada Admin");

  // Erin asks for time on it with a work note, from her day page.
  await signIn(page, ERIN_EMAIL, /\/me$/);
  await page.goto(`/team/${ERIN}?date=${day}`);
  await page.getByRole("button", { name: "Request manual time" }).click();
  const request = page.getByRole("dialog", { name: "Request manual time" });
  await request.getByLabel("Start").fill("13:00");
  await request.getByLabel("End").fill("14:30");
  await request.getByLabel("Project").selectOption({ label: "Website revamp" });
  await request.getByLabel("Task").selectOption({ label: task });
  await request.getByLabel("Reason").fill(reason);
  await request.getByLabel("Work done (optional)").fill(entryNote);
  await expectNoA11yViolations(page);
  await request.getByRole("button", { name: "Send request" }).click();
  await expect(request).toBeHidden();
  const entryRow = page
    .getByRole("region", { name: "Manual entries" })
    .getByRole("listitem")
    .filter({ hasText: reason });
  await expect(entryRow).toContainText(`Website revamp › ${task}`);
  await expect(entryRow).toContainText(`Work done: ${entryNote}`);

  // …and writes what she did that day on her timesheet week.
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  await page.getByRole("button", { name: `Add work note for ${dayLabel}` }).click();
  const noteDialog = page.getByRole("dialog", { name: `Work done · ${dayLabel}` });
  await noteDialog.getByLabel("Note").fill(dayNote);
  await expectNoA11yViolations(page);
  await noteDialog.getByRole("button", { name: "Save note" }).click();
  await expect(noteDialog).toBeHidden();
  const dayRow = page.getByRole("row").filter({ hasText: dayLabel });
  await expect(dayRow).toContainText(dayNote);
  await expect(
    dayRow.getByRole("button", { name: `Edit work note for ${dayLabel}` }),
  ).toBeVisible();
  const weekEntries = page.getByRole("region", { name: "Manual entry requests" });
  await expect(weekEntries).toContainText(`Website revamp › ${task}`);
  await expect(weekEntries.getByRole("button", { name: "Edit task and note" })).toBeVisible();
  await expectNoA11yViolations(page);
  await signOut(page, "Erin Employee");

  // Her manager sees both, read-only, and approves the entry.
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  const managerDay = page.getByRole("row").filter({ hasText: dayLabel });
  await expect(managerDay).toContainText(dayNote, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: /work note for/ })).toHaveCount(0);
  const card = page
    .getByRole("region", { name: "Manual entry requests" })
    .getByRole("listitem")
    .filter({ hasText: reason });
  await expect(card).toContainText(`Website revamp › ${task}`);
  await expect(card).toContainText(entryNote);
  await expect(card.getByRole("button", { name: "Edit task and note" })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toContainText("Approved");

  // Once rebuilt, the export has the task and the notes.
  await rebuildSegments(ERIN, [day], await clientFor(MANAGER_EMAIL));
  const daily = await exportCsv(page, "daily", week);
  const dailyRow = daily.find((r) => r.Date === day);
  expect(dailyRow?.["Worked (H:MM)"]).toBe("1:30");
  expect(dailyRow?.["Work done"]).toBe(`${dayNote}\n${entryNote}`);
  const byProject = await exportCsv(page, "project", week);
  const taskRow = byProject.find((r) => r.Task === task);
  expect(taskRow).toMatchObject({
    Project: "Website revamp",
    Billable: "Yes",
    "Worked (h)": "1.50",
  });
});
