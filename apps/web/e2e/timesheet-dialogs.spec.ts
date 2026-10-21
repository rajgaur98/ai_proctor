import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { agentFor, clientFor } from "./agent";

const ERIN = "00000000-0000-4000-8000-0000000000c1";
const ERIN_EMAIL = "erin@acme.test";
const MANAGER_EMAIL = "manager@acme.test";
const WEBSITE = { id: "00000000-0000-4000-8000-0000000000f1", name: "Website revamp" };
const INTERNAL = { id: "00000000-0000-4000-8000-0000000000f2", name: "Internal" };

const ZONE = "America/Los_Angeles";
/** Erin's current week, Monday-based like the seed org, in her time zone. */
const week = DateTime.now().setZone(ZONE).startOf("week");

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** Leaves Erin's week open to submit again, whatever earlier runs did to it. */
async function resetWeek() {
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

/** Cancels this spec's pending requests (a run that stopped halfway leaves them behind). */
async function cancelEntries() {
  const erin = await clientFor(ERIN_EMAIL);
  const { data, error } = await erin
    .from("manual_entries")
    .select("id")
    .eq("status", "pending")
    .like("reason", "e2e dialogs %");
  if (error) throw error;
  for (const e of data) {
    const r = await erin.rpc("cancel_manual_entry", { p_id: e.id });
    if (r.error) throw r.error;
  }
}

/** Two pending manual entries early on the week's first day, on different projects. */
async function twoEntries(stamp: number) {
  const erin = await clientFor(ERIN_EMAIL);
  const at = (hour: number, minute: number) =>
    week.set({ hour, minute }).toUTC().toISO() ?? week.toISO() ?? "";
  const request = async (start: string, end: string, projectId: string, reason: string) => {
    const r = await erin.rpc("request_manual_entry", {
      p_start_at: start,
      p_end_at: end,
      p_project_id: projectId,
      p_reason: reason,
    });
    if (r.error) throw r.error;
  };
  await request(at(0, 5), at(0, 35), WEBSITE.id, `e2e dialogs first ${stamp}`);
  await request(at(0, 40), at(1, 10), INTERNAL.id, `e2e dialogs second ${stamp}`);
}

/** Two shifts that each end with a missed check-in, on different projects: two flagged segments. */
async function twoFlaggedSegments() {
  const erin = await agentFor(ERIN_EMAIL);
  await erin("clock_out", { reason: "manual" });
  for (const project of [WEBSITE, INTERNAL]) {
    await erin("clock_in", { reason: "manual", project_id: project.id });
    await erin("checkin", {
      // Scheduled well before it was shown, like timesheets.spec: the other specs read
      // the newest check-in of the day, and this one must not be it.
      scheduled_at: new Date(Date.now() - 3_600_000).toISOString(),
      shown_at: new Date().toISOString(),
      outcome: "miss",
      wrong_clicks: 0,
      idle_s_at_show: 0,
      device_state: "active",
      object_keys: [],
      flags: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await erin("clock_out", { reason: "manual" });
    // Segments are whole seconds and neighbours of one type merge: leave a gap.
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

async function submitAsErin() {
  const erin = await clientFor(ERIN_EMAIL);
  const ensured = await erin.rpc("ensure_timesheet", {
    p_user_id: ERIN,
    p_period_start: week.toISODate() ?? "",
  });
  if (ensured.error) throw ensured.error;
  const submitted = await erin.rpc("submit_timesheet", { p_id: ensured.data });
  if (submitted.error) throw submitted.error;
}

test("the manager's Change project and Adjust dialogs open on each segment and entry in turn", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // The entries sit in the first hour of the week, which must be over.
  test.skip(
    DateTime.now().setZone(ZONE) < week.set({ hour: 1, minute: 30 }),
    "the week started less than 90 minutes ago",
  );
  const stamp = Date.now();

  await resetWeek();
  await cancelEntries();
  try {
    await twoEntries(stamp);
    await twoFlaggedSegments();
    await submitAsErin();

    await signIn(page, MANAGER_EMAIL, /\/team$/);
    await page.goto(`/timesheets/${ERIN}?week=${week.toISODate()}`);
    await expect(page.getByText(/^Submitted · /)).toBeVisible();
    // The week is rebuilt when the page opens; the lists fill in once that is done.
    await expect(page.getByText("Refreshing the week…")).toBeHidden({ timeout: 30_000 });

    // The newest flagged segment of each project is this run's.
    const flagged = page.getByRole("region", { name: "Flagged segments" }).getByRole("listitem");
    const segmentA = flagged.filter({ hasText: `${WEBSITE.name} ·` }).last();
    const segmentB = flagged.filter({ hasText: `${INTERNAL.name} ·` }).last();
    await expect(segmentA).toBeVisible();
    await expect(segmentB).toBeVisible();

    const project = page.getByRole("dialog", { name: "Change project" });
    for (const [segment, expected] of [
      [segmentA, WEBSITE],
      [segmentB, INTERNAL],
      [segmentA, WEBSITE],
    ] as const) {
      await segment.getByRole("button", { name: "Change project" }).click();
      await expect(project).toBeVisible();
      await expect(project.getByLabel("Project")).toHaveValue(expected.id);
      await expect(project.getByLabel("Reason")).toHaveValue("");
      await expectNoA11yViolations(page);
      await project.getByRole("button", { name: "Cancel" }).click();
      await expect(project).toBeHidden();
    }

    const entries = page.getByRole("region", { name: "Manual entry requests" });
    const entryA = entries.getByRole("listitem").filter({ hasText: `first ${stamp}` });
    const entryB = entries.getByRole("listitem").filter({ hasText: `second ${stamp}` });
    await expect(entryA).toBeVisible();
    await expect(entryB).toBeVisible();

    const adjust = page.getByRole("dialog", { name: "Adjust manual entry" });
    for (const [entry, start, end, expected] of [
      [entryA, "00:05", "00:35", WEBSITE],
      [entryB, "00:40", "01:10", INTERNAL],
      [entryA, "00:05", "00:35", WEBSITE],
    ] as const) {
      await entry.getByRole("button", { name: "Adjust" }).click();
      await expect(adjust).toBeVisible();
      await expect(adjust.getByLabel("Start")).toHaveValue(start);
      await expect(adjust.getByLabel("End")).toHaveValue(end);
      await expect(adjust.getByLabel("Project")).toHaveValue(expected.id);
      await expect(adjust.getByLabel("Reason")).toHaveValue("");
      await expectNoA11yViolations(page);
      await adjust.getByRole("button", { name: "Cancel" }).click();
      await expect(adjust).toBeHidden();
    }

    // Add time opens the same dialog on no entry: blank reason, the add title.
    await page.getByRole("button", { name: "Add time" }).click();
    await expect(page.getByRole("dialog", { name: "Add time" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Add time" }).getByLabel("Start")).toHaveValue(
      "09:00",
    );
  } finally {
    await cancelEntries();
    await resetWeek();
  }
});

// Last week, so every day of it is past and nothing else in the suite clocks in there.
const lastWeek = week.minus({ weeks: 1 }).toISODate() ?? "";

/** Adds `minutes` of Unassigned time to Erin's last week, in a free twenty-minute slot picked at random. */
async function addUnassignedTime(minutes: number) {
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
      p_end_at: start.plus({ minutes }).toUTC().toISO() ?? "",
      p_project_id: null as unknown as string,
      p_reason: "e2e unassigned time",
      p_entry_id: null as unknown as string,
    });
    if (!added.error) return;
    if (!added.error.message.startsWith("overlaps")) throw added.error;
  }
  throw new Error("No free slot in last week");
}

test("the employee's Tag a project and Change project dialogs open on each stretch and day in turn", async ({
  page,
}) => {
  // Each page open rebuilds seven days through the Edge Function.
  test.setTimeout(90_000);
  await resetWeek();
  await addUnassignedTime(11);
  await addUnassignedTime(17);

  await signIn(page, ERIN_EMAIL, /\/me$/);
  await page.goto(`/timesheets/${ERIN}?week=${lastWeek}`);
  const stretches = page.getByRole("region", { name: "Unassigned time" }).getByRole("listitem");
  // The week is rebuilt when the page opens; the list fills in once that is done.
  await expect(stretches.nth(1)).toBeVisible({ timeout: 20_000 });
  const timeOf = (row: Locator) => row.locator("span.font-mono").first();
  const stretchA = stretches.nth(0);
  const stretchB = stretches.nth(1);
  const timeA = await timeOf(stretchA).innerText();
  const timeB = await timeOf(stretchB).innerText();
  expect(timeA).not.toBe(timeB);

  const tag = page.getByRole("dialog", { name: "Tag a project" });
  const day = page.getByRole("dialog", { name: "Change project" });
  const dayButton = page.getByRole("button", { name: /^Change project for / }).first();
  for (const [open, dialog, expected] of [
    [stretchA.getByRole("button", { name: "Tag a project" }), tag, timeA],
    [stretchB.getByRole("button", { name: "Tag a project" }), tag, timeB],
    [stretchA.getByRole("button", { name: "Tag a project" }), tag, timeA],
    [dayButton, day, null],
    [stretchB.getByRole("button", { name: "Tag a project" }), tag, timeB],
  ] as const) {
    await open.click();
    await expect(dialog).toBeVisible();
    // Each opening starts a fresh form on its own target.
    await expect(dialog.getByLabel("Project")).toHaveValue("");
    await expect(dialog.getByLabel("Note (optional)")).toHaveValue("");
    if (expected) await expect(dialog.locator("span.font-mono")).toHaveText(expected);
    await expectNoA11yViolations(page);
    await dialog.getByLabel("Note (optional)").fill("left over");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  }
});
