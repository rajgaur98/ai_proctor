// #253 (EMP-06, CAP-09): an employee deletes the webcam frame of one of her check-ins
// from My data; the screenshot stays, and her manager's day view says what she removed
// instead of showing a failed capture. Managers get no delete button.
import { expect, type Page, test } from "@playwright/test";
import { agentFor, clientFor } from "./agent";
import { ERIN, expectNoA11yViolations, timeAt } from "./helpers";

const org = "00000000-0000-4000-8000-000000000001";
// A 1×1 WebP.
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/** Erin passes a check-in with a screenshot and a webcam frame, both uploaded. */
async function seedPass(): Promise<string> {
  const erin = await agentFor("erin@acme.test");
  await erin("clock_out", { reason: "manual" });
  await erin("clock_in", { reason: "manual" });
  const checkinId = crypto.randomUUID();
  const at = new Date(Date.now() - 5_000).toISOString();
  await erin(
    "checkin",
    {
      scheduled_at: at,
      shown_at: at,
      responded_at: at,
      outcome: "pass",
      response_ms: 2500,
      wrong_clicks: 0,
      object_keys: ["screen-1.webp", "webcam.webp"],
      flags: [],
    },
    checkinId,
  );
  const uploader = await clientFor("erin@acme.test");
  for (const name of ["screen-1.webp", "webcam.webp"]) {
    const { error } = await uploader.storage
      .from("captures")
      .upload(`${org}/${ERIN}/${at.slice(0, 10)}/${checkinId}/${name}`, webp, {
        contentType: "image/webp",
      });
    expect(error).toBeNull();
  }
  await erin("clock_out", { reason: "manual" });
  return at;
}

test("an employee deletes only the webcam frame; her manager sees it was removed", async ({
  page,
  browser,
}) => {
  // Two people, two sign-ins and two capture opens.
  test.setTimeout(90_000);
  const at = await seedPass();

  await signIn(page, "erin@acme.test", /\/me$/);
  await expect(page.getByText(/ask a workspace admin for a data deletion request/)).toBeVisible();
  const row = page
    .getByRole("region", { name: "Today's check-ins" })
    .getByRole("listitem")
    .filter({ has: page.locator(timeAt(at)) });
  await row.getByRole("button", { name: /^Delete from the \d\d:\d\d check-in$/ }).click();

  const dialog = page.getByRole("dialog", { name: /^Delete from the / });
  await expect(dialog.getByRole("checkbox", { name: "Screen capture" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Delete for good" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "Webcam frame" }).check();
  await expect(dialog.getByRole("listitem")).toHaveText(["the webcam frame"]);
  await expect(dialog).toContainText("it can't be undone");
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "Delete for good" }).click();
  // The function's first call may start its worker.
  await expect(dialog.getByRole("status")).toContainText("Deleted.", { timeout: 20_000 });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(row.getByText(/^Webcam removed by you on /)).toBeVisible();
  // The screenshot is still there.
  await row.getByRole("button", { name: /^View the captures of the/ }).click();
  const shot = page.getByRole("img", { name: "Display 1 at check-in" });
  await expect(shot).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(row.getByText(/^Webcam frame removed by you on /)).toBeVisible();
  await expect(page.getByRole("img", { name: "Webcam at check-in" })).toHaveCount(0);
  await expectNoA11yViolations(page);

  // Her manager's day view: a tombstone, not a failed capture, and no delete button.
  const context = await browser.newContext();
  const manager = await context.newPage();
  await signIn(manager, "manager@acme.test", /\/team$/);
  await manager.goto(`/team/${ERIN}`);
  await manager
    .getByRole("region", { name: "Check-ins" })
    .getByRole("button", { name: /Passed/ })
    .filter({ has: manager.locator(timeAt(at)) })
    .click();
  const details = manager.getByRole("region", { name: /^Check-in · / });
  await expect(details).toContainText(/Webcam removed by Erin Employee on \d{1,2} \w{3}\./);
  await expect(details).toContainText("The check-in still counts as passed");
  await expect(details.getByText(/^Webcam frame removed by Erin Employee on /)).toBeVisible();
  await expect(details.getByText("Passed").first()).toBeVisible();
  await expect(details.getByRole("button", { name: /Delete/ })).toHaveCount(0);
  await details.getByRole("button", { name: "View captures" }).click();
  await expect(manager.getByRole("img", { name: "Display 1 at check-in" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(manager.getByRole("img", { name: "Webcam at check-in" })).toHaveCount(0);
  await expectNoA11yViolations(manager);
  await context.close();
});
