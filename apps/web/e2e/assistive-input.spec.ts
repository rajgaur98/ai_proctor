import { expect, type Page, test } from "@playwright/test";
import { clientFor } from "./agent";
import { expectNoA11yViolations } from "./helpers";

const LUCAS = "00000000-0000-4000-8000-0000000000c2";

/** Sets Lucas's assistive input as an admin would, leaving his other fields as they are. */
async function setLucas(on: boolean) {
  const admin = await clientFor("admin@acme.test");
  const { data: lucas, error } = await admin
    .from("users")
    .select("full_name, role, manager_id, work_country, work_state, timezone, assistive_input")
    .eq("id", LUCAS)
    .single();
  if (error) throw error;
  if (lucas.assistive_input === on) return;
  const { error: rpcError } = await admin.rpc("update_member", {
    p_user_id: LUCAS,
    p_full_name: lucas.full_name,
    p_role: lucas.role,
    p_manager_id: lucas.manager_id as string,
    p_work_country: lucas.work_country,
    p_work_state: lucas.work_state as string,
    p_timezone: lucas.timezone,
    p_assistive_input: on,
  });
  if (rpcError) throw rpcError;
}

async function lucasAssistive(): Promise<boolean> {
  const admin = await clientFor("admin@acme.test");
  const { data, error } = await admin
    .from("users")
    .select("assistive_input")
    .eq("id", LUCAS)
    .single();
  if (error) throw error;
  return data.assistive_input;
}

/** Ticks an action in the audit log's filter menu, opening it if it's closed. */
async function pickAction(page: Page, label: string) {
  const box = page.getByRole("checkbox", { name: label });
  if (!(await box.isVisible())) await page.locator('form[aria-label="Filters"] summary').click();
  await box.check();
}

test("an admin marks someone as using assistive input, and it is audit-logged", async ({
  page,
}) => {
  await setLucas(false);
  try {
    await page.goto("/sign-in");
    await page.getByLabel("Work email").fill("admin@acme.test");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });

    await page.goto("/people");
    await page.getByRole("button", { name: "Edit Lucas Martin" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Lucas Martin" });
    const box = dialog.getByRole("checkbox", { name: /Uses assistive input/ });
    await expect(box).not.toBeChecked();
    await expect(dialog).toContainText(
      "Clicks from accessibility tools are accepted and marked for review.",
    );
    await box.check();
    await expectNoA11yViolations(page);
    await dialog.getByRole("button", { name: "Save details" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(lucasAssistive).toBe(true);

    // Opened again, it shows what was saved.
    await page.getByRole("button", { name: "Edit Lucas Martin" }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Edit Lucas Martin" })
        .getByRole("checkbox", { name: /Uses assistive input/ }),
    ).toBeChecked();
    await page
      .getByRole("dialog", { name: "Edit Lucas Martin" })
      .getByRole("button", { name: "Cancel" })
      .click();

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Audit log" })
      .click();
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    await pickAction(page, "Changed assistive input");
    await page.getByLabel("Target").selectOption({ label: "Lucas Martin" });
    const newest = page.locator("tbody tr").first();
    await expect(newest).toContainText("Changed assistive input");
    await expect(newest).toContainText("Ada Admin");
    await expect(newest).toContainText("Lucas Martin");
    await expect(newest).toContainText("Off → On");
    await expectNoA11yViolations(page);
  } finally {
    await setLucas(false);
  }
});
