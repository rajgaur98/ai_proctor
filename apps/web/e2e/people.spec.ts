import { expect, type Page, test } from "@playwright/test";
import { clientFor } from "./agent";
import { expectNoA11yViolations } from "./helpers";

// The local stack's mail catcher (`pnpm supabase status`).
const mailpit = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

async function signInAsAdmin(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("admin@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
}

/** The join link from the newest invite email to `email`. */
async function inviteLink(email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const list = await (
      await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json();
    const id = list.messages?.[0]?.ID;
    if (id) {
      const message = await (await fetch(`${mailpit}/api/v1/message/${id}`)).json();
      const link = String(message.HTML).match(/href="([^"]*\/join\?[^"]*)"/)?.[1];
      if (link) return link.replaceAll("&amp;", "&");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no invite email for ${email}`);
}

test("an admin invites someone, who joins and sets a password", async ({ page, browser }) => {
  const email = `nora-${Date.now()}@acme.test`;
  await signInAsAdmin(page);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "People" })
    .click();
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Erin Employee" })).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByRole("button", { name: "Invite people" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite people" });
  await dialog.getByLabel("Work email").fill(email);
  await dialog.getByLabel("Full name").fill("Nora New");
  await dialog.getByLabel("Direct manager").selectOption({ label: "Max Manager" });
  await dialog.getByLabel("State").selectOption("NY");
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Send invites" }).click();
  await expect(dialog.getByRole("list", { name: "Invite results" })).toContainText(
    `${email}: invited`,
    { timeout: 15_000 },
  );
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("row").filter({ hasText: email })).toBeVisible();

  // The invitee, in a fresh browser.
  const link = await inviteLink(email);
  const invitee = await (await browser.newContext()).newPage();
  await invitee.goto(link);
  await expect(invitee.getByRole("heading", { name: "Set your password" })).toBeVisible({
    timeout: 15_000,
  });
  expect(new URL(invitee.url()).search).toBe("");
  await invitee.getByLabel("Password").fill("a-long-password");
  await invitee.getByRole("button", { name: "Continue" }).click();
  await expect(invitee.getByRole("heading", { name: "You're in" })).toBeVisible();
  await invitee.getByRole("link", { name: "Go to the dashboard" }).click();
  await expect(invitee).toHaveURL(/\/me$/, { timeout: 15_000 });

  // The same link can't be used twice.
  const again = await (await browser.newContext()).newPage();
  await again.goto(link);
  await expect(again.getByRole("heading", { name: "This invite doesn't work" })).toBeVisible({
    timeout: 15_000,
  });
});

test("an admin changes someone's manager, and the rules are explained", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/people");
  await page.getByRole("button", { name: "Edit Lucas Martin" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Lucas Martin" });
  await dialog.getByLabel("Direct manager").selectOption({ label: "Ada Admin" });
  await dialog.getByRole("button", { name: "Save details" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "Lucas Martin" })).toContainText(
    "Ada Admin",
  );

  // Put him back under Max; then try a reporting loop.
  await page.getByRole("button", { name: "Edit Lucas Martin" }).click();
  await page
    .getByRole("dialog", { name: "Edit Lucas Martin" })
    .getByLabel("Direct manager")
    .selectOption({ label: "Max Manager" });
  await page
    .getByRole("dialog", { name: "Edit Lucas Martin" })
    .getByRole("button", { name: "Save details" })
    .click();

  await page.getByRole("button", { name: "Edit Max Manager" }).click();
  const max = page.getByRole("dialog", { name: "Edit Max Manager" });
  await max.getByLabel("Role").selectOption("employee");
  await max.getByRole("button", { name: "Save details" }).click();
  await expect(max.getByRole("alert")).toHaveText(
    "Move this person's reports to another manager first.",
  );
});

test("an admin sets a night shift that crosses midnight", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/people");
  await page.getByRole("button", { name: "Edit Lucas Martin" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Lucas Martin" });
  await expect(dialog.getByText("Shifts (America/Chicago)")).toBeVisible();
  for (const remove of await dialog.getByRole("button", { name: /^Remove shift/ }).all()) {
    await remove.click();
  }
  await dialog.getByRole("button", { name: "Add shift" }).click();
  await dialog.getByLabel("Shift 1 start").fill("22:00");
  await dialog.getByLabel("Shift 1 end").fill("06:00");
  await expect(dialog.getByText("8 h, ends next day")).toBeVisible();
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  await expect(dialog.getByRole("button", { name: "Schedule saved" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Edit Lucas Martin" }).click();
  await expect(
    page.getByRole("dialog", { name: "Edit Lucas Martin" }).getByLabel("Shift 1 start"),
  ).toHaveValue("22:00");
});

test("an admin turns approval off for someone, and it is audit-logged (TS-16)", async ({
  page,
}) => {
  await signInAsAdmin(page);
  await page.goto("/people");
  const edit = async (approvalNotRequired: boolean) => {
    await page.getByRole("button", { name: "Edit Lucas Martin" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Lucas Martin" });
    const box = dialog.getByLabel("Approval not required");
    await expect(box).toBeChecked({ checked: !approvalNotRequired });
    await box.setChecked(approvalNotRequired);
    await dialog.getByRole("button", { name: "Save details" }).click();
    await expect(dialog).toHaveCount(0);
  };
  await edit(true);
  const { data } = await (await clientFor("admin@acme.test"))
    .from("users")
    .select("approval_required")
    .eq("email", "lucas@acme.test")
    .single();
  expect(data?.approval_required).toBe(false);
  await page.getByRole("button", { name: "Edit Lucas Martin" }).click();
  await expectNoA11yViolations(page);
  await page
    .getByRole("dialog", { name: "Edit Lucas Martin" })
    .getByRole("button", { name: "Cancel" })
    .click();

  // Back to the seed state for the other specs.
  await edit(false);
  const { data: log } = await (await clientFor("admin@acme.test"))
    .from("audit_log")
    .select("metadata")
    .eq("action", "member.approval_changed")
    .order("id", { ascending: false })
    .limit(2);
  expect(log?.map((r) => r.metadata)).toEqual([
    { from: false, to: true },
    { from: true, to: false },
  ]);
});
