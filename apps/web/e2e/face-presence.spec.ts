// #64 face presence (CAP-07): the policy switch (unavailable in the EU, off in
// biometric-law locations) and the "No face detected" hint on the day page. Detection
// only: a hint for the manager to look, never a penalty.
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { agentFor, clientFor } from "./agent";
import { ERIN, ERIN_ZONE, expectNoA11yViolations, MANAGER_EMAIL } from "./helpers";

const faceSwitch = (page: Page) =>
  page.getByRole("radiogroup", { name: "Face presence (detection only)" });

/** A new owner and organisation in `region`, landing on the policy page. */
async function newOrgPolicy(page: Page, region: "us" | "eu") {
  const email = `face-${region}-${Date.now()}@face-co.test`;
  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Fay Owner");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("a-long-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel("Organisation name").fill(`FaceCo ${region}`);
  await page.getByLabel("Policy preset").selectOption(region);
  await page.getByRole("button", { name: "Create organisation" }).click();
  await expect(page).toHaveURL(/\/team$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Policy" })
    .click();
  await expect(page.getByRole("heading", { name: "Monitoring policy", level: 1 })).toBeVisible();
}

test("an EU organisation sees face presence switched off and why it can't be used", async ({
  page,
}) => {
  await newOrgPolicy(page, "eu");
  const toggle = faceSwitch(page);
  await expect(toggle.getByLabel("Off")).toBeChecked();
  await expect(toggle.getByLabel("On")).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-disabled", "true");
  await expect(toggle).toHaveAccessibleDescription(/Not available to EU organisations/);
  await toggle.getByLabel("On").click({ force: true });
  await expect(toggle.getByLabel("Off")).toBeChecked();
  await expect(page.getByRole("button", { name: "Save policy" })).toBeDisabled();
  await expectNoA11yViolations(page);
});

test("a US admin turns face presence on: the notice says what it does, and where it stays off", async ({
  page,
}) => {
  await newOrgPolicy(page, "us");
  const toggle = faceSwitch(page);
  await expect(toggle.getByLabel("Off")).toBeChecked();
  await expect(
    page.getByText(/Always off for people who work in .*Illinois, Texas, Washington/),
  ).toBeVisible();

  await toggle.getByLabel("On").click({ force: true });
  const preview = page.getByRole("complementary");
  await expect(
    preview.getByText(/checked on their computer for whether a face is in view/),
  ).toBeVisible();
  await expectNoA11yViolations(page);
  await page.getByRole("button", { name: "Save policy" }).click();
  const status = page.getByRole("status").filter({ hasText: "Saved" });
  await expect(status).toContainText("Saved 1 setting", { timeout: 15_000 });
  await expect(status).toContainText("Monitoring notice version 2 was published");

  await page.reload();
  await expect(faceSwitch(page).getByLabel("On")).toBeChecked();
  await expectNoA11yViolations(page);
});

test("a pass with no face detected shows as a needs-review hint on the day page", async ({
  page,
}) => {
  // A day long past, picked at random, so a repeat run starts from its own check-ins.
  const daysAgo = 100 + Math.floor(Math.random() * 2900);
  const at = DateTime.now().minus({ days: daysAgo }).set({ hour: 11, minute: 0, second: 0 });
  const date = at.setZone(ERIN_ZONE).toISODate() ?? "";
  const iso = (minutes: number) => at.plus({ minutes }).toUTC().toISO() ?? "";
  const pass = (minutes: number, face: boolean) => ({
    scheduled_at: iso(minutes),
    shown_at: iso(minutes),
    responded_at: iso(minutes + 0.1),
    outcome: "pass",
    response_ms: 4100,
    wrong_clicks: 0,
    object_keys: [],
    flags: [],
    face_present: face,
  });

  // Face presence on for Acme (Erin works in California), then her agent acknowledges
  // the notice that describes it and sends two passes.
  const admin = await clientFor("admin@acme.test");
  const setFace = async (on: boolean) => {
    const { error } = await admin.rpc("update_policy", { p_policy: { face_presence: on } });
    if (error) throw error;
  };
  await setFace(true);
  const sent = (async () => {
    const erin = await agentFor("erin@acme.test");
    await erin("clock_out", { reason: "manual" });
    await erin("clock_in", { reason: "manual" });
    await erin("checkin", pass(0, false));
    await erin("checkin", pass(30, true));
    await erin("clock_out", { reason: "manual" });
  })();
  // Off again whatever happened, so the other specs run with the seed's policy.
  await sent.finally(() => setFace(false));

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(MANAGER_EMAIL);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  await page.goto(`/team/${ERIN}?date=${date}`);
  await expect(page.getByRole("heading", { name: "Erin Employee" })).toBeVisible();

  // Only the pass without a face carries the hint, in the list and on its marker.
  const list = page.getByRole("region", { name: "Check-ins" });
  await expect(list.getByText("No face detected")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: /no face detected \(needs review\)$/ }),
  ).toHaveCount(1);
  await list
    .getByRole("button", { name: /Passed/ })
    .filter({ hasText: "No face detected" })
    .click();
  const details = page.getByRole("region", { name: /^Check-in · / });
  await expect(details).toContainText("No face detected in the webcam frame.");
  await expect(details).toContainText("The check-in still passed.");
  await expect(details).toContainText("never identifies anyone");
  await expectNoA11yViolations(page);

  // The other pass has none.
  await list
    .getByRole("button", { name: /Passed/ })
    .filter({ hasNotText: "No face detected" })
    .click();
  await expect(details).not.toContainText("No face detected");
});
