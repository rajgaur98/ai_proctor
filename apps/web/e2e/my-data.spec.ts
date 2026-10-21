import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { agentFor, clientFor } from "./agent";
import { ERIN, erinToday, expectNoA11yViolations, rebuildSegments, timeAt } from "./helpers";

const org = "00000000-0000-4000-8000-000000000001";
// A 1×1 WebP.
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/**
 * Erin passes a check-in (screenshot uploaded) and misses one; her manager opens the capture.
 * Returns when each was shown, to find their rows among other specs' check-ins.
 */
async function seedErinDay(): Promise<{ missAt: string; passAt: string }> {
  const erin = await agentFor("erin@acme.test");
  await erin("clock_out", { reason: "manual" });
  await erin("clock_in", { reason: "manual" });
  const missAt = new Date(Date.now() - 20_000).toISOString();
  await erin("checkin", {
    scheduled_at: missAt,
    shown_at: missAt,
    outcome: "miss",
    wrong_clicks: 0,
    idle_s_at_show: 120,
    device_state: "active",
    object_keys: [],
    flags: [],
  });
  const checkinId = crypto.randomUUID();
  const at = new Date(Date.now() - 5_000).toISOString();
  await erin(
    "checkin",
    {
      scheduled_at: at,
      shown_at: at,
      responded_at: at,
      outcome: "pass",
      response_ms: 3000,
      wrong_clicks: 0,
      object_keys: ["screen-1.webp"],
      flags: [],
    },
    checkinId,
  );
  const uploader = await clientFor("erin@acme.test");
  const { error } = await uploader.storage
    .from("captures")
    .upload(`${org}/${ERIN}/${at.slice(0, 10)}/${checkinId}/screen-1.webp`, webp, {
      contentType: "image/webp",
    });
  expect(error).toBeNull();
  // A few seconds clocked in, so the day has worked time (a session under a second has none).
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await erin("clock_out", { reason: "manual" });

  const manager = await clientFor("manager@acme.test");
  const opened = await manager.functions.invoke("capture-url", { body: { checkin_id: checkinId } });
  expect(opened.error).toBeNull();
  // The day bar reads time segments; build today's now rather than waiting for the job.
  await rebuildSegments(ERIN, [erinToday()]);
  return { missAt, passAt: at };
}

test("an employee sees her day, check-ins and who viewed her captures; her own views stay out of it", async ({
  page,
}) => {
  const { missAt, passAt } = await seedErinDay();
  await signIn(page, "erin@acme.test", /\/me$/);

  await expect(page.getByRole("heading", { name: "My data", level: 1 })).toBeVisible();
  await expect(page.getByText(/Everything AI Proctor has collected about you/)).toContainText(
    "Max Manager (your manager)",
  );
  await expect(page.getByRole("button", { name: "Export my data" })).toBeVisible();

  // The day: a bar with a legend.
  const dayCard = page.getByRole("region", { name: /^Today/ });
  await expect(dayCard.getByRole("img", { name: /^Your day:/ })).toBeVisible();
  await expect(dayCard.getByText(/worked so far/)).toBeVisible();

  // A miss takes a reason (the #39 RPC).
  const misses = page.getByRole("region", { name: "Missed check-ins" });
  const miss = misses.getByRole("listitem").filter({ has: page.locator(timeAt(missAt)) });
  await expect(miss.getByText("Missed", { exact: true })).toBeVisible();
  const meeting = miss.getByRole("button", { name: "Meeting" });
  await meeting.click();
  await expect(meeting).toHaveAttribute("aria-pressed", "true");
  await expect(miss.getByText(/Reason: Meeting.* · visible to Max Manager/)).toBeVisible();

  // The passed check-in, with the manager's view next to it.
  const checkins = page.getByRole("region", { name: "Today's check-ins" });
  const passed = checkins.getByRole("listitem").filter({ has: page.locator(timeAt(passAt)) });
  await expect(passed.getByText("Passed")).toBeVisible();
  await expect(passed.getByText(/Viewed by Max Manager/)).toBeVisible();

  // Who viewed my captures: the manager, not Erin.
  const viewed = page.getByRole("region", { name: "Who viewed my captures" });
  await expect(viewed.getByText("Max Manager (manager)").first()).toBeVisible();
  await expect(viewed.getByText(/viewed \d\d:\d\d check-in/).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "My timesheet" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Apps and sites" })).toBeVisible();
  await expectNoA11yViolations(page);

  // Opening her own capture is a (logged) view, but not one she is told about.
  await passed.getByRole("button", { name: /^View the captures of the/ }).click();
  const shot = page.getByRole("img", { name: "Display 1 at check-in" });
  await expect(shot).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(viewed.getByText("Erin Employee")).toHaveCount(0);
  await expectNoA11yViolations(page);

  // Another day.
  await page.getByRole("button", { name: "Previous day" }).click();
  await expect(page).toHaveURL(/\/me\?date=\d{4}-\d{2}-\d{2}$/);
  // "Next day" has just been enabled; let its fade finish before axe measures contrast.
  await expect(page.getByRole("button", { name: "Next day" })).toHaveCSS("opacity", "1");
  await expect(page.getByRole("heading", { name: "Check-ins", exact: true })).toBeVisible();
  await expectNoA11yViolations(page);
});

test("Export my data downloads a ZIP of her own data", async ({ page }) => {
  await signIn(page, "erin@acme.test", /\/me$/);
  const download = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "Export my data" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^ai-proctor-my-data-\d{4}-\d{2}-\d{2}\.zip$/);
  const path = test.info().outputPath("my-data.zip");
  await file.saveAs(path);
  const zip = readFileSync(path);
  // A ZIP starts with "PK" and lists README.txt and the JSON datasets.
  expect(zip.subarray(0, 2).toString()).toBe("PK");
  expect(zip.includes("README.txt")).toBe(true);
  expect(zip.includes("data/check-ins.json")).toBe(true);
  await expect(page.getByText("Your download has started.")).toBeVisible();
});

test("a manager opens her own data from the account menu", async ({ page }) => {
  await signIn(page, "manager@acme.test", /\/team$/);
  await page.getByLabel("Account menu for Max Manager").click();
  await page.getByRole("link", { name: "My data" }).click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByRole("heading", { name: "My data", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Who viewed my captures" })).toBeVisible();
  await expect(page.getByText("Erin Employee")).toHaveCount(0);
  await expectNoA11yViolations(page);
});
