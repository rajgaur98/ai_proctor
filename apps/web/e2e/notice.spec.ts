import { expect, type Page, test } from "@playwright/test";
import { acknowledgeLatestNotice, asEmployee } from "./agent";
import { expectNoA11yViolations } from "./helpers";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

// Publishing makes every seed user unacknowledged; put them back for the other specs.
test.afterAll(async () => {
  for (const email of [
    "admin@acme.test",
    "manager@acme.test",
    "erin@acme.test",
    "lucas@acme.test",
  ]) {
    await asEmployee(email, async (db) => {
      await acknowledgeLatestNotice(db);
      return { error: null };
    });
  }
});

test("an admin edits and publishes the notice; an employee sees what they acknowledged and the new version", async ({
  page,
  browser,
}) => {
  const intro = `Edited by the admin ${Date.now()}.`;
  await signIn(page, "admin@acme.test", /\/team$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Monitoring notice" })
    .click();
  await expect(page.getByRole("heading", { name: "Monitoring notice" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Edit the notice" })).toBeVisible();
  await expect(page.getByLabel("What's collected")).toHaveValue(/webcam/);
  await expect(page.getByText("Version history")).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByLabel("Introduction").fill(intro);
  await page.getByRole("button", { name: "Publish new version" }).click();
  const published = page.getByRole("status").filter({ hasText: /Published version \d+/ });
  await expect(published).toBeVisible({ timeout: 15_000 });
  const version = Number((await published.textContent())?.match(/version (\d+)/)?.[1]);
  await expect(page.getByText(`Version ${version}`, { exact: true })).toBeVisible();
  await expect(page.getByText("0 of", { exact: false }).first()).toBeVisible();
  await expectNoA11yViolations(page);

  // An employee sees the version they acknowledged, and that a newer one is waiting.
  const erinPage = await (await browser.newContext()).newPage();
  await signIn(erinPage, "erin@acme.test", /\/me$/);
  await erinPage
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Monitoring notice" })
    .click();
  await expect(erinPage.getByRole("heading", { name: /What you acknowledged/ })).toBeVisible();
  await expect(erinPage.getByText(/You acknowledged this on/)).toBeVisible();
  await expect(erinPage.getByRole("heading", { name: /Current notice/ })).toContainText(
    `version ${version}`,
  );
  await expect(erinPage.getByText(intro)).toBeVisible();
  await expect(
    erinPage.getByText("Open the AI Proctor app to review and acknowledge it."),
  ).toBeVisible();
  await expect(erinPage.getByRole("heading", { name: "Edit the notice" })).toHaveCount(0);
  await expectNoA11yViolations(erinPage);
});

test("an incomplete notice cannot be published", async ({ page }) => {
  await signIn(page, "admin@acme.test", /\/team$/);
  await page.goto("/notice");
  await page.getByLabel("When", { exact: true }).fill("");
  await expect(page.getByRole("button", { name: "Publish new version" })).toBeDisabled();
});
