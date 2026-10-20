import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { agentFor, clientFor } from "./agent";

test("a manager sees an alert for three missed check-ins and marks it read", async ({ page }) => {
  // alert_eval is a pg_cron job that runs once a minute, and the list refetches every 15 s.
  test.setTimeout(150_000);

  // Start with nothing unread for Max.
  const max = await clientFor("manager@acme.test");
  const cleared = await max.rpc("mark_alerts_read");
  expect(cleared.error).toBeNull();

  // Lucas's agent: a fresh shift, then three misses in a row.
  const lucas = await agentFor("lucas@acme.test");
  await lucas("clock_out", { reason: "manual" });
  await lucas("clock_in", { reason: "manual" });
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 1100));
    const at = new Date().toISOString();
    await lucas("checkin", {
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

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("manager@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });

  await page.getByRole("button", { name: /^Alerts/ }).click();
  const panel = page.getByRole("region", { name: "Alerts" });
  // Earlier runs leave read alerts in the list; this one is unread.
  const item = panel
    .getByRole("listitem")
    .filter({ hasText: "Lucas Martin" })
    .filter({ hasText: "3 missed check-ins in a row" })
    .filter({ has: page.getByRole("button", { name: /^Mark read/ }) });
  await expect(item).toHaveCount(1, { timeout: 100_000 });
  await expect(page.getByRole("button", { name: "Alerts, 1 unread" })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await item.getByRole("button", { name: /^Mark read/ }).click();
  await expect(page.getByRole("button", { name: "Alerts", exact: true })).toBeVisible();
  await expect(item).toHaveCount(0);

  // An alert links to Lucas's day.
  await panel
    .getByRole("listitem")
    .filter({ hasText: "3 missed check-ins in a row" })
    .first()
    .getByRole("link")
    .click();
  await expect(page).toHaveURL(/\/team\/00000000-0000-4000-8000-0000000000c2$/);
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
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
