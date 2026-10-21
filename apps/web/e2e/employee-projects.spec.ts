import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";

const ERIN = "00000000-0000-4000-8000-0000000000c1";
const INTERNAL = "00000000-0000-4000-8000-0000000000f2";
const ERIN_EMAIL = "erin@acme.test";
const MANAGER_EMAIL = "manager@acme.test";
const ZONE = "America/Los_Angeles";

// Last week, so every day of it is past and nothing else in the suite clocks in there.
const lastWeek = DateTime.now().setZone(ZONE).startOf("week").minus({ weeks: 1 }).toISODate() ?? "";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

async function expectNoA11yViolations(page: Page) {
  // A hover style still easing in under a resting pointer reads as low contrast.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    results.violations.map(
      (v) => `${v.id}: ${v.help} ${v.nodes.map((n) => n.html.slice(0, 160)).join(" | ")}`,
    ),
  ).toEqual([]);
}

/** Opens every one of Erin's weeks to changes again, whatever earlier runs did to them. */
async function resetWeeks() {
  const manager = await clientFor(MANAGER_EMAIL);
  const { data, error } = await manager.from("timesheets").select("id, status").eq("user_id", ERIN);
  if (error) throw error;
  for (const sheet of data) {
    if (sheet.status === "approved") {
      const r = await manager.rpc("reopen_timesheet", { p_id: sheet.id, p_reason: "e2e reset" });
      if (r.error) throw r.error;
    }
    if (sheet.status === "approved" || sheet.status === "submitted") {
      const r = await manager.rpc("return_timesheet", { p_id: sheet.id, p_comment: "e2e reset" });
      if (r.error) throw r.error;
    }
  }
}

/**
 * Adds ten Unassigned minutes to Erin's last week, in a twenty-minute slot picked at
 * random (never touching another run's entry, so each stays its own stretch).
 */
async function addUnassignedTime() {
  const manager = await clientFor(MANAGER_EMAIL);
  const ensured = await manager.rpc("ensure_timesheet", {
    p_user_id: ERIN,
    p_period_start: lastWeek,
  });
  if (ensured.error) throw ensured.error;
  for (let attempt = 0; attempt < 40; attempt++) {
    const start = DateTime.fromISO(lastWeek, { zone: ZONE }).plus({
      minutes: Math.floor(Math.random() * 504) * 20,
    });
    const added = await manager.rpc("adjust_time", {
      p_timesheet_id: ensured.data,
      p_start_at: start.toUTC().toISO() ?? "",
      p_end_at: start.plus({ minutes: 10 }).toUTC().toISO() ?? "",
      p_project_id: null as unknown as string,
      p_reason: "e2e unassigned time",
      p_entry_id: null as unknown as string,
    });
    if (!added.error) return;
    if (!added.error.message.startsWith("overlaps")) throw added.error;
  }
  throw new Error("No free slot in last week");
}

/** The names of the active projects Erin is assigned to (other specs add some). */
async function erinsProjects(): Promise<string[]> {
  const erin = await clientFor(ERIN_EMAIL);
  const members = await erin.from("project_members").select("project_id").eq("user_id", ERIN);
  if (members.error) throw members.error;
  const projects = await erin.from("projects").select("id, name").eq("archived", false);
  if (projects.error) throw projects.error;
  const mine = new Set(members.data.map((m) => m.project_id));
  return projects.data.filter((p) => mine.has(p.id)).map((p) => p.name);
}

/** The options of a project select, without the placeholder, in a stable order. */
async function projectOptions(select: Locator): Promise<string[]> {
  const names = await select.locator("option").allTextContents();
  return names.slice(1).sort();
}

/** Erin's counted seconds of last week on one project (null: Unassigned). */
async function workedOn(projectId: string | null): Promise<number> {
  const erin = await clientFor(ERIN_EMAIL);
  const { data, error } = await erin.rpc("timesheet_breakdown", {
    p_user_id: ERIN,
    p_from: lastWeek,
    p_to: DateTime.fromISO(lastWeek).plus({ days: 6 }).toISODate() ?? lastWeek,
  });
  if (error) throw error;
  type Row = { counted: boolean; excluded: boolean; project_id: string | null; seconds: number };
  return (data as Row[])
    .filter((r) => r.counted && !r.excluded && r.project_id === projectId)
    .reduce((sum, r) => sum + r.seconds, 0);
}

test("an employee tags Unassigned time to a project on a draft week, submits, and the manager sees her change", async ({
  page,
}) => {
  // Each page open rebuilds seven days through the Edge Function.
  test.setTimeout(90_000);
  const note = `Internal sync ${Date.now()}`;
  await resetWeeks();
  await addUnassignedTime();

  await signIn(page, ERIN_EMAIL, /\/me$/);
  await page.goto(`/timesheets/${ERIN}?week=${lastWeek}`);
  await expect(page.getByRole("heading", { name: /Erin Employee · Week of/ })).toBeVisible();
  const unassigned = page.getByRole("region", { name: "Unassigned time" });
  const tenMinutes = unassigned.getByRole("listitem").filter({ hasText: "10 min" });
  // The week is rebuilt when the page opens; the list fills in once that is done.
  await expect(tenMinutes.first()).toBeVisible({ timeout: 20_000 });
  const before = await tenMinutes.count();
  const internalBefore = await workedOn(INTERNAL);
  const unassignedBefore = await workedOn(null);
  await expectNoA11yViolations(page);

  // The project is required for a stretch of Unassigned time.
  await tenMinutes.first().getByRole("button", { name: "Tag a project" }).click();
  const dialog = page.getByRole("dialog", { name: "Tag a project" });
  await dialog.getByRole("button", { name: "Tag project" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Choose a project.");
  // Only the projects she is on are offered.
  await expect(dialog.getByLabel("Project").locator("option").first()).toHaveText(
    "Choose a project",
  );
  expect(await projectOptions(dialog.getByLabel("Project"))).toEqual(
    (await erinsProjects()).sort(),
  );
  await dialog.getByLabel("Project").selectOption({ label: "Internal" });
  await dialog.getByLabel("Note (optional)").fill(note);
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Tag project" }).click();
  await expect(dialog).toBeHidden();

  // The stretch leaves the list and the totals follow: ten minutes moved.
  await expect(tenMinutes).toHaveCount(before - 1);
  const edits = page.getByRole("region", { name: "Edits to your time" });
  await expect(edits).toContainText("You changed project to Internal");
  await expect(edits).toContainText(`Reason: ${note}`);
  await expect(page.locator("tfoot")).toContainText("Internal");
  expect(await workedOn(INTERNAL)).toBe(internalBefore + 600);
  expect(await workedOn(null)).toBe(unassignedBefore - 600);
  await expectNoA11yViolations(page);

  // A whole day can be changed too; the dialog offers Unassigned and her projects.
  await page
    .getByRole("button", { name: /^Change project for / })
    .first()
    .click();
  const dayDialog = page.getByRole("dialog", { name: "Change project" });
  await expect(dayDialog.getByLabel("Project").locator("option").first()).toHaveText("Unassigned");
  expect(await projectOptions(dayDialog.getByLabel("Project"))).toEqual(
    (await erinsProjects()).sort(),
  );
  await expectNoA11yViolations(page);
  await dayDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dayDialog).toBeHidden();

  // Submitting locks it: the week is with the manager.
  await page.getByRole("button", { name: /^Submit week|^Submit again/ }).click();
  await expect(page.getByText(/^Submitted · /)).toBeVisible();
  await expect(page.getByRole("region", { name: "Unassigned time" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Change project for / })).toHaveCount(0);
  const locked = await (await clientFor(ERIN_EMAIL)).rpc("reassign_my_time", {
    p_start: DateTime.fromISO(lastWeek, { zone: ZONE }).toUTC().toISO() ?? "",
    p_end: DateTime.fromISO(lastWeek, { zone: ZONE }).plus({ hours: 1 }).toUTC().toISO() ?? "",
    p_project_id: INTERNAL,
    p_reason: null as unknown as string,
  });
  expect(locked.error?.message).toBe("timesheet_submitted");
  await page.getByLabel("Account menu for Erin Employee").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  // The manager sees it as Erin's edit, with no reason owed.
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto(`/timesheets/${ERIN}?week=${lastWeek}`);
  const managerEdits = page.getByRole("region", { name: "Edits so far" });
  const change = managerEdits
    .getByRole("listitem")
    .filter({ hasText: "Employee changed project to Internal" })
    .filter({ hasText: note });
  await expect(change).toBeVisible();
  await expect(change).toContainText("Erin Employee");
  await expect(page.getByRole("button", { name: "Return with comment" })).toBeVisible();
  await expectNoA11yViolations(page);
});
