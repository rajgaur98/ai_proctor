import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { agentFor } from "./agent";

test("a manager sees why someone is in Tamper: capture blocked now, agent stopped earlier", async ({
  page,
}) => {
  const lucas = await agentFor("lucas@acme.test");
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  // A shift that began 30 minutes ago; the agent was killed and the watchdog started it
  // again 10 minutes later (ANT-01).
  await lucas("clock_out", { reason: "manual" }, undefined, ago(40));
  await lucas("clock_in", { reason: "manual" }, undefined, ago(30));
  await lucas("agent_restart", { last_alive_at: ago(25), reason: "killed" }, undefined, ago(15));
  // Screen Recording is then revoked: Tamper now, for a different reason (AGT-07).
  await lucas("permission_change", { screen: "denied", camera: "granted" });

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("manager@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });

  const row = page.getByRole("row").filter({ hasText: "Lucas Martin" });
  await expect(row.getByText("Capture blocked")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("link", { name: "View day for Lucas Martin" }).click();
  await expect(page.getByRole("heading", { name: "Lucas Martin" })).toBeVisible();
  // The chip says what it is now; the day says what happened earlier, in its own words.
  await expect(page.getByText("Capture blocked").first()).toBeVisible();
  await expect(page.getByText(/^Agent stopped · \d+ min$/)).toBeVisible();
  await expect(page.getByTitle(/^Agent stopped, \d\d:\d\d–\d\d:\d\d$/).first()).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await lucas("permission_change", { screen: "granted", camera: "granted" });
  await lucas("clock_out", { reason: "manual" });
});
