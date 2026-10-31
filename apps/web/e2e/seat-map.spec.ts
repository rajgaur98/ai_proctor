import { expect, test } from "@playwright/test";
import { agentFor } from "./agent";
import { ERIN, ERIN_EMAIL, expectNoA11yViolations, MANAGER_EMAIL } from "./helpers";

// DSH-09 (#251): the seat view recolours live and opens a person's day by keyboard.
test("the seat view shows Erin's status as text and colour, live, and opens her day", async ({
  page,
}) => {
  const erin = await agentFor(ERIN_EMAIL);
  // Start from clocked out and unlocked, whatever an earlier run left behind.
  await erin("unlock");
  await erin("clock_out", { reason: "manual" });

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(MANAGER_EMAIL);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  await expect(page.locator('[aria-live="polite"]')).toHaveText(/^Live/, { timeout: 10_000 });

  await page.getByRole("button", { name: "Seats" }).click();
  await expect(page.getByRole("button", { name: "Seats" })).toHaveAttribute("aria-pressed", "true");

  await erin("clock_in", { reason: "manual" });
  const active = page.getByRole("link", { name: /^Erin Employee, Active since \d\d:\d\d$/ });
  await expect(active).toBeVisible({ timeout: 10_000 });
  await expect(active).toHaveClass(/--sactive/);

  // A Realtime change recolours the seat without a reload.
  await erin("lock");
  const away = page.getByRole("link", { name: /^Erin Employee, Away · locked since \d\d:\d\d$/ });
  await expect(away).toBeVisible({ timeout: 10_000 });
  await expect(away).toHaveClass(/--stamper/);

  // Hover or focus shows the details; the status is text, not colour alone.
  await away.focus();
  await expect(page.getByRole("tooltip").filter({ hasText: "Erin Employee" })).toBeVisible();
  await expectNoA11yViolations(page);

  // Arrow keys move round the table and come back; Enter opens her day.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect(away).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/team/${ERIN}`));

  // The choice is remembered for this viewer.
  await page.goto("/team");
  await expect(page.getByRole("button", { name: "Seats" })).toHaveAttribute("aria-pressed", "true");

  await erin("unlock");
  await erin("clock_out", { reason: "manual" });
});
