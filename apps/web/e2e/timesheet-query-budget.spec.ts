// #267 (#254 part 8, NFR-PERF-03): a query budget for opening a week. Counts the calls to the
// Supabase REST API (tables and RPCs under /rest/v1/) from navigating to a week until the
// page has settled, for Erin on her own week and for her manager reviewing it, and fails when
// either goes over its budget or sends the same request twice. The week has entries on
// several days and comments on them, so a read per day, entry or thread would show. Rebuilding
// the week (one Edge Function call per day, LLD section 6) isn't counted: it isn't REST.
// Order-independent: the week is one nobody has touched, picked per run.
import { expect, type Page, type Request, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import { ERIN, ERIN_EMAIL, ERIN_ZONE, freshErinWeek, MANAGER_EMAIL, weekDays } from "./helpers";

// Measured on 1 Nov 2026 (#267) on a week with three manual entries on three days, comments on
// two of them and no flagged time: Erin's own week made 19 calls (2 of them the app shell's, her
// profile and notifications) and the manager's review 21 (his shell also reads alerts, and the
// review reads the week's misses). Each budget is that plus 2, so a new read is a deliberate
// change here rather than a slow creep.
const OWN_WEEK_BUDGET = 21;
const MANAGER_WEEK_BUDGET = 23;

const REVAMP = "00000000-0000-4000-8000-0000000000f1";
const INTERNAL = "00000000-0000-4000-8000-0000000000f2";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/** "GET /rest/v1/…" or "POST /rest/v1/rpc/… {body}": what makes two requests the same. */
const describe = (r: Request) => {
  const url = new URL(r.url());
  return `${r.method()} ${decodeURIComponent(url.pathname + url.search)}${r.postData() ? ` ${r.postData()}` : ""}`;
};

/**
 * Opens the week with a full page load and returns every REST request it made, once the
 * entries and their threads are shown and no request has started for a second.
 */
async function loadWeek(page: Page, week: string, entryNote: string): Promise<string[]> {
  const seen: string[] = [];
  const onRequest = (r: Request) => {
    if (new URL(r.url()).pathname.startsWith("/rest/v1/")) seen.push(describe(r));
  };
  page.on("request", onRequest);
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  const days = page.getByRole("region", { name: "Days", exact: true });
  await expect(days.getByRole("listitem").filter({ hasText: entryNote })).toHaveCount(3, {
    timeout: 20_000,
  });
  await expect(days.getByRole("button", { name: /^Comments on .* \(1\)$/ })).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Totals" })).not.toContainText("Loading");
  await page.waitForLoadState("networkidle");
  // Settled: no new request for a whole second (a late read would still be counted).
  for (let count = -1; count !== seen.length; ) {
    count = seen.length;
    await page.waitForTimeout(1000);
  }
  page.off("request", onRequest);
  return seen;
}

function expectWithinBudget(requests: string[], budget: number) {
  const repeated = requests.filter((r, i) => requests.indexOf(r) !== i);
  expect(repeated, `the same request twice:\n${requests.join("\n")}`).toEqual([]);
  expect(
    requests.length,
    `${requests.length} REST calls, budget ${budget}:\n${requests.join("\n")}`,
  ).toBeLessThanOrEqual(budget);
}

test("week page: loading a week stays within its query budget, without repeats", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const week = await freshErinWeek();
  const days = weekDays(week);
  const at = (d: string | undefined, t: string) =>
    DateTime.fromISO(`${d}T${t}`, { zone: ERIN_ZONE }).toISO() ?? "";
  const note = `Budget ${Date.now()}`;

  // Three entries on three days, and a comment on two of them.
  const erin = await clientFor(ERIN_EMAIL);
  const ids: string[] = [];
  for (const [d, start, end, project] of [
    [days[0], "10:00", "12:00", REVAMP],
    [days[1], "09:00", "10:00", INTERNAL],
    [days[2], "13:00", "14:00", null],
  ] as const) {
    const r = await erin.rpc("request_manual_entry", {
      p_start_at: at(d, start),
      p_end_at: at(d, end),
      p_project_id: project as string,
      p_reason: "Offsite",
      p_note: note,
    });
    if (r.error) throw r.error;
    ids.push(r.data);
  }
  const sheet = await erin.rpc("ensure_timesheet", { p_user_id: ERIN, p_period_start: week });
  if (sheet.error) throw sheet.error;
  for (const id of ids.slice(0, 2)) {
    const r = await erin.rpc("add_timesheet_comment", {
      p_timesheet_id: sheet.data,
      p_body: "Workshop with the client",
      p_manual_entry_id: id,
    });
    if (r.error) throw r.error;
  }

  // Each view in its own browser context: a cold start, as when the page is opened.
  const ownContext = await browser.newContext();
  const own = await ownContext.newPage();
  await signIn(own, ERIN_EMAIL, /\/me$/);
  const ownRequests = await loadWeek(own, week, note);
  await ownContext.close();

  const managerContext = await browser.newContext();
  const manager = await managerContext.newPage();
  await signIn(manager, MANAGER_EMAIL, /\/team$/);
  const managerRequests = await loadWeek(manager, week, note);
  await managerContext.close();

  test.info().annotations.push({
    type: "rest-calls",
    description: `own week ${ownRequests.length}, manager ${managerRequests.length}`,
  });
  expectWithinBudget(ownRequests, OWN_WEEK_BUDGET);
  expectWithinBudget(managerRequests, MANAGER_WEEK_BUDGET);
});
