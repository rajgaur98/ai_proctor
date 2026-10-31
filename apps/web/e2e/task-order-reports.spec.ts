// #269 (PRJ-05, DSH-10): an admin puts a project's tasks in order with the keyboard, and
// the report grouped by project and task lists them in that order, with "No task" last.
// Everything is on a project made for this run, so earlier runs' tasks and time don't
// count, and the time goes on a day of Erin's no earlier run has used.
import { weekOf } from "@ai-proctor/core";
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import { ERIN, ERIN_ZONE, expectNoA11yViolations, MANAGER_EMAIL, rebuildSegments } from "./helpers";

const ADMIN_EMAIL = "admin@acme.test";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/** A past day of Erin's with no manual time, in a week that is still open to changes. */
async function openDay(client: Awaited<ReturnType<typeof clientFor>>): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const day =
      DateTime.now()
        .setZone(ERIN_ZONE)
        .minus({ days: 1400 + ((Date.now() + i * 13) % 900) })
        .toISODate() ?? "";
    const [entries, sheets] = await Promise.all([
      client
        .from("manual_entries")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ERIN)
        .gte("start_at", DateTime.fromISO(day, { zone: ERIN_ZONE }).minus({ days: 1 }).toISO())
        .lte("start_at", DateTime.fromISO(day, { zone: ERIN_ZONE }).plus({ days: 2 }).toISO()),
      client
        .from("timesheets")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ERIN)
        .eq("period_start", weekOf(day, "monday"))
        .neq("status", "draft"),
    ]);
    for (const r of [entries, sheets]) if (r.error) throw r.error;
    if (entries.count === 0 && sheets.count === 0) return day;
  }
  throw new Error("no open day found for Erin");
}

test("an admin reorders tasks and groups a report by project and task", async ({ page }) => {
  test.setTimeout(120_000);
  const project = `Ordering ${Date.now()}`;

  // A project of this run's with two tasks, Design then Build, and Erin on it.
  const admin = await clientFor(ADMIN_EMAIL);
  const saved = await admin.rpc("save_project", {
    p_id: null as unknown as string,
    p_name: project,
    p_client_id: null as unknown as string,
    p_billable: true,
    p_archived: false,
  });
  if (saved.error) throw saved.error;
  const projectId = saved.data;
  const members = await admin.rpc("set_project_members", {
    p_project_id: projectId,
    p_user_ids: [ERIN],
  });
  if (members.error) throw members.error;
  const taskIds: Record<string, string> = {};
  for (const name of ["Design", "Build"]) {
    const task = await admin.rpc("save_task", {
      p_id: null as unknown as string,
      p_project_id: projectId,
      p_name: name,
      p_archived: false,
    });
    if (task.error) throw task.error;
    taskIds[name] = task.data;
  }

  // Her manager adds time on one of Erin's days: Build 1 h, Design 30 min, and 15 min on
  // the project with no task. Gaps between them: back-to-back manual entries currently come
  // out of buildSegments as one span with no project.
  const manager = await clientFor(MANAGER_EMAIL);
  const day = await openDay(manager);
  const sheet = await manager.rpc("ensure_timesheet", {
    p_user_id: ERIN,
    p_period_start: weekOf(day, "monday"),
  });
  if (sheet.error) throw sheet.error;
  const at = (time: string) =>
    DateTime.fromISO(`${day}T${time}`, { zone: ERIN_ZONE }).toISO() ?? "";
  for (const [start, end, task] of [
    ["10:00", "11:00", taskIds.Build],
    ["11:15", "11:45", taskIds.Design],
    ["12:00", "12:15", null],
  ] as const) {
    const added = await manager.rpc("adjust_time", {
      p_timesheet_id: sheet.data,
      p_start_at: at(start),
      p_end_at: at(end),
      p_project_id: projectId,
      p_reason: "e2e: task order",
      ...(task ? { p_task_id: task } : {}),
    });
    if (added.error) throw added.error;
  }
  await rebuildSegments(ERIN, [day], manager);

  // The admin moves Build above Design with the keyboard.
  await signIn(page, ADMIN_EMAIL, /\/team$/);
  await page.goto("/projects");
  await page.getByRole("button", { name: `Tasks of ${project}` }).click();
  const dialog = page.getByRole("dialog", { name: `Tasks for ${project}` });
  const names = dialog.getByLabel(/^Name of /);
  await expect(names.nth(0)).toHaveValue("Design");
  await expect(names.nth(1)).toHaveValue("Build");
  await expect(dialog.getByRole("button", { name: "Move Design up" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Move Build down" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Move Build up" }).focus();
  await page.keyboard.press("Enter");
  await expect(names.nth(0)).toHaveValue("Build");
  await expect(names.nth(1)).toHaveValue("Design");
  // Build is first now, so focus stays on it, on the button it can still use.
  await expect(dialog.getByRole("button", { name: "Move Build down" })).toBeFocused();
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Close" }).click();

  // The order is saved: the database has it, and the dialog shows it after a reload.
  const order = await admin
    .from("project_tasks")
    .select("name")
    .eq("project_id", projectId)
    .order("sort_order");
  if (order.error) throw order.error;
  expect(order.data.map((t) => t.name)).toEqual(["Build", "Design"]);
  await page.reload();
  await page.getByRole("button", { name: `Tasks of ${project}` }).click();
  await expect(names.nth(0)).toHaveValue("Build");
  await dialog.getByRole("button", { name: "Close" }).click();

  // The report for that day, grouped by project and task, follows the new order.
  await page.goto("/reports");
  await page.getByLabel("From", { exact: true }).fill(day);
  await page.getByLabel("To", { exact: true }).fill(day);
  await page.getByLabel("Group by").selectOption({ label: "Project and task" });
  const group = page.locator("tbody").filter({
    has: page.getByRole("rowheader", { name: project, exact: true }),
  });
  await expect(group.getByRole("rowheader")).toHaveText([
    project,
    `${project} › Build`,
    `${project} › Design`,
    `${project} › No task`,
  ]);
  const worked = (name: string) =>
    group.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
  await expect(worked(project)).toContainText("1 h 45 min");
  await expect(worked(`${project} › Build`)).toContainText("1 h 00 min");
  await expect(worked(`${project} › Design`)).toContainText("30 min");
  await expect(worked(`${project} › No task`)).toContainText("15 min");
  await expectNoA11yViolations(page);
});
