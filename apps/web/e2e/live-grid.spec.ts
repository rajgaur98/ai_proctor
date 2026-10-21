import { expect, test } from "@playwright/test";
import { agentFor } from "./agent";
import { expectNoA11yViolations } from "./helpers";

test("the live grid updates in real time when an employee's status changes", async ({ page }) => {
  const erin = await agentFor("erin@acme.test");
  // Start from clocked out, whatever an earlier run left behind.
  await erin("clock_out", { reason: "manual" });

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("manager@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  // The first page load also compiles the dev bundle.
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  await expect(page.locator('[aria-live="polite"]')).toHaveText(/^Live/, { timeout: 10_000 });

  // Clock in from "her agent": the row appears without a reload (STS-03, ≤ 10 s).
  await erin("clock_in", { reason: "manual" });
  const row = page.getByRole("row").filter({ hasText: "Erin Employee" });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.getByText("Active")).toBeVisible();

  await erin("lock");
  await expect(row.getByText("Away · locked")).toBeVisible({ timeout: 10_000 });

  await expectNoA11yViolations(page);

  await erin("unlock");
  await erin("clock_out", { reason: "manual" });
  await expect(row).toHaveCount(0, { timeout: 10_000 });
});
