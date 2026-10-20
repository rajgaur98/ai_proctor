import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { clientFor } from "./agent";

const ada = "00000000-0000-4000-8000-0000000000a1";

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

/** A new member the admin can delete without touching the seed users other tests share. */
async function inviteMember(name: string) {
  const email = `${name.split(" ")[0]?.toLowerCase()}-${Date.now()}@acme.test`;
  const admin = await clientFor("admin@acme.test");
  const { data, error } = await admin.functions.invoke("invite-users", {
    body: {
      invites: [
        {
          email,
          full_name: name,
          role: "employee",
          manager_id: ada,
          work_country: "US",
          work_state: "NY",
          timezone: "America/New_York",
        },
      ],
    },
  });
  expect(error).toBeNull();
  expect(data.results[0].ok).toBe(true);
  return email;
}

test("an admin exports a person's data and then deletes it, confirming with their email", async ({
  page,
}) => {
  const email = await inviteMember("Dora Delete");
  await signInAsAdmin(page);
  await page.goto("/people");
  // By the unique email: an earlier failed run may have left a Dora behind.
  await page
    .getByRole("row")
    .filter({ hasText: email })
    .getByRole("button", { name: "Edit Dora Delete" })
    .click();
  const editor = page.getByRole("dialog", { name: "Edit Dora Delete" });
  await expect(editor.getByRole("heading", { name: "Data requests" })).toBeVisible();

  // Export: the button waits for the email.
  await editor.getByRole("button", { name: "Export data for Dora Delete" }).click();
  const exportDialog = page.getByRole("dialog", { name: "Export data for Dora Delete" });
  const exportButton = exportDialog.getByRole("button", { name: "Export data", exact: true });
  await expect(exportButton).toBeDisabled();
  await exportDialog.getByLabel(`Type ${email} to confirm`).fill("someone@acme.test");
  await expect(exportButton).toBeDisabled();
  await exportDialog.getByLabel(`Type ${email} to confirm`).fill(email.toUpperCase());
  await expect(exportButton).toBeEnabled();
  // Buttons fade in from disabled; the contrast check must see the settled colours.
  await expect(exportButton).toHaveCSS("opacity", "1");
  await expectNoA11yViolations(page);
  const download = page.waitForEvent("download");
  await exportButton.click();
  expect(await (await download).suggestedFilename()).toMatch(/^ai-proctor-user-data-.*\.zip$/);
  await expect(exportDialog.getByRole("status")).toContainText("The download has started");
  await exportDialog.getByRole("button", { name: "Close" }).click();
  await expect(exportDialog).toHaveCount(0);
  // The editor was not saved or closed by any of this.
  await expect(editor).toBeVisible();

  // Delete: the consequences are spelled out, and the email is asked for again.
  await editor.getByRole("button", { name: "Delete data permanently for Dora Delete" }).click();
  const deleteDialog = page.getByRole("dialog", {
    name: "Delete data permanently for Dora Delete",
  });
  await expect(deleteDialog).toContainText("cannot be undone");
  await expect(deleteDialog).toContainText("can no longer sign in");
  await expect(deleteDialog).toContainText("the audit log keeps");
  const deleteButton = deleteDialog.getByRole("button", { name: "Delete permanently" });
  await expect(deleteButton).toBeDisabled();
  await deleteDialog.getByLabel(`Type ${email} to confirm`).fill(email);
  await expect(deleteButton).toBeEnabled();
  await expect(deleteButton).toHaveCSS("opacity", "1");
  await expectNoA11yViolations(page);
  await deleteButton.click();
  await expect(deleteDialog.getByRole("status")).toContainText("Deleted:", { timeout: 15_000 });
  await expect(deleteDialog.getByRole("status")).toContainText("and their sign-in");
  await expectNoA11yViolations(page);
  await deleteDialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: email })).toHaveCount(0);

  // The person can no longer sign in.
  const signIn = await (await clientFor("admin@acme.test")).auth.signInWithPassword({
    email,
    password: "password123",
  });
  expect(signIn.error).not.toBeNull();
});

test("a manager with reports can't be deleted, the owner and yourself have no delete action", async ({
  page,
}) => {
  await signInAsAdmin(page);
  await page.goto("/people");

  await page.getByRole("button", { name: "Edit Max Manager" }).click();
  const editor = page.getByRole("dialog", { name: "Edit Max Manager" });
  await editor.getByRole("button", { name: "Delete data permanently for Max Manager" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete data permanently for Max Manager" });
  await dialog.getByLabel("Type manager@acme.test to confirm").fill("manager@acme.test");
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect(dialog.getByRole("alert")).toContainText("People still report to them");
  await expect(dialog.getByRole("alert")).toContainText("Erin Employee");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Edit Max Manager" })).toBeVisible();

  // Yourself (the owner): My data has the export; there is nothing to delete here.
  await page.getByRole("button", { name: "Edit Ada Admin" }).click();
  const own = page.getByRole("dialog", { name: "Edit Ada Admin" });
  await expect(own.getByRole("button", { name: /data/i })).toHaveCount(0);
});
