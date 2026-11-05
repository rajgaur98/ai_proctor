// Insights (#305, INS-01..06): a manager reads attendance, presence, time, projects and
// what needs review for a range, against the previous one; the totals equal the Reports
// tab's for the same filters (INS-04), people are listed by name (INS-03), the team and
// person filters narrow it, the page loads with one insights call, the export is
// audit-logged (TS-27/28), an admin sets a team's billable target, an employee reads their
// own in My data (INS-05), and the weekly email switch is on the Alerts page (INS-06).
import { readFile } from "node:fs/promises";
import { expect, type Page, type Request, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import {
  ERIN,
  ERIN_EMAIL,
  expectNoA11yViolations,
  flaggedTime,
  MANAGER_EMAIL,
  makeTeam,
  pressUntilFocused,
  removeTeam,
} from "./helpers";

const LUCAS = "00000000-0000-4000-8000-0000000000c2";
const MAX = "00000000-0000-4000-8000-0000000000b1";
const ADMIN_EMAIL = "admin@acme.test";

/** The Monday-based week the page opens on, from the manager's calendar (Chicago). */
const weekStart = DateTime.now().setZone("America/Chicago").startOf("week");
const weekFrom = weekStart.toISODate() ?? "";
const weekTo = weekStart.plus({ days: 6 }).toISODate() ?? "";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/** "38 h 20 min" / "45 min", rounded to the minute like the dashboard. */
function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

/** The value of a summary tile: the definition after its term, inside a labelled list. */
const tile = (page: Page, list: string, term: string) =>
  page
    .getByLabel(list, { exact: true })
    .getByRole("term")
    .filter({ hasText: new RegExp(`^${term}$`) })
    .locator("xpath=following-sibling::*[1]");

const sinceNow = () => DateTime.now().minus({ seconds: 30 }).toUTC().toISO() ?? "";

test("a manager reads Insights: the totals equal Reports', people by name, one call per load", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await flaggedTime();
  const manager = await clientFor(MANAGER_EMAIL);
  const report = await manager.rpc("report_rows", { p_from: weekFrom, p_to: weekTo });
  if (report.error) throw report.error;
  const rows = (report.data as { rows: Record<string, number | string>[] }).rows;
  const sum = (key: string) => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);
  expect(sum("worked_s")).toBeGreaterThan(0);

  await signIn(page, MANAGER_EMAIL, /\/team$/);
  const rest: string[] = [];
  const onRequest = (r: Request) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/rest/v1/")) {
      rest.push(`${r.method()} ${url.pathname}${url.search} ${r.postData() ?? ""}`);
    }
  };
  page.on("request", onRequest);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Insights" })
    .click();
  await expect(page.getByRole("heading", { name: "Insights", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "This week" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(weekFrom);

  // INS-04: the same numbers as Reports for the same filters, from the same seconds.
  await expect(tile(page, "Time totals", "Worked")).toHaveText(duration(sum("worked_s")));
  await expect(tile(page, "Time totals", "Flagged")).toHaveText(duration(sum("flagged_s")));
  await expect(tile(page, "Time totals", "Excluded")).toHaveText(duration(sum("excluded_s")));
  await expect(tile(page, "Attendance totals", "Late clock-ins")).toHaveText(
    String(sum("late_clock_ins")),
  );
  await expect(tile(page, "Presence totals", "Missed check-ins")).toHaveText(
    String(sum("checkins_missed")),
  );
  const shown = sum("checkins_shown");
  await expect(tile(page, "Presence totals", "Response rate")).toHaveText(
    shown > 0 ? `${Math.round((sum("checkins_passed") / shown) * 100)}%` : "—",
  );

  // One insights call loads the page, and nothing is asked twice (#156 query budget).
  await page.waitForLoadState("networkidle");
  page.off("request", onRequest);
  expect(rest.filter((r) => r.includes("/rest/v1/rpc/insights"))).toHaveLength(1);
  expect(
    rest.filter((r, i) => rest.indexOf(r) !== i),
    rest.join("\n"),
  ).toEqual([]);

  // The charts are labelled images, each section has its heading.
  for (const name of ["Attendance", "Presence", "Time", "Projects", "Needs review", "People"]) {
    await expect(page.getByRole("heading", { name, level: 2, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("img", { name: /^Shift days\./ })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Response rate\./ })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Hours by project\./ })).toBeVisible();

  // INS-03: people by name; no score column.
  const people = page.getByRole("region", { name: "People" }).getByRole("table");
  const names = (await people.getByRole("rowheader").allTextContents()).map((t) =>
    t.replace(/ · deactivated$/, "").trim(),
  );
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  expect(names).toContain("Erin Employee");
  await expect(people.getByRole("columnheader", { name: /score|rank/i })).toHaveCount(0);
  await expectNoA11yViolations(page);

  // The same Worked on the Reports tab for the same week.
  const worked = await tile(page, "Time totals", "Worked").textContent();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Reports" })
    .click();
  await expect(
    page
      .getByRole("term")
      .filter({ hasText: /^Worked$/ })
      .locator("xpath=following-sibling::*[1]"),
  ).toHaveText(worked ?? "");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Insights" })
    .click();

  // Keyboard: last week from the presets, then back.
  const lastWeek = page.getByRole("button", { name: "Last week" });
  await pressUntilFocused(page, lastWeek);
  await page.keyboard.press("Enter");
  await expect(lastWeek).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/compared with/)).toBeVisible();
  await page.getByRole("button", { name: "This week" }).click();

  // The person filter narrows everything to one person.
  await page.getByLabel("Person").selectOption({ label: "Lucas Martin" });
  await expect(people.getByRole("rowheader")).toHaveText(["Lucas Martin"]);
  const lucas = rows.find((r) => r.user_id === LUCAS);
  await expect(tile(page, "Time totals", "Worked")).toHaveText(
    duration(Number(lucas?.worked_s ?? 0)),
  );
  await page.getByLabel("Person").selectOption({ label: "Everyone" });
  await expect(people.getByRole("rowheader", { name: "Erin Employee" })).toBeVisible();
});

test("the team filter and a team's billable target, set by an admin and audit-logged", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const team = await makeTeam("Insights", [ERIN]);
  try {
    await signIn(page, ADMIN_EMAIL, /\/team$/);
    await page.goto("/teams");
    await page.getByRole("button", { name: `Edit ${team.name}` }).click();
    const dialog = page.getByRole("dialog", { name: `Edit ${team.name}` });
    const target = dialog.getByLabel("Billable target (%)");
    await expect(target).toHaveValue("");
    await target.fill("0");
    await expect(dialog.getByRole("button", { name: "Save team" })).toBeDisabled();
    await target.fill("60");
    await dialog.getByRole("button", { name: "Save team" }).click();
    await expect(dialog).not.toBeVisible();

    await page.goto("/insights");
    await page.getByLabel("Team").selectOption({ label: team.name });
    const people = page.getByRole("region", { name: "People" }).getByRole("table");
    await expect(people.getByRole("rowheader")).toHaveText(["Erin Employee"]);
    await expect(page.getByLabel("Time totals", { exact: true })).toContainText("target 60%");
    await expect(page.getByRole("img", { name: /against a target of 60%/ })).toBeVisible();
    await expectNoA11yViolations(page);

    const admin = await clientFor(ADMIN_EMAIL);
    const { data, error } = await admin
      .from("audit_log")
      .select("metadata")
      .eq("action", "team.billable_target_changed")
      .order("at", { ascending: false })
      .limit(1);
    if (error) throw error;
    expect(data[0]?.metadata).toMatchObject({ team_id: team.id, from: null, to: 60 });
  } finally {
    await removeTeam(team.id);
  }
});

test("a manager exports Insights as CSV, and the export is audit-logged", async ({ page }) => {
  const since = sinceNow();
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/insights");
  await expect(page.getByRole("region", { name: "People" })).toBeVisible();
  await page.getByRole("button", { name: "Export insights" }).click();
  const dialog = page.getByRole("dialog", { name: "Export insights" });
  await expect(dialog).toContainText(`from: ${weekFrom}`);
  const table = dialog.getByRole("radiogroup", { name: "Table" });
  await expect(table.getByLabel("Summary")).toBeChecked();
  await table.getByText("People", { exact: true }).click();
  await expect(table.getByLabel("People")).toBeChecked();
  await expectNoA11yViolations(page);
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    new RegExp(`^insights-people-${weekFrom}_${weekTo}-\\d{4}-\\d{2}-\\d{2}\\.csv$`),
  );
  const lines = (await readFile((await file.path()) ?? "", "utf8")).split("\r\n");
  expect(lines[0]).toMatch(/^Person,Worked \(h\),Scheduled \(h\),Leave \(h\),Shift days,On time,/);
  expect(lines.some((l) => l.startsWith("Erin Employee,"))).toBe(true);

  const admin = await clientFor(ADMIN_EMAIL);
  const { data, error } = await admin
    .from("audit_log")
    .select("metadata")
    .eq("action", "export.created")
    .eq("actor_id", MAX)
    .gte("at", since);
  if (error) throw error;
  const row = data
    .map((r) => r.metadata as Record<string, unknown>)
    .find((m) => m.page === "insights-people");
  expect(row).toMatchObject({ format: "csv", row_count: lines.length - 2 });
});

test("an employee reads their own insights in My data", async ({ page }) => {
  await signIn(page, ERIN_EMAIL, /\/me$/);
  const views = page.getByRole("navigation", { name: "My data views" });
  await views.getByRole("link", { name: "My insights" }).click();
  await expect(page).toHaveURL(/\/me\?view=insights$/);
  await expect(views.getByRole("link", { name: "My insights" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  const erin = await clientFor(ERIN_EMAIL);
  const own = await erin.rpc("report_rows", { p_from: weekFrom, p_to: weekTo, p_user_ids: [ERIN] });
  if (own.error) throw own.error;
  const mine = (own.data as { rows: Record<string, number>[] }).rows[0];
  // Erin's week is her own (Los Angeles) calendar; compare on the range the page shows.
  const from = await page.getByLabel("From", { exact: true }).inputValue();
  if (from === weekFrom) {
    await expect(tile(page, "Time totals", "Worked")).toHaveText(
      duration(Number(mine?.worked_s ?? 0)),
    );
  }
  for (const name of ["Attendance", "Presence", "Time", "Projects", "Needs review"]) {
    await expect(page.getByRole("heading", { name, level: 2, exact: true })).toBeVisible();
  }
  // Only her own numbers: no people table, no team table.
  await expect(page.getByRole("heading", { name: "People", level: 2 })).toHaveCount(0);
  await expectNoA11yViolations(page);

  // Back to the day.
  await views.getByRole("link", { name: "My day" }).click();
  await expect(page).toHaveURL(/\/me$/);
});

test("the weekly insights email is off until a manager turns it on", async ({ page }) => {
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/alerts");
  const toggle = page.getByRole("checkbox", { name: "Weekly insights email" });
  await expect(toggle).toBeEnabled();
  const before = await toggle.isChecked();
  await toggle.setChecked(!before);
  await expect(toggle).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Weekly insights email" })).toBeChecked({
    checked: !before,
  });
  await page.getByRole("checkbox", { name: "Weekly insights email" }).setChecked(before);
  await expect(page.getByRole("checkbox", { name: "Weekly insights email" })).toBeEnabled();
  await expectNoA11yViolations(page);
});
