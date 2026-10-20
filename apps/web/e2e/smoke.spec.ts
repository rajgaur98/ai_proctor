import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// Seed users (supabase/seed.sql); local stack only.
const password = "password123";

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("signed-out visitors land on sign-in, which is accessible", async ({ page }) => {
  await page.goto("/team");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expectNoA11yViolations(page);
});

test("a manager gets the team navigation", async ({ page }) => {
  await signIn(page, "manager@acme.test");
  await expect(page).toHaveURL(/\/team$/);
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const label of ["Live team", "Timesheets", "Projects"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  // The policy is for owners and admins (#52).
  await expect(nav.getByRole("link", { name: "Policy" })).toHaveCount(0);
  await expect(page.getByRole("banner").getByText("Acme Remote")).toBeVisible();
  await expectNoA11yViolations(page);
});

test("an employee gets only their own pages and cannot open the team page", async ({ page }) => {
  await signIn(page, "erin@acme.test");
  await expect(page).toHaveURL(/\/me$/);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "My data" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Live team" })).toHaveCount(0);
  await page.goto("/team");
  await expect(page).toHaveURL(/\/me$/);
  await expectNoA11yViolations(page);
});

test("a new owner signs up and creates their organisation", async ({ page }) => {
  const email = `founder-${Date.now()}@newco.test`;
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Nia Founder");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("a-long-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expectNoA11yViolations(page);
  await page.getByLabel("Organisation name").fill("NewCo");
  await page.getByRole("button", { name: "Create organisation" }).click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(page.getByRole("banner").getByText("NewCo")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "People" }),
  ).toBeVisible();
});
