import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { agentFor, asEmployee, clientFor } from "./agent";

// The day page follows the Claude Design DayView screen (#124): totals, the bar of
// segments, the selected check-in on the left, the list on the right. The day is built
// from backdated events (the server takes up to 7 days back), so the numbers are exact.
// Lucas has no timesheet in these specs, so the flagged time doesn't touch them.
const ZONE = "America/Chicago";
const LUCAS = "00000000-0000-4000-8000-0000000000c2";
// Times are read in the viewer's zone; make it Lucas's.
test.use({ timezoneId: ZONE });

const today = DateTime.now().setZone(ZONE).startOf("day");
// Set by the first test step: a recent day with no check-ins yet, so a re-run on the
// same database doesn't clock Lucas in twice (reset the stack after six local runs).
let day: DateTime = today.minus({ days: 1 });
let date = "";
let week = "";
const at = (hhmm: string, seconds = 0) =>
  day.set({ hour: Number(hhmm.slice(0, 2)), minute: Number(hhmm.slice(3, 5)), second: seconds });

async function freeDay(): Promise<DateTime> {
  const manager = await clientFor("manager@acme.test");
  for (let back = 1; back <= 6; back++) {
    const d = today.minus({ days: back });
    const { count, error } = await manager
      .from("checkin_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", LUCAS)
      .gte("scheduled_at", d.toUTC().toISO())
      .lt("scheduled_at", d.plus({ days: 1 }).toUTC().toISO());
    if (error) throw error;
    if (count === 0) return d;
  }
  throw new Error("Every recent day already has check-ins: run scripts/stack.sh reset");
}

async function seedDay() {
  const erin = await agentFor("lucas@acme.test");
  const send = (type: string, when: DateTime, payload: Record<string, unknown> = {}) =>
    erin(type, payload, crypto.randomUUID(), when.toJSDate().toISOString());
  const checkin = (payload: Record<string, unknown>, shown: DateTime, id = crypto.randomUUID()) =>
    erin(
      "checkin",
      { wrong_clicks: 0, object_keys: [], flags: [], ...payload },
      id,
      shown.toJSDate().toISOString(),
    );

  // Off shift first: a backdated clock-in is refused while Lucas is still clocked in
  // (a spec that failed before its own clock-out leaves him so).
  await erin("clock_out", { reason: "manual" });
  await send("clock_in", at("09:00"), { reason: "manual" });
  await checkin(
    {
      scheduled_at: at("09:40").toISO(),
      shown_at: at("09:40").toISO(),
      responded_at: at("09:40", 2).toISO(),
      outcome: "pass",
      response_ms: 1800,
    },
    at("09:40", 2),
  );
  await send("call_start", at("10:00"), { source: "camera" });
  await send("call_end", at("10:45"), { source: "camera" });
  await send("break_start", at("12:00"), {});
  await send("break_end", at("12:45"), {});
  await send("pause_start", at("13:00"), { planned_min: 15 });
  await send("pause_end", at("13:15"), {});
  const missId = crypto.randomUUID();
  await checkin(
    {
      scheduled_at: at("14:03").toISO(),
      shown_at: at("14:03", 12).toISO(),
      outcome: "miss",
      idle_s_at_show: 660,
      device_state: "locked",
    },
    at("14:04", 42),
    missId,
  );
  await checkin(
    {
      scheduled_at: at("14:58").toISO(),
      shown_at: at("14:58").toISO(),
      responded_at: at("14:58", 3).toISO(),
      outcome: "pass",
      response_ms: 2400,
    },
    at("14:58", 3),
  );
  await checkin(
    { scheduled_at: at("15:10").toISO(), outcome: "deferred", deferral_reason: "call" },
    at("15:10"),
  );
  await send("clock_out", at("15:30"), { reason: "manual" });
  await asEmployee("lucas@acme.test", (db) =>
    db.rpc("set_miss_reason", {
      p_checkin_id: missId,
      p_kind: "phone_call",
      p_note: "Client call",
    }),
  );
}

async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("a manager reads a seeded day: totals, the bar, a pass, a miss, the neighbouring days and the timesheet", async ({
  page,
}) => {
  day = await freeDay();
  date = day.toISODate() ?? "";
  week = day.startOf("week").toISODate() ?? "";
  await seedDay();
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("manager@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  await page.goto(`/team/${LUCAS}?date=${date}`);

  // Header: breadcrumb, name, date, shift and role, day links, timesheet.
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Live team");
  await expect(page.getByRole("heading", { name: "Lucas Martin" })).toBeVisible();
  await expect(page.getByText(`${day.toFormat("ccc d LLL")} ·`)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Previous day/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Next day/ })).toBeEnabled();

  // The five totals come from time_segments.
  const totals = page.getByRole("region", { name: "Totals for the day" });
  await expect(totals).toBeVisible({ timeout: 20_000 });
  // 09:00-15:30 clocked: minus a 45 min break, a 15 min pause and 54 min 48 s unverified.
  await expect(totals).toContainText("4 h 35 min");
  await expect(totals).toContainText("unverified 55 min");
  await expect(totals).toContainText("15 min");
  await expect(totals).toContainText("2 of 3");
  await expect(totals).toContainText("1 missed · 1 deferred");
  await expect(totals).toContainText("Break");
  await expect(totals).toContainText("12:00–12:45");
  await expect(totals).toContainText("incl. 45 min in meetings");
  await expect(totals).toContainText("1 pause");
  await expect(totals).toContainText("unverified");
  await expect(page.getByRole("img", { name: /Time over the day: .*Verified/ })).toBeVisible();

  // The latest check-in is open; the list and the markers pick another and the line moves.
  const line = page.getByTestId("selected-line");
  const list = page.getByRole("region", { name: "Check-ins" });
  await expect(list).toContainText("2 of 3 passed");
  const lineAt = async () => (await line.boundingBox())?.x ?? -1;
  const deferredX = await lineAt();
  await list.getByRole("button", { name: /14:58 Passed in 2 s/ }).click();
  const passX = await lineAt();
  expect(passX).toBeLessThan(deferredX);
  const pass = page.getByRole("region", { name: "Check-in · 14:58" });
  await expect(pass).toContainText("Passed · 2.4 s");
  await expect(pass).toContainText("14:58:00");
  await expect(pass).toContainText("Answered in");
  await expect(pass).toContainText("Unassigned");
  await expect(pass).toContainText("No screenshot");
  await expectNoA11yViolations(page);

  await page.getByRole("button", { name: "Missed check-in at 14:03" }).click();
  const missX = await lineAt();
  expect(missX).toBeLessThan(passX);
  const miss = page.getByRole("region", { name: "Missed check-in · 14:03" });
  await expect(miss).toContainText("14:03:12");
  await expect(miss).toContainText("90 s · no answer");
  await expect(miss).toContainText("11 min");
  await expect(miss).toContainText("since 13:52");
  await expect(miss).toContainText("Locked");
  await expect(miss).toContainText("Phone call");
  await expect(miss).toContainText("“Client call”");
  await expect(miss).toContainText("only taken when a check-in is passed");
  await expectNoA11yViolations(page);

  await miss.getByRole("link", { name: "Review in timesheet →" }).click();
  await expect(page).toHaveURL(new RegExp(`/timesheets/${LUCAS}\\?week=${week}`));
  await page.goBack();

  // Neighbouring days, and the person's timesheet week.
  await page.getByRole("button", { name: /^Previous day/ }).click();
  await expect(page).toHaveURL(new RegExp(`date=${day.minus({ days: 1 }).toISODate()}`));
  await page.getByRole("button", { name: /^Next day/ }).click();
  await expect(page).toHaveURL(new RegExp(`date=${date}`));
  await page.getByRole("link", { name: "Open timesheet" }).click();
  await expect(page).toHaveURL(new RegExp(`/timesheets/${LUCAS}\\?week=${week}`));
});
