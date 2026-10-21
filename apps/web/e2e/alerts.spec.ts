import { expect, test } from "@playwright/test";
import { agentFor, clientFor } from "./agent";
import { expectNoA11yViolations } from "./helpers";

const MAX = "00000000-0000-4000-8000-0000000000b1";
const LUCAS = "00000000-0000-4000-8000-0000000000c2";

/** A fresh shift, then three misses in a row: what alert_eval raises "N consecutive misses" for. */
async function threeMisses(email: string) {
  const agent = await agentFor(email);
  await agent("clock_out", { reason: "manual" });
  await agent("clock_in", { reason: "manual" });
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 1100));
    const at = new Date().toISOString();
    await agent("checkin", {
      scheduled_at: at,
      shown_at: at,
      outcome: "miss",
      wrong_clicks: 0,
      idle_s_at_show: 420,
      device_state: "active",
      object_keys: [],
      flags: [],
    });
  }
  return agent;
}

test("new alerts reach the bell without a reload, and the alerts page lists, filters and clears them", async ({
  page,
}) => {
  // alert_eval is a pg_cron job that runs once a minute.
  test.setTimeout(200_000);

  // Start with nothing unread for Max.
  const max = await clientFor("manager@acme.test");
  const cleared = await max.rpc("mark_alerts_read");
  expect(cleared.error).toBeNull();

  // The same job can raise alerts for what earlier specs left (tamper-reason.spec's
  // Tamper, up to a minute later), so the bell is checked against Max's alerts as they
  // are, by its own rule (the unread among his latest 30), rather than a fixed count.
  const expectedBell = async () => {
    const { data, error } = await max
      .from("alerts")
      .select("read_at")
      .eq("recipient_id", MAX)
      .order("triggered_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    const n = data.filter((a) => a.read_at === null).length;
    return n > 0 ? `Alerts, ${n} unread` : "Alerts";
  };
  /** Max's unread alerts for Lucas's missed check-ins: the ones this test raises. */
  const lucasUnread = async () => {
    const { count, error } = await max
      .from("alerts")
      .select("id", { count: "exact", head: true })
      .eq("recipient_id", MAX)
      .eq("user_id", LUCAS)
      .eq("kind", "consecutive_misses")
      .is("read_at", null);
    if (error) throw error;
    return count ?? 0;
  };

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("manager@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  const bell = page.getByRole("button", { name: /^Alerts(, \d+ unread)?$/ });
  const bellIsCurrent = () =>
    expect
      .poll(async () => (await bell.getAttribute("aria-label")) === (await expectedBell()), {
        timeout: 15_000,
      })
      .toBe(true);
  await bellIsCurrent();
  // A reload would lose this: the alerts below must arrive in the open page.
  await page.evaluate(() => {
    (window as unknown as { openPage: boolean }).openPage = true;
  });

  // Lucas's agent, with the page already open. A second shift of misses raises a second
  // alert (one per episode); alert_eval only looks at the latest shift, so wait in between.
  await threeMisses("lucas@acme.test");
  await expect.poll(lucasUnread, { timeout: 100_000 }).toBe(1);
  await bellIsCurrent();
  expect(await page.evaluate(() => (window as unknown as { openPage?: boolean }).openPage)).toBe(
    true,
  );
  const lucas = await threeMisses("lucas@acme.test");
  await expect.poll(lucasUnread, { timeout: 100_000 }).toBe(2);
  await bellIsCurrent();

  // The bell: both unread, marking one read.
  await bell.click();
  const panel = page.getByRole("region", { name: "Alerts" });
  const unreadItems = panel
    .getByRole("listitem")
    .filter({ hasText: "Lucas Martin" })
    .filter({ hasText: "3 missed check-ins in a row" })
    .filter({ has: page.getByRole("button", { name: /^Mark read/ }) });
  await expect(unreadItems).toHaveCount(2);

  await expectNoA11yViolations(page);

  await unreadItems
    .first()
    .getByRole("button", { name: /^Mark read/ })
    .click();
  await expect(unreadItems).toHaveCount(1);
  await bellIsCurrent();

  // See all: the history page.
  await panel.getByRole("link", { name: "See all alerts" }).click();
  await expect(page).toHaveURL(/\/alerts$/);
  await expect(page.getByRole("heading", { name: "Alerts", level: 1 })).toBeVisible();
  const history = page.getByRole("region", { name: "Alert history" });
  const row = (name: string) =>
    history
      .getByRole("listitem")
      .filter({ hasText: name })
      .filter({ hasText: "3 missed check-ins in a row" });
  const unreadRow = (name: string) =>
    row(name).filter({ has: page.getByRole("button", { name: /^Mark read/ }) });
  await expect(row("Lucas Martin").first()).toBeVisible();
  await expect(unreadRow("Lucas Martin")).toHaveCount(1);

  await expectNoA11yViolations(page);

  const filter = (label: string) => page.getByLabel(label, { exact: true });

  // Read / unread.
  await filter("Status").selectOption("unread");
  await expect(unreadRow("Lucas Martin")).toHaveCount(1);
  await expect(row("Lucas Martin")).toHaveCount(1);
  await filter("Status").selectOption("read");
  await expect(row("Lucas Martin").first()).toBeVisible();
  await expect(unreadRow("Lucas Martin")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark all matching read" })).toBeDisabled();
  await filter("Status").selectOption("all");

  // Kind.
  await filter("Kind").selectOption({ label: "Tamper" });
  await expect(history.getByRole("listitem").filter({ hasText: "3 missed" })).toHaveCount(0);
  await filter("Kind").selectOption({ label: "Missed check-ins" });
  await expect(row("Lucas Martin").first()).toBeVisible();

  // Employee.
  await filter("Employee").selectOption({ label: "Erin Employee" });
  await expect(row("Lucas Martin")).toHaveCount(0);
  await filter("Employee").selectOption({ label: "Lucas Martin" });
  await expect(row("Lucas Martin").first()).toBeVisible();

  // Dates: a range that starts tomorrow has nothing; today's holds the alerts.
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA");
  await filter("From").fill(day(1));
  await expect(page.getByText("No alerts match")).toBeVisible();
  await filter("From").fill(day(0));
  await filter("To").fill(day(0));
  await expect(row("Lucas Martin").first()).toBeVisible();

  // Clearing the filters brings everyone back.
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(filter("Employee")).toHaveValue("");
  await expect(filter("Kind")).toHaveValue("");

  // Mark everything the filters match, not only what is loaded; the bell follows.
  await filter("Employee").selectOption({ label: "Lucas Martin" });
  await filter("Kind").selectOption({ label: "Missed check-ins" });
  await page.getByRole("button", { name: "Mark all matching read" }).click();
  await expect(unreadRow("Lucas Martin")).toHaveCount(0);
  await bellIsCurrent();

  // An alert links to that employee's day, on the day it was raised.
  await row("Lucas Martin").first().getByRole("link").click();
  await expect(page).toHaveURL(
    /\/team\/00000000-0000-4000-8000-0000000000c2\?date=\d{4}-\d{2}-\d{2}$/,
  );
  await expect(page.getByRole("heading", { name: "Lucas Martin" })).toBeVisible();

  await lucas("clock_out", { reason: "manual" });
});

test("an employee has no alerts bell", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("erin@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/me$/, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: /^Alerts/ })).toHaveCount(0);
  await expectNoA11yViolations(page);
});
