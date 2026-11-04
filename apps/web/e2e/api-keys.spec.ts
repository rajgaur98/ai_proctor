// Settings → API (#306, API-02): an admin makes an org API key, sees it once, uses it, and
// revokes it. The spec makes its own key (unique name) and only reads that row, so it
// passes alone and after any other spec.
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { expectNoA11yViolations, pressUntilFocused } from "./helpers";

const apiUrl = (() => {
  const file = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const url = file.match(/^VITE_SUPABASE_URL=(.*)$/m)?.[1]?.trim() ?? "";
  return `${url}/functions/v1/api-v1`;
})();

async function signInAsAdmin(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("admin@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
}

const people = (key: string) =>
  fetch(`${apiUrl}/v1/people?limit=1`, { headers: { Authorization: `Bearer ${key}` } });

test("an admin makes an API key, sees it once, uses it and revokes it", async ({ page }) => {
  const name = `E2E payroll ${Date.now()}`;
  await signInAsAdmin(page);
  await page.getByRole("navigation").getByRole("link", { name: "API" }).click();
  await expect(page.getByRole("heading", { name: "API", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Using the API" })).toBeVisible();
  await expectNoA11yViolations(page);

  // By keyboard: to the button, open the dialog, name it, tick the scopes.
  const open = page.getByRole("button", { name: "New API key" });
  await pressUntilFocused(page, open);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New API key" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(name);
  await expect(dialog.getByRole("button", { name: "Create key" })).toBeDisabled();
  const peopleRead = dialog.getByRole("checkbox", { name: "People: read" });
  await pressUntilFocused(page, peopleRead);
  await page.keyboard.press("Space");
  await expect(peopleRead).toBeChecked();
  await dialog.getByRole("checkbox", { name: "Time: read" }).check();
  await dialog.getByRole("checkbox", { name: "Time: write" }).check();
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Create key" }).click();

  // Shown once, in full.
  const field = dialog.getByLabel(`Key for ${name}`);
  await expect(field).toHaveValue(/^aip_[A-Za-z0-9_-]{43}$/, { timeout: 15_000 });
  const key = await field.inputValue();
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByRole("table", { name: "API keys" }).getByRole("row").filter({
    hasText: name,
  });
  await expect(row).toContainText(`${key.slice(0, 8)}…`);
  await expect(row).toContainText("People: read · Time: read, write");
  await expect(row).toContainText("Never");
  await expect(row).toContainText("Active");
  expect(await page.content()).not.toContain(key);

  // The key works, and the page shows it was used.
  expect((await people(key)).status).toBe(200);
  await page.reload();
  await expect(row).not.toContainText("Never");
  expect(await page.content()).not.toContain(key);

  // Revoke: the key stops at once.
  await row.getByRole("button", { name: `Revoke ${name}` }).click();
  const confirm = page.getByRole("dialog", { name: `Revoke ${name}?` });
  await expectNoA11yViolations(page);
  await confirm.getByRole("button", { name: "Revoke key" }).click();
  await expect(confirm).toBeHidden();
  await expect(row).toContainText("Revoked");
  await expect(row.getByRole("button", { name: `Revoke ${name}` })).toHaveCount(0);
  const refused = await people(key);
  expect(refused.status).toBe(401);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("key_revoked");
});

test("managers don't see the API page", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("manager@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  await expect(page.getByRole("navigation").getByRole("link", { name: "API" })).toHaveCount(0);
  await page.goto("/settings/api");
  await expect(page).toHaveURL(/\/team$/);
});
