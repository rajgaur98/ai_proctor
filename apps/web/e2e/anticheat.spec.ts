import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { DateTime } from "luxon";
import { agentFor, clientFor } from "./agent";

const ERIN = "00000000-0000-4000-8000-0000000000c1";

test("a manager sees an injected-click flag as needs review and marks it reviewed", async ({
  page,
}) => {
  // A day long past and picked at random, so a repeat run (the flag is one row per
  // person, day and kind, and stays reviewed) always starts from a fresh flag.
  const daysAgo = 100 + Math.floor(Math.random() * 2900);
  const at = DateTime.now().minus({ days: daysAgo }).set({ hour: 11, minute: 0, second: 0 });
  const date = at.setZone("America/Los_Angeles").toISODate() ?? "";
  const iso = (minutes: number) => at.plus({ minutes }).toUTC().toISO() ?? "";

  const erin = await agentFor("erin@acme.test");
  await erin("clock_out", { reason: "manual" });
  await erin("clock_in", { reason: "manual" });
  // The Windows agent reports the clicks it blocked as a flag on the check-in (ANT-02).
  await erin("checkin", {
    scheduled_at: iso(0),
    shown_at: iso(0),
    responded_at: iso(0.1),
    outcome: "pass",
    response_ms: 4200,
    wrong_clicks: 0,
    object_keys: [],
    flags: ["injected_click:3"],
  });
  await erin("checkin", {
    scheduled_at: iso(30),
    shown_at: iso(30),
    responded_at: iso(30.1),
    outcome: "pass",
    response_ms: 6100,
    wrong_clicks: 0,
    object_keys: [],
    flags: [],
  });

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("manager@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  await page.goto(`/team/${ERIN}?date=${date}`);

  await expect(page.getByRole("heading", { name: "Erin Employee" })).toBeVisible();
  const panel = page.getByRole("region", { name: "Needs review" });
  await expect(panel).toContainText("Check-in clicks from another program");
  await expect(panel).toContainText("3 clicks on the card didn't come from a mouse or trackpad");
  await expect(panel).toContainText("don't change status, hours or the timesheet");

  // Only the affected check-in carries the badge.
  const list = page.getByRole("region", { name: "Check-ins" });
  await expect(list.getByText("Needs review")).toHaveCount(1);
  await expect(
    list.getByRole("button", { name: /Passed/ }).filter({ hasText: "Needs review" }),
  ).toHaveCount(1);
  // The day carries one too, next to the name.
  await expect(page.getByText("Needs review", { exact: true })).toHaveCount(3);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await panel.getByRole("button", { name: /^Mark reviewed/ }).click();
  await panel.getByLabel("Note (optional)").fill("Talked to Erin, remote desktop tool");
  await panel.getByRole("button", { name: "Save review" }).click();

  await expect(panel).toContainText("Reviewed by");
  await expect(panel).toContainText("Talked to Erin, remote desktop tool");
  await expect(panel.getByRole("button", { name: /^Mark reviewed/ })).toHaveCount(0);
  // Reviewed: nothing left waiting on the day or on the check-in.
  await expect(list.getByText("Needs review")).toHaveCount(0);
  await expect(page.getByText("Needs review", { exact: true })).toHaveCount(1);

  const after = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(after.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await erin("clock_out", { reason: "manual" });
});

test("the #63 flags show as needs review on the day and in reports", async ({ page }) => {
  // A day within the last year (a report spans at most a year), picked at random so a
  // repeat run starts from fresh flags.
  const daysAgo = 30 + Math.floor(Math.random() * 300);
  const at = DateTime.now().minus({ days: daysAgo }).set({ hour: 11, minute: 0, second: 0 });
  const date = at.setZone("America/Los_Angeles").toISODate() ?? "";
  const iso = (minutes: number) => at.plus({ minutes }).toUTC().toISO() ?? "";

  const erin = await agentFor("erin@acme.test");
  await erin("clock_out", { reason: "manual" });
  await erin("clock_in", { reason: "manual" });
  // What a macOS agent in a VM, screen-shared into, fed by OBS, would report (#63).
  await erin("checkin", {
    scheduled_at: iso(0),
    shown_at: iso(0),
    responded_at: iso(0.1),
    outcome: "pass",
    response_ms: 3900,
    wrong_clicks: 0,
    object_keys: [],
    flags: [
      "virtual_machine",
      "remote_session",
      "synthetic_click:1",
      "virtual_camera:OBS Virtual Camera",
      "duplicate_frame:0",
    ],
  });

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("manager@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  await page.goto(`/team/${ERIN}?date=${date}`);

  await expect(page.getByRole("heading", { name: "Erin Employee" })).toBeVisible();
  const panel = page.getByRole("region", { name: "Needs review" });
  for (const title of [
    "Running in a virtual machine",
    "Remote session",
    "Check-in clicks that looked automated",
    "Webcam was a virtual camera",
    "Webcam images look the same",
  ]) {
    await expect(panel.getByRole("heading", { name: title })).toBeVisible();
  }
  await expect(panel).toContainText("The webcam image came from OBS Virtual Camera");
  await expect(panel).toContainText("The check-in counted as usual.");
  // The check-in is still a pass, with the badge.
  const list = page.getByRole("region", { name: "Check-ins" });
  await expect(
    list.getByRole("button", { name: /Passed/ }).filter({ hasText: "Needs review" }),
  ).toHaveCount(1);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Reports: the day's flags nobody has reviewed yet (DSH-08).
  const manager = await clientFor("manager@acme.test");
  const { count, error } = await manager
    .from("anticheat_flags")
    .select("id", { count: "exact", head: true })
    .eq("user_id", ERIN)
    .eq("day", date)
    .is("reviewed_at", null);
  if (error) throw error;
  expect(count).toBeGreaterThanOrEqual(5);

  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await page.getByLabel("From", { exact: true }).fill(date);
  await page.getByLabel("To", { exact: true }).fill(date);
  const header = page.getByRole("columnheader", { name: "Needs review" });
  await expect(header).toBeVisible();
  const column = await page
    .getByRole("columnheader")
    .evaluateAll(
      (cells, name) => cells.findIndex((c) => c.textContent?.includes(name)),
      "Needs review",
    );
  const erinRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "Erin Employee" }) });
  // Cells after the row header: the column's index less the Person column.
  await expect(erinRow.getByRole("cell").nth(column - 1)).toHaveText(String(count));
  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "descending");

  const after = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(after.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await erin("clock_out", { reason: "manual" });
});
