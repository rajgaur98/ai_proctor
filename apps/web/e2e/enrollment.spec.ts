// #86 (AGT-01): org enrollment tokens for MDM installs, on the People page. The spec
// makes its own token (unique name) and only reads that row, so it passes alone and
// after any other spec.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { clientFor } from "./agent";

async function signInAsAdmin(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("admin@acme.test");
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

test("an admin creates an enrollment token, sees it once, and revokes it", async ({ page }) => {
  const label = `E2E Jamf ${Date.now()}`;
  await signInAsAdmin(page);
  await page.goto("/people");
  await expect(page.getByRole("heading", { name: "Device enrollment" })).toBeVisible();

  await page.getByRole("button", { name: "New enrollment token" }).click();
  const dialog = page.getByRole("dialog", { name: "New enrollment token" });
  await dialog.getByLabel("Name").fill(label);
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Create token" }).click();

  // Shown once, in full.
  const field = dialog.getByLabel(`Token for ${label}`);
  await expect(field).toHaveValue(/^apet_[A-Za-z0-9_-]{43}$/, { timeout: 15_000 });
  const token = await field.inputValue();
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  // Listed by name and prefix; the token itself is nowhere on the page any more.
  const row = page.getByRole("table", { name: "Enrollment tokens" }).getByRole("row").filter({
    hasText: label,
  });
  await expect(row).toContainText(`${token.slice(0, 9)}…`);
  await expect(row).toContainText("0 devices");
  await expect(row).toContainText("Never");
  await expect(row).toContainText("Active");
  expect(await page.content()).not.toContain(token);
  await page.reload();
  await expect(row).toBeVisible();
  expect(await page.content()).not.toContain(token);
  await expectNoA11yViolations(page);

  // An employee who signs in on a computer managed with it enrolls.
  const erin = await clientFor("erin@acme.test");
  const enrolled = await erin.rpc("register_device", {
    platform: "macos",
    os_version: "26.7",
    agent_version: "0.1.0",
    hardware_hash: `e2e-enrollment-${Date.now()}`,
    enrollment_token: token,
  });
  expect(enrolled.error).toBeNull();
  await page.reload();
  await expect(row).toContainText("1 device");
  await expect(row).not.toContainText("Never");

  // Revoke.
  await row.getByRole("button", { name: `Revoke ${label}` }).click();
  const confirm = page.getByRole("dialog", { name: `Revoke ${label}?` });
  await expect(confirm).toContainText("1 device it enrolled keep working");
  await expectNoA11yViolations(page);
  await confirm.getByRole("button", { name: "Revoke token" }).click();
  await expect(confirm).toBeHidden();
  await expect(row).toContainText("Revoked");
  await expect(row.getByRole("button", { name: `Revoke ${label}` })).toHaveCount(0);

  // A new computer can't enroll with it any more.
  const refused = await erin.rpc("register_device", {
    platform: "macos",
    os_version: "26.7",
    agent_version: "0.1.0",
    hardware_hash: `e2e-enrollment-new-${Date.now()}`,
    enrollment_token: token,
  });
  expect(refused.error?.message).toBe("enrollment_token_revoked");

  // All three are in the audit log, without the token.
  const admin = await clientFor("admin@acme.test");
  const audit = await admin.rpc("search_audit_log", {
    p_actions: ["enrollment_token.created", "enrollment_token.used", "enrollment_token.revoked"],
    p_limit: 100,
  });
  expect(audit.error).toBeNull();
  type Row = { action: string; metadata: unknown };
  const mine = ((audit.data ?? []) as Row[]).filter(
    (r) => (r.metadata as { label?: string } | null)?.label === label,
  );
  expect(mine.map((r) => r.action).sort()).toEqual([
    "enrollment_token.created",
    "enrollment_token.revoked",
    "enrollment_token.used",
  ]);
  expect(JSON.stringify(mine)).not.toContain(token);
});
