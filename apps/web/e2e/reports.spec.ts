import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import { ERIN, ERIN_EMAIL, expectNoA11yViolations, flaggedTime, MANAGER_EMAIL } from "./helpers";

const LUCAS = "00000000-0000-4000-8000-0000000000c2";
const ADMIN_EMAIL = "admin@acme.test";

/** The Monday-based week the page opens on, from the manager's calendar (Chicago). */
const today = DateTime.now().setZone("America/Chicago");
const weekStart = today.startOf("week");
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

async function body(page: Page) {
  const rows = page.getByRole("table").locator("tbody tr");
  return rows;
}

test("a manager reads the week's report and it matches the timesheet totals, sorted by any column", async ({
  page,
}) => {
  // Erin's week has worked and flagged time.
  await flaggedTime();
  const manager = await clientFor(MANAGER_EMAIL);
  const { data: totalRows, error } = await manager.rpc("timesheet_totals", {
    p_from: weekFrom,
    p_to: weekTo,
  });
  if (error) throw error;
  const of = (id: string) =>
    (totalRows as { user_id: string; worked_s: number; flagged_s: number }[]).find(
      (t) => t.user_id === id,
    );
  expect(of(ERIN)?.worked_s ?? 0).toBeGreaterThan(0);

  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Reports" })
    .click();
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByRole("button", { name: "This week" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(weekFrom);
  await expect(page.getByLabel("To", { exact: true })).toHaveValue(weekTo);

  // A person's row carries their timesheet numbers; the viewer isn't in their own team.
  const erinRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "Erin Employee" }) });
  await expect(erinRow).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Max Manager" })).toHaveCount(0);
  const cells = erinRow.getByRole("cell");
  await expect(cells.nth(0)).toHaveText(duration(of(ERIN)?.worked_s ?? 0));
  await expect(cells.nth(1)).toHaveText(duration(of(ERIN)?.flagged_s ?? 0));

  // The team row and the summary add the same people up.
  const teamWorked = (of(ERIN)?.worked_s ?? 0) + (of(LUCAS)?.worked_s ?? 0);
  const teamFlagged = (of(ERIN)?.flagged_s ?? 0) + (of(LUCAS)?.flagged_s ?? 0);
  const team = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: /^Team \(/ }) });
  await expect(team.getByRole("cell").nth(0)).toHaveText(duration(teamWorked));
  await expect(team.getByRole("cell").nth(1)).toHaveText(duration(teamFlagged));
  const summary = page
    .getByRole("term")
    .filter({ hasText: /^Worked$/ })
    .locator("xpath=following-sibling::*[1]");
  await expect(summary).toHaveText(duration(teamWorked));

  // The charts are labelled images, and the page is accessible.
  await expect(page.getByRole("img", { name: /^Worked and flagged time\./ })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Check-in outcomes\./ })).toBeVisible();
  await expectNoA11yViolations(page);

  // Sorting: worked time, biggest first, then the other way. Ties keep name order.
  const worked = page.getByRole("columnheader", { name: /Worked/ });
  await expect(page.getByRole("columnheader", { name: /Person/ })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  const byWorked = [
    { name: "Erin Employee", s: of(ERIN)?.worked_s ?? 0 },
    { name: "Lucas Martin", s: of(LUCAS)?.worked_s ?? 0 },
  ];
  const desc = [...byWorked].sort((a, b) => b.s - a.s).map((p) => p.name);
  const asc = [...byWorked].sort((a, b) => a.s - b.s).map((p) => p.name);
  // Other specs may add people to the team (e.g. an invite with no time), so compare
  // the order of the two seeded people rather than the first row.
  const rows = await body(page);
  const seededOrder = async () =>
    (await rows.getByRole("rowheader").allTextContents())
      .map((t) => t.trim())
      .filter((t) => t === "Erin Employee" || t === "Lucas Martin");
  await worked.getByRole("button").click();
  await expect(worked).toHaveAttribute("aria-sort", "descending");
  await expect.poll(seededOrder).toEqual(desc);
  await worked.getByRole("button").click();
  await expect(worked).toHaveAttribute("aria-sort", "ascending");
  await expect.poll(seededOrder).toEqual(asc);
  await expectNoA11yViolations(page);

  // Every metric has a sortable column.
  for (const name of [
    "Flagged",
    "Check-ins shown",
    "Passed",
    "Missed",
    "Failed",
    "Response rate",
    "Median response",
    "Breaks",
    "Pauses",
    "Late clock-ins",
  ]) {
    const header = page.getByRole("columnheader", { name });
    await header.getByRole("button").click();
    await expect(header).toHaveAttribute("aria-sort", /ascending|descending/);
  }
});

test("a manager changes the range and the team", async ({ page }) => {
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();

  const lastFrom = weekStart.minus({ weeks: 1 }).toISODate() ?? "";
  await page.getByRole("button", { name: "Last week" }).click();
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(lastFrom);
  await expect(page.getByLabel("To", { exact: true })).toHaveValue(
    weekStart.minus({ days: 1 }).toISODate() ?? "",
  );
  await expect(page.getByRole("button", { name: "Last week" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: "This month" }).click();
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(
    today.startOf("month").toISODate() ?? "",
  );
  await expect(page.getByLabel("To", { exact: true })).toHaveValue(
    today.endOf("month").toISODate() ?? "",
  );

  // A typed range is no preset; one that ends before it starts is explained.
  await page.getByLabel("From", { exact: true }).fill("2026-03-22");
  await page.getByLabel("To", { exact: true }).fill("2026-03-16");
  await expect(page.getByRole("alert")).toContainText("same or later");
  await expect(page.getByRole("button", { name: "This month" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expectNoA11yViolations(page);
  await page.getByLabel("From", { exact: true }).fill("2026-03-16");
  await page.getByLabel("To", { exact: true }).fill("2026-03-22");
  await expect(page.getByRole("rowheader", { name: "Erin Employee" })).toBeVisible();

  // The team filter: Max's team is his reports; someone with no reports isn't offered.
  const team = page.getByLabel("Team", { exact: true });
  await expect(team.getByRole("option")).toHaveText(["Everyone I can see", "Max Manager's team"]);
  await team.selectOption({ label: "Max Manager's team" });
  await expect(page.getByRole("rowheader", { name: "Erin Employee" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Lucas Martin" })).toBeVisible();
});

test("an admin sees the whole org's teams, and an employee has no Reports page", async ({
  page,
}) => {
  await signIn(page, ADMIN_EMAIL, /\/team$/);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Max Manager" })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Ada Admin" })).toHaveCount(0);
  const team = page.getByLabel("Team", { exact: true });
  await expect(team.getByRole("option", { name: "Ada Admin's team" })).toHaveCount(1);
  await team.selectOption({ label: "Max Manager's team" });
  await expect(page.getByRole("rowheader", { name: "Max Manager" })).toHaveCount(0);
  await expect(page.getByRole("rowheader", { name: "Erin Employee" })).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByLabel(/Account menu for/).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await signIn(page, ERIN_EMAIL, /\/me$/);
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reports" }),
  ).toHaveCount(0);
  await page.goto("/reports");
  await expect(page).toHaveURL(/\/me$/);
});

/**
 * A 120-person report as `report_rows` returns it, served to the page in place of the real
 * call: seeding more than a page of people into the shared e2e org would change every
 * other spec's data. Person 001 to 120; person n worked n minutes, so the biggest is last
 * by name and first by worked time.
 */
const BIG_TEAM = 120;
async function serveBigReport(page: Page) {
  const rows = Array.from({ length: BIG_TEAM }, (_, i) => {
    const n = i + 1;
    return {
      user_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      full_name: `Person ${String(n).padStart(3, "0")}`,
      manager_id: null,
      worked_s: n * 60,
      flagged_s: 0,
      excluded_s: 0,
      break_s: 0,
      pause_s: 0,
      manual_s: 0,
      checkins_shown: 0,
      checkins_passed: 0,
      checkins_missed: 0,
      checkins_failed: 0,
      response_rate: null,
      median_response_ms: null,
      late_clock_ins: 0,
    };
  });
  await page.route("**/rest/v1/rpc/report_rows", (route) =>
    route.fulfill({
      json: {
        row_count: rows.length,
        late_grace_min: 15,
        team_median_response_ms: null,
        rows,
      },
    }),
  );
}

test("a long report is paged, sorts over every row and keeps the team row", async ({ page }) => {
  await serveBigReport(page);
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();

  const names = async () =>
    (await page.getByRole("table").locator("tbody").getByRole("rowheader").allTextContents()).map(
      (t) => t.trim(),
    );
  const pager = page.getByRole("navigation", { name: "Report pages" });
  const previous = pager.getByRole("button", { name: "Previous" });
  const next = pager.getByRole("button", { name: "Next" });

  // 50 to a page, by name; the team row is everyone's, not the page's.
  await expect(pager.getByText("Showing 1 to 50 of 120 people")).toBeVisible();
  await expect(pager.getByText("Page 1 of 3")).toBeVisible();
  expect(await names()).toHaveLength(50);
  expect((await names())[0]).toBe("Person 001");
  expect((await names())[49]).toBe("Person 050");
  await expect(previous).toBeDisabled();
  const teamRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: `Team (${BIG_TEAM})` }) });
  // 60 s * (1 + ... + 120) = 435 600 s
  await expect(teamRow.getByRole("cell").nth(0)).toHaveText(duration(435_600));

  // Charts show the first rows of the table's order, and say so.
  await expect(page.getByText("Showing 25 of 120 by person, A to Z")).toHaveCount(2);

  await expectNoA11yViolations(page);

  await next.click();
  await expect(pager.getByText("Showing 51 to 100 of 120 people")).toBeVisible();
  expect((await names())[0]).toBe("Person 051");
  await expect(previous).toBeEnabled();
  await next.click();
  await expect(pager.getByText("Showing 101 to 120 of 120 people")).toBeVisible();
  expect(await names()).toHaveLength(20);
  await expect(next).toBeDisabled();
  await expect(teamRow.getByRole("cell").nth(0)).toHaveText(duration(435_600));

  // Sorting is over all 120 people, not the page, and goes back to the first page.
  await page
    .getByRole("columnheader", { name: /Worked/ })
    .getByRole("button")
    .click();
  await expect(pager.getByText("Showing 1 to 50 of 120 people")).toBeVisible();
  expect((await names())[0]).toBe("Person 120");
  expect((await names())[49]).toBe("Person 071");
  await expect(page.getByText("Showing 25 of 120 by worked, highest first")).toHaveCount(2);
  await expect(teamRow.getByRole("cell").nth(0)).toHaveText(duration(435_600));

  // A bigger page.
  await pager.getByLabel("Rows per page").selectOption("100");
  await expect(pager.getByText("Showing 1 to 100 of 120 people")).toBeVisible();
  await expect(pager.getByText("Page 1 of 2")).toBeVisible();
  expect(await names()).toHaveLength(100);
  await expectNoA11yViolations(page);
});

test("a report over the ceiling asks to narrow it down", async ({ page }) => {
  await page.route("**/rest/v1/rpc/report_rows", (route) =>
    route.fulfill({
      status: 400,
      json: { code: "54000", details: null, hint: null, message: "too_many_people" },
    }),
  );
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/reports");
  await expect(page.getByRole("alert")).toContainText("Choose a team to narrow it down");
  await expectNoA11yViolations(page);
});
