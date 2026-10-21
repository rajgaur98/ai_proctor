import { expect, type Page, test } from "@playwright/test";
import { clientFor } from "./agent";
import { expectNoA11yViolations } from "./helpers";

/** A number field by its label (the row's group can share the label). */
const num = (page: Page, name: string) => page.getByRole("spinbutton", { name });

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

test("an EU admin changes the interval and turns the webcam on with the DPIA; the notice preview follows, and the change is audit-logged", async ({
  page,
}) => {
  const email = `eva-${Date.now()}@eu-co.test`;
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Eva Owner");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("a-long-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel("Organisation name").fill("EuCo");
  await page.getByLabel("Policy preset").selectOption("eu");
  await page.getByRole("button", { name: "Create organisation" }).click();
  await expect(page).toHaveURL(/\/team$/);

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Policy" })
    .click();
  await expect(page.getByRole("heading", { name: "Monitoring policy", level: 1 })).toBeVisible();
  await expect(page.getByText("Applies to everyone in EuCo (1 person)")).toBeVisible();

  // The org started from the EU preset (PRD 5.1).
  const preview = page.getByRole("complementary");
  await expect(preview.getByText("Every 45 to 120 min while clocked in")).toBeVisible();
  await expect(preview.getByText("A blurred screenshot of each screen.")).toBeVisible();
  await expect(
    page.getByRole("radiogroup", { name: "Webcam frame" }).getByLabel("Off"),
  ).toBeChecked();
  await expect(
    page.getByRole("radiogroup", { name: "Window titles" }).getByLabel("Off"),
  ).toBeChecked();
  await expect(num(page, "Image retention")).toHaveValue("30");
  await expect(page.getByRole("button", { name: "Save policy" })).toBeDisabled();

  // Inline validation: nothing saves while a value is out of range.
  await num(page, "Response window").fill("20");
  await expect(page.getByText("Enter a whole number from 30 to 300")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save policy" })).toBeDisabled();
  await num(page, "Response window").fill("60");
  await num(page, "Image retention").fill("45");
  await expect(page.getByText("EU organisations keep images 30 days at most")).toBeVisible();
  await num(page, "Image retention").fill("30");

  // The interval changes the preview as it is typed.
  await num(page, "Shortest interval").fill("50");
  await expect(preview.getByText("Every 50 to 120 min while clocked in")).toBeVisible();
  await expect(preview.getByText("60 s to respond")).toBeVisible();
  await num(page, "Longest interval").fill("40");
  await expect(page.getByText("Must be at least the shortest interval")).toBeVisible();
  await num(page, "Longest interval").fill("100");

  // Webcam on in the EU needs the DPIA.
  await page
    .getByRole("radiogroup", { name: "Webcam frame" })
    .getByLabel("On")
    .click({ force: true });
  await expect(
    preview.getByText("A blurred screenshot of each screen and one webcam frame."),
  ).toBeVisible();
  await expect(page.getByText("Required in the EU.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save policy" })).toBeDisabled();
  await expectNoA11yViolations(page);
  await page.getByLabel("I confirm a DPIA has been completed").check();
  await expect(page.getByRole("button", { name: "Save policy" })).toBeEnabled();
  await page.getByRole("button", { name: "Save policy" }).click();

  const status = page.getByRole("status").filter({ hasText: "Saved" });
  await expect(status).toContainText("Saved 4 settings", { timeout: 15_000 });
  await expect(status).toContainText("Monitoring notice version 2 was published");
  await expect(page.getByRole("button", { name: "Save policy" })).toBeDisabled();
  await expect(num(page, "Shortest interval")).toHaveValue("50");
  await expect(page.getByText("Required in the EU.")).toHaveCount(0);
  await expectNoA11yViolations(page);

  // The audit log has the change with before and after, and the DPIA confirmation.
  const db = await clientFor(email, "a-long-password");
  const { data, error } = await db
    .from("audit_log")
    .select("action, metadata")
    .in("action", ["policy.changed", "policy.dpia_confirmed"]);
  expect(error).toBeNull();
  const changed = data?.find((r) => r.action === "policy.changed")?.metadata as {
    changed: Record<string, { from: unknown; to: unknown }>;
  };
  expect(changed.changed.checkin_min_interval_min).toEqual({ from: 45, to: 50 });
  expect(changed.changed.checkin_max_interval_min).toEqual({ from: 120, to: 100 });
  expect(changed.changed.webcam).toEqual({ from: false, to: true });
  expect(data?.find((r) => r.action === "policy.dpia_confirmed")?.metadata).toEqual({
    feature: "webcam",
    region: "eu",
    works_council_confirmed: false,
  });

  // It persists, and the DPIA isn't asked for again.
  await page.reload();
  await expect(num(page, "Shortest interval")).toHaveValue("50");
  await expect(
    page.getByRole("radiogroup", { name: "Webcam frame" }).getByLabel("On"),
  ).toBeChecked();
  await expect(page.getByText("Required in the EU.")).toHaveCount(0);

  // Unsaved changes are kept until the admin confirms the discard.
  await num(page, "Idle threshold").fill("20");
  await page.getByRole("button", { name: "Discard" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Discard changes" });
  await expect(confirm).toContainText("Discard 1 unsaved change?");
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(num(page, "Idle threshold")).toHaveValue("20");
  await page.getByRole("button", { name: "Discard" }).click();
  await confirm.getByRole("button", { name: "Discard changes" }).click();
  await expect(num(page, "Idle threshold")).toHaveValue("10");
});

test("a region preset fills the form without saving, and discarding puts it back", async ({
  page,
}) => {
  await signIn(page, "admin@acme.test", /\/team$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Policy" })
    .click();
  await expect(page.getByRole("heading", { name: "Monitoring policy", level: 1 })).toBeVisible();
  await expectNoA11yViolations(page);

  const region = page.getByRole("radiogroup", { name: "Region preset" });
  await region.getByLabel("EU").click({ force: true });
  await expect(
    page.getByRole("radiogroup", { name: "Screenshots" }).getByLabel("Blurred"),
  ).toBeChecked();
  await expect(
    page.getByRole("radiogroup", { name: "Webcam frame" }).getByLabel("Off"),
  ).toBeChecked();
  await expect(num(page, "Shortest interval")).toHaveValue("45");
  await expect(num(page, "Longest interval")).toHaveValue("120");
  // A US org isn't held to the EU rules, so no DPIA is asked for here.
  await page
    .getByRole("radiogroup", { name: "Webcam frame" })
    .getByLabel("On")
    .click({ force: true });
  await expect(page.getByText("Required in the EU.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save policy" })).toBeEnabled();

  await page.getByRole("button", { name: "Discard" }).click();
  await page
    .getByRole("alertdialog", { name: "Discard changes" })
    .getByRole("button", { name: "Discard changes" })
    .click();
  await expect(num(page, "Shortest interval")).toHaveValue("20");
  await expect(page.getByRole("button", { name: "Save policy" })).toBeDisabled();
});

test("a manager has no policy page", async ({ page }) => {
  await signIn(page, "manager@acme.test", /\/team$/);
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Policy" }),
  ).toHaveCount(0);
  await page.goto("/policy");
  await expect(page).toHaveURL(/\/team$/);
  await expect(page.getByRole("heading", { name: "Monitoring policy" })).toHaveCount(0);
});
