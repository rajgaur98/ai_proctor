import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { agentFor, clientFor } from "./agent";
import { ERIN, ERIN_EMAIL, ERIN_ZONE, expectNoA11yViolations, MANAGER_EMAIL } from "./helpers";

// #67: "Top apps today" (ACT-04) on the manager's day page and on the employee's My
// data, and the daily digest switch (ALR-03) on the Alerts page. Each test makes what it
// reads; the app names are this spec's own, so other specs' activity doesn't change the
// order checked here.
test.use({ timezoneId: ERIN_ZONE });

const MAX = "00000000-0000-4000-8000-0000000000b1";
const EDITOR = "E2E Top Editor";
const BROWSER = "E2E Top Browser";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/**
 * Erin's agent reports whole minutes of two apps today: three of the editor, one of the
 * browser. The clock-in is backdated so the minutes are inside it.
 */
async function seedApps() {
  const erin = await agentFor(ERIN_EMAIL);
  const now = DateTime.now().toUTC();
  // Off shift first: a backdated clock-in is refused while she is still clocked in.
  await erin("clock_out", { reason: "manual" });
  await erin(
    "clock_in",
    { reason: "manual" },
    crypto.randomUUID(),
    now.minus({ minutes: 6 }).toISO() ?? "",
  );
  const minute = (back: number) => now.startOf("minute").minus({ minutes: back });
  const session = (app: string, back: number) =>
    erin(
      "app_session",
      {
        app,
        title: null,
        domain: null,
        start: minute(back).toISO(),
        end: minute(back).plus({ seconds: 60 }).toISO(),
      },
      crypto.randomUUID(),
      minute(back).plus({ seconds: 60 }).toISO() ?? "",
    );
  for (const back of [5, 4, 3]) {
    const reply = await session(EDITOR, back);
    expect(reply.rejected).toEqual([]);
  }
  expect((await session(BROWSER, 2)).rejected).toEqual([]);
  await erin("clock_out", { reason: "manual" });
}

test("the manager sees Erin's top apps today on her day page", async ({ page }) => {
  await seedApps();
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto(`/team/${ERIN}`);
  const card = page.getByRole("region", { name: "Top apps today" });
  await expect(card.getByText(EDITOR)).toBeVisible({ timeout: 15_000 });
  const names = await card.getByRole("listitem").allInnerTexts();
  const editorAt = names.findIndex((n) => n.includes(EDITOR));
  const browserAt = names.findIndex((n) => n.includes(BROWSER));
  expect(editorAt).toBeGreaterThanOrEqual(0);
  // The editor had more time, so it comes first; time only, no score.
  expect(browserAt).toBeGreaterThan(editorAt);
  await expect(card.getByRole("listitem").filter({ hasText: EDITOR })).toContainText(/\d+ (h|min)/);
  await expectNoA11yViolations(page);
});

test("an employee sees her own top apps on My data", async ({ page }) => {
  await seedApps();
  await signIn(page, ERIN_EMAIL, /\/me$/);
  const card = page.getByRole("region", { name: "Top apps today" });
  await expect(card.getByText(EDITOR)).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText(BROWSER)).toBeVisible();
  await expectNoA11yViolations(page);

  // Another day has its own list.
  await page.getByRole("button", { name: "Previous day" }).click();
  await expect(page.getByRole("region", { name: "Top apps", exact: true })).toBeVisible();
});

test("a manager turns the daily digest email off and on", async ({ page }) => {
  // Start from on, whatever an earlier run left.
  const max = await clientFor(MANAGER_EMAIL);
  const reset = await max.rpc("set_daily_digest", { p_enabled: true });
  expect(reset.error).toBeNull();

  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/alerts");
  const toggle = page.getByRole("checkbox", { name: "Daily digest email" });
  await expect(toggle).toBeChecked();
  await expectNoA11yViolations(page);

  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Daily digest email" })).not.toBeChecked();

  await page.getByRole("checkbox", { name: "Daily digest email" }).check();
  await expect(page.getByRole("checkbox", { name: "Daily digest email" })).toBeEnabled();
  await expect
    .poll(async () => {
      const { data, error } = await max
        .from("notification_prefs")
        .select("daily_digest")
        .eq("user_id", MAX)
        .single();
      if (error) throw error;
      return data.daily_digest;
    })
    .toBe(true);
});
