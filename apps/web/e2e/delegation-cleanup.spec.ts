import { expect, type Page, test } from "@playwright/test";
import { clientFor } from "./agent";
import { expectNoA11yViolations } from "./helpers";

const MAX = "00000000-0000-4000-8000-0000000000b1";
const LUCAS = "00000000-0000-4000-8000-0000000000c2";
const ADMIN_EMAIL = "admin@acme.test";
const MANAGER_EMAIL = "manager@acme.test";

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
}

/** Lucas's role and active flag as the admin sets them, keeping the rest of his details. */
async function setLucas(role: "employee" | "manager", active: boolean) {
  const admin = await clientFor(ADMIN_EMAIL);
  const { data, error } = await admin.from("users").select("*").eq("id", LUCAS).single();
  if (error) throw error;
  if (data.active !== active) {
    const r = await admin.rpc("set_user_active", { p_user_id: LUCAS, p_active: active });
    if (r.error) throw r.error;
  }
  if (data.role !== role) {
    const r = await admin.rpc("update_member", {
      p_user_id: LUCAS,
      p_full_name: data.full_name,
      p_role: role,
      p_manager_id: data.manager_id as string,
      p_work_country: data.work_country,
      p_work_state: data.work_state as string,
      p_timezone: data.timezone,
    });
    if (r.error) throw r.error;
  }
}

/** Ends whatever delegation Max has live, whatever earlier runs left. */
async function clearMax() {
  const manager = await clientFor(MANAGER_EMAIL);
  const live = await manager.rpc("my_delegations");
  if (live.error) throw live.error;
  for (const d of live.data) {
    const r = await manager.rpc("end_delegation", { p_id: d.id });
    if (r.error) throw r.error;
  }
}

/** Today's date in Max's time zone (America/Chicago), as the form's default. */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

async function setForMax(delegateId: string) {
  const admin = await clientFor(ADMIN_EMAIL);
  const r = await admin.rpc("set_delegation", {
    p_delegate_id: delegateId,
    p_starts_on: today(),
    p_ends_on: today(),
    p_manager_id: MAX,
  });
  if (r.error) throw r.error;
}

test("an admin sets and ends a delegation for Max, and deactivating or demoting the delegate ends it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await setLucas("manager", true);
  await clearMax();
  try {
    await signIn(page, ADMIN_EMAIL);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "People" })
      .click();
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
    // Only managers, admins and the owner have a delegation to manage.
    await expect(page.getByRole("button", { name: "Delegation for Erin Employee" })).toHaveCount(0);

    const open = async () => {
      await page.getByRole("button", { name: "Delegation for Max Manager" }).click();
      return page.getByRole("dialog", { name: "Delegation for Max Manager" });
    };

    // Set one for Max.
    let dialog = await open();
    await dialog.getByRole("button", { name: "Set delegate" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Choose who approves for Max Manager.");
    await dialog.getByLabel("Delegate").selectOption({ label: "Lucas Martin" });
    await expectNoA11yViolations(page);
    await dialog.getByRole("button", { name: "Set delegate" }).click();
    const history = dialog.getByRole("region", { name: "History" });
    await expect(history).toContainText("Lucas Martin approves for Max Manager");
    await expect(history).toContainText("Active");
    await expectNoA11yViolations(page);

    // End it on his behalf: it stays in the history as ended early.
    await dialog.getByRole("button", { name: "End delegation to Lucas Martin" }).click();
    await expect(history).toContainText("Ended early");
    await expect(dialog.getByRole("button", { name: /^End delegation/ })).toHaveCount(0);
    await expectNoA11yViolations(page);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);

    // Deactivate the delegate: a delegation set again ends with him.
    await setForMax(LUCAS);
    await page.getByRole("button", { name: "Edit Lucas Martin" }).click();
    await page
      .getByRole("dialog", { name: "Edit Lucas Martin" })
      .getByRole("button", { name: "Deactivate" })
      .click();
    await expect(page.getByRole("dialog", { name: "Edit Lucas Martin" })).toHaveCount(0);
    dialog = await open();
    await expect(dialog.getByRole("region", { name: "History" })).toContainText(
      "Ended early (deactivated)",
    );
    await expect(dialog.getByRole("button", { name: /^End delegation/ })).toHaveCount(0);
    await expectNoA11yViolations(page);
    await dialog.getByRole("button", { name: "Close" }).click();

    // Reactivated, named again and made an employee: it ends again.
    await setLucas("manager", true);
    await setForMax(LUCAS);
    await page.getByRole("button", { name: "Edit Lucas Martin" }).click();
    const edit = page.getByRole("dialog", { name: "Edit Lucas Martin" });
    await edit.getByLabel("Role").selectOption("employee");
    await edit.getByRole("button", { name: "Save details" }).click();
    await expect(edit).toHaveCount(0);
    dialog = await open();
    await expect(dialog.getByRole("region", { name: "History" })).toContainText(
      "Ended early (made an employee)",
    );
    await dialog.getByRole("button", { name: "Close" }).click();

    // The manager sees the ended ones under Past delegations, and was told why.
    await page.getByLabel("Account menu for Ada Admin").click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await signIn(page, MANAGER_EMAIL);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Timesheets" })
      .click();
    const section = page.getByRole("region", { name: "Delegation" });
    await expect(section).toContainText("No delegate.");
    await expect(section).toContainText("Past delegations");
    await expect(section).toContainText("Lucas Martin approves for you");
    await expect(section).toContainText("Ended early (deactivated)");
    await expect(section).toContainText("Ended early (made an employee)");
    await expectNoA11yViolations(page);

    const manager = await clientFor(MANAGER_EMAIL);
    const notes = await manager
      .from("notifications")
      .select("payload")
      .eq("kind", "delegation.ended")
      .order("created_at", { ascending: false });
    if (notes.error) throw notes.error;
    const reasons = notes.data.map((n) => (n.payload as { reason?: string }).reason);
    expect(reasons).toContain("deactivated");
    expect(reasons).toContain("demoted");

    const admin = await clientFor(ADMIN_EMAIL);
    const audit = await admin
      .from("audit_log")
      .select("metadata")
      .eq("action", "delegation.ended")
      .eq("target_user_id", MAX)
      .order("id", { ascending: false })
      .limit(2);
    if (audit.error) throw audit.error;
    expect(audit.data.map((a) => (a.metadata as { reason?: string }).reason)).toEqual([
      "demoted",
      "deactivated",
    ]);
  } finally {
    await setLucas("employee", true);
    await clearMax();
  }
});
