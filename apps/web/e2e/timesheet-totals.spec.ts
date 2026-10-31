// #266 (TS-29): the week page and the Timesheets list show billable and non-billable time
// and totals by client, project and task, with overtime next to them. Erin logs four
// stretches on a past day nobody has touched (two tasks of the billable Website revamp,
// one billable and one not; Internal, with no client; and Unassigned time); her manager
// approves them and reads the totals.
import { weekOf } from "@ai-proctor/core";
import { expect, type Locator, type Page, test } from "@playwright/test";
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
const REVAMP = "00000000-0000-4000-8000-0000000000f1";
const INTERNAL = "00000000-0000-4000-8000-0000000000f2";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/** Sets (or, with nulls, clears) the org's overtime thresholds as the admin. */
async function setOvertime(daily: number | null, weekly: number | null) {
  const admin = await clientFor(ADMIN_EMAIL);
  const { error } = await admin.rpc("update_policy", {
    p_policy: { overtime_daily_hours: daily, overtime_weekly_hours: weekly },
  });
  if (error) throw error;
}

/**
 * A past day in a week of Erin's nobody has touched (no segments, manual entries or
 * timesheet), picked per run because the local database keeps every earlier run.
 */
async function freshDay(): Promise<string> {
  const manager = await clientFor(MANAGER_EMAIL);
  for (let i = 0; i < 80; i++) {
    const day =
      DateTime.now()
        .setZone(ERIN_ZONE)
        .minus({ days: 1400 + ((Date.now() + i * 13) % 900) })
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

/** The cells of the row named `name` in one of the totals tables: [worked, billable]. */
async function expectRow(table: Locator, name: string, worked: string, billable: string) {
  const row = table.getByRole("row", { name: new RegExp(`^${escapeRegExp(name)} `) });
  await expect(row.getByRole("cell")).toHaveText([worked, billable]);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("totals: billable, non-billable and by client, project and task, with overtime", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const build = `Build ${stamp}`;
  const qa = `QA ${stamp}`;
  const day = await freshDay();
  const week = weekOf(day, "monday");

  // Two tasks on Website revamp: Build is billable like the project, QA is not.
  const manager = await clientFor(MANAGER_EMAIL);
  const buildId = await manager.rpc("save_task", {
    p_id: null as unknown as string,
    p_project_id: REVAMP,
    p_name: build,
  });
  if (buildId.error) throw buildId.error;
  const qaId = await manager.rpc("save_task", {
    p_id: null as unknown as string,
    p_project_id: REVAMP,
    p_name: qa,
    p_billable: false,
  });
  if (qaId.error) throw qaId.error;

  // Erin asks for 3 h 45 min that day and her manager approves it all.
  const erin = await clientFor(ERIN_EMAIL);
  const at = (time: string) =>
    DateTime.fromISO(`${day}T${time}`, { zone: ERIN_ZONE }).toUTC().toISO() ?? "";
  // With gaps between them: buildSegments merges touching manual entries into one span,
  // which then keeps no project.
  const stretches: [string, string, string | null, string | null][] = [
    ["09:00", "11:00", REVAMP, buildId.data],
    ["11:15", "11:45", REVAMP, qaId.data],
    ["13:00", "14:00", INTERNAL, null],
    ["14:30", "14:45", null, null],
  ];
  for (const [start, end, projectId, taskId] of stretches) {
    const requested = await erin.rpc("request_manual_entry", {
      p_start_at: at(start),
      p_end_at: at(end),
      p_project_id: projectId as string,
      p_reason: `Totals e2e ${stamp}`,
      ...(taskId ? { p_task_id: taskId } : {}),
    });
    if (requested.error) throw requested.error;
    const decided = await manager.rpc("decide_manual_entry", {
      p_id: requested.data,
      p_approve: true,
    });
    if (decided.error) throw decided.error;
  }
  await rebuildSegments(ERIN, [day], manager);

  try {
    // Overtime at 3 h a day and a week, so both show next to the totals.
    await setOvertime(3, 3);

    // The week page: Erin's totals.
    await signIn(page, MANAGER_EMAIL, /\/team$/);
    await page.goto(`/timesheets/${ERIN}?week=${week}`);
    const totals = page.getByRole("region", { name: "Totals", exact: true });
    const stats = totals.getByRole("definition");
    await expect(stats).toHaveText(["3 h 45 min", "2 h 00 min", "1 h 45 min"], {
      timeout: 30_000,
    });
    await expect(totals.getByRole("term")).toHaveText(["Worked", "Billable", "Non-billable"]);
    await expect(totals).toContainText("45 min above the 3 h weekly threshold");
    await expect(totals).toContainText("1 day above the 3 h daily threshold");

    const clients = totals.getByRole("table", { name: "By client" });
    await expectRow(clients, "Northwind", "2 h 30 min", "2 h 00 min");
    await expectRow(clients, "No client", "1 h 00 min", "—");
    await expectRow(clients, "Unassigned", "15 min", "—");
    await expect(clients.getByRole("row")).toHaveCount(4);

    const projects = totals.getByRole("table", { name: "By project" });
    await expectRow(projects, "Website revamp", "2 h 30 min", "2 h 00 min");
    await expectRow(projects, "Internal", "1 h 00 min", "—");
    await expectRow(projects, "Unassigned", "15 min", "—");
    await expect(projects.getByRole("row")).toHaveCount(4);

    const tasks = totals.getByRole("table", { name: "By task" });
    await expectRow(tasks, `Website revamp › ${build}`, "2 h 00 min", "2 h 00 min");
    await expectRow(tasks, "Internal › No task", "1 h 00 min", "—");
    await expectRow(tasks, `Website revamp › ${qa}`, "30 min", "—");
    await expectRow(tasks, "Unassigned", "15 min", "—");
    await expect(tasks.getByRole("row")).toHaveCount(5);
    await expectNoA11yViolations(page);

    // The Timesheets list for that week (the browser's clock set to a day in it, since
    // the list opens on the current week): Erin's row and the totals of the list.
    await page.clock.setFixedTime(
      DateTime.fromISO(`${day}T12:00`, { zone: "America/Chicago" }).toJSDate(),
    );
    await page.goto("/timesheets");
    const erinRow = page.getByRole("row").filter({ hasText: "Erin Employee" });
    await expect(erinRow.getByRole("cell")).toHaveText(
      ["Erin Employee", /Draft/, /3 h 45 min/, "2 h 00 min", "1 h 45 min", "—", "Open"],
      // Rendered text: the phone-only labels in the cells are hidden here.
      { timeout: 30_000, useInnerText: true },
    );
    const listTotals = page.getByRole("region", { name: "Totals", exact: true });
    await expect(listTotals).toContainText(/\d+ (person|people) above the 3 h weekly threshold/, {
      timeout: 15_000,
    });
    // The tasks are this run's own, so their rows are Erin's time alone.
    const listTasks = listTotals.getByRole("table", { name: "By task" });
    await expectRow(listTasks, `Website revamp › ${build}`, "2 h 00 min", "2 h 00 min");
    await expectRow(listTasks, `Website revamp › ${qa}`, "30 min", "—");
    await expectNoA11yViolations(page);
  } finally {
    await setOvertime(null, null);
  }
});
