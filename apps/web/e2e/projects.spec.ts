import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function signInAsManager(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("manager@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
}

async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("a manager creates a project for a client and assigns someone", async ({ page }) => {
  // Names must be unique per client, and the local database keeps earlier runs.
  const name = `Mobile app ${Date.now()}`;
  await signInAsManager(page);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Projects" })
    .click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Website revamp" })).toContainText(
    "Northwind",
  );
  await expectNoA11yViolations(page);

  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Project name").fill(name);
  await dialog.getByLabel("Client").selectOption({ label: "Northwind" });
  await dialog.getByLabel("Erin Employee").check();
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Save project" }).click();
  await expect(dialog).toHaveCount(0);

  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("Northwind");
  await expect(row).toContainText("Yes");
  await expect(row.getByRole("cell").nth(3)).toHaveText("1");
  await expect(row).toContainText("Active");
});

test("a manager adds a client, and a repeated name is explained", async ({ page }) => {
  const name = `Client ${Date.now()}`;
  await signInAsManager(page);
  await page.goto("/projects");
  await page.getByRole("button", { name: "Clients" }).click();
  const dialog = page.getByRole("dialog", { name: "Clients" });
  await expect(dialog.getByLabel("Name of Northwind")).toBeVisible();
  await dialog.getByLabel("New client name").fill(name);
  await dialog.getByRole("button", { name: "Add client" }).click();
  await expect(dialog.getByLabel(`Name of ${name}`)).toBeVisible();
  await expectNoA11yViolations(page);

  await dialog.getByLabel("New client name").fill(name);
  await dialog.getByRole("button", { name: "Add client" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("That name is already used. Choose another.");
});
