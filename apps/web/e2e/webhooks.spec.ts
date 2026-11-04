// Settings → API → Webhooks (#320, #335; API-06): an admin adds an endpoint and sees its signing
// secret once, sends it a test event and finds it in the delivery log, tries to redeliver,
// turns it off, rotates the secret (the previous one signs for 24 hours more) and deletes it.
// The spec makes its own endpoint (unique URL) and deletes it, so it passes alone and after
// any other spec. Delivery itself is covered by scripts/it-webhooks.ts.
import { expect, type Page, test } from "@playwright/test";
import { expectNoA11yViolations, pressUntilFocused } from "./helpers";

async function signInAsAdmin(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("admin@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
}

test("an admin adds a webhook endpoint, sees the secret once, rotates it and deletes it", async ({
  page,
}) => {
  const url = `https://e2e-${Date.now()}.example.com/hook`;
  await signInAsAdmin(page);
  await page.goto("/settings/api");
  await expect(page.getByRole("heading", { name: "Webhooks", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Delivery log", level: 2 })).toBeVisible();
  await expectNoA11yViolations(page);

  // By keyboard: to the button, open the dialog, type the URL, tick an event.
  await pressUntilFocused(page, page.getByRole("button", { name: "Add endpoint" }));
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Add endpoint" });
  await expect(dialog).toBeVisible();
  const add = dialog.getByRole("button", { name: "Add endpoint" });
  await expect(add).toBeDisabled();
  await dialog.getByLabel("Endpoint URL").fill("ftp://files.example.com/hook");
  const approved = dialog.getByRole("checkbox", { name: /Timesheet approved/ });
  await pressUntilFocused(page, approved);
  await page.keyboard.press("Space");
  await expect(approved).toBeChecked();
  await expectNoA11yViolations(page);
  await add.click();
  await expect(dialog.getByRole("alert")).toContainText("https://");

  await dialog.getByLabel("Endpoint URL").fill(url);
  await dialog.getByRole("checkbox", { name: /Time off decided/ }).check();
  await add.click();
  const field = dialog.getByLabel(`Signing secret for ${url}`);
  await expect(field).toHaveValue(/^whsec_[A-Za-z0-9_-]{43}$/, { timeout: 15_000 });
  const secret = await field.inputValue();
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByRole("table", { name: "Webhook endpoints" }).getByRole("row").filter({
    hasText: url,
  });
  await expect(row).toContainText("Timesheet approved, Time off decided");
  await expect(row).toContainText("Active");
  await expect(row).toContainText("No events yet");
  expect(await page.content()).not.toContain(secret);

  // Send a test event (#335): queued, and in this endpoint's delivery log.
  // The e2e stack sends nothing (no Vault secrets for the deliver job), so the log is shown as
  // if the test event had failed for good, to reach Redeliver; the server refuses it, since
  // the event is really still waiting. Redelivery itself is covered by it-webhooks.ts.
  await page.route("**/rest/v1/rpc/list_webhook_deliveries*", async (route) => {
    const response = await route.fetch();
    const rows = (await response.json()) as Record<string, unknown>[];
    await route.fulfill({
      response,
      json: rows.map((r) => ({ ...r, status: "failed", attempts: 7, next_attempt_at: null })),
    });
  });
  await row.getByRole("button", { name: `Send a test event to ${url}` }).click();
  await expect(page.getByText(`Test event queued for ${url}.`)).toBeVisible();
  await page.getByLabel("Endpoint", { exact: true }).selectOption({ label: url });
  const log = page.getByRole("table", { name: "Webhook deliveries" });
  const ping = log.getByRole("row").filter({ hasText: "Test event" });
  await expect(ping).toHaveCount(1);
  await expectNoA11yViolations(page);
  await ping.getByRole("button", { name: "Redeliver Test event" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't redeliver" })).toHaveText(
    "Couldn't redeliver: That event is still waiting to go out to this endpoint.",
  );
  await page.unroute("**/rest/v1/rpc/list_webhook_deliveries*");

  // Turn it off.
  await row.getByRole("button", { name: `Edit ${url}` }).click();
  const edit = page.getByRole("dialog", { name: "Edit endpoint" });
  await expect(edit.getByLabel("Endpoint URL")).toHaveValue(url);
  await edit.getByRole("checkbox", { name: "Send events to this endpoint" }).uncheck();
  await expectNoA11yViolations(page);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText("Off");
  await row.getByRole("button", { name: `Send a test event to ${url}` }).click();
  await expect(page.getByRole("alert").filter({ hasText: "test event" })).toHaveText(
    "Couldn't send the test event: The endpoint is off. Turn it on first.",
  );

  // Rotate: a new secret, shown once.
  await row.getByRole("button", { name: `Rotate the secret of ${url}` }).click();
  const rotate = page.getByRole("dialog", { name: "Rotate the signing secret?" });
  await expectNoA11yViolations(page);
  await rotate.getByRole("button", { name: "Rotate secret" }).click();
  const fresh = rotate.getByLabel(`New signing secret for ${url}`);
  await expect(fresh).toHaveValue(/^whsec_[A-Za-z0-9_-]{43}$/, { timeout: 15_000 });
  expect(await fresh.inputValue()).not.toBe(secret);
  await rotate.getByRole("button", { name: "Done" }).click();
  await expect(rotate).toBeHidden();
  await expect(row).toContainText("Previous secret also signs until");

  // Delete.
  await row.getByRole("button", { name: `Delete ${url}` }).click();
  const confirm = page.getByRole("dialog", { name: "Delete this endpoint?" });
  await expectNoA11yViolations(page);
  await confirm.getByRole("button", { name: "Delete endpoint" }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText(url)).toHaveCount(0);
});
