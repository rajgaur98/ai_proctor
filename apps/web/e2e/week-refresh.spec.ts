// #338 (TS-01, #41): the week page rebuilds the week's segments when it opens. When the
// rebuild-segments Edge Function doesn't answer, the page gives up after 15 s, says it
// couldn't refresh, shows the stored numbers and offers a retry, which recovers once the
// function answers again. Erin's week here is a past one nobody has touched, with an
// approved two-hour entry already rebuilt into stored segments.
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import {
  ERIN,
  ERIN_EMAIL,
  ERIN_ZONE,
  expectNoA11yViolations,
  freshErinWeek,
  MANAGER_EMAIL,
  rebuildSegments,
  weekDays,
} from "./helpers";

const REBUILD = "**/functions/v1/rebuild-segments";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

test("week page: a rebuild that never answers shows the stored week and a retry that recovers", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const week = await freshErinWeek();
  const day = weekDays(week)[1] ?? week;
  const at = (time: string) =>
    DateTime.fromISO(`${day}T${time}`, { zone: ERIN_ZONE }).toUTC().toISO() ?? "";

  // Two hours Erin asked for and her manager approved, rebuilt into stored segments.
  const erin = await clientFor(ERIN_EMAIL);
  const manager = await clientFor(MANAGER_EMAIL);
  const requested = await erin.rpc("request_manual_entry", {
    p_start_at: at("13:00"),
    p_end_at: at("15:00"),
    p_project_id: null as unknown as string,
    p_reason: `Refresh e2e ${Date.now()}`,
  });
  if (requested.error) throw requested.error;
  const decided = await manager.rpc("decide_manual_entry", {
    p_id: requested.data,
    p_approve: true,
  });
  if (decided.error) throw decided.error;
  await rebuildSegments(ERIN, [day], manager);

  await signIn(page, MANAGER_EMAIL, /\/team$/);
  // The function takes the calls and never answers.
  await page.route(REBUILD, () => undefined);
  const opened = Date.now();
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  await expect(page.getByText("Refreshing the week…")).toBeVisible();

  const failed = page.getByRole("alert").filter({ hasText: "Couldn't refresh the week" });
  await expect(failed).toBeVisible({ timeout: 20_000 });
  // It waited for the time limit rather than failing at once.
  expect(Date.now() - opened).toBeGreaterThan(14_000);
  await expect(page.getByText("Refreshing the week…")).toBeHidden();
  await expect(failed).toContainText("These are the last saved numbers.");

  // The stored segments are shown meanwhile.
  const totals = page.getByRole("region", { name: "Totals", exact: true });
  await expect(totals.getByRole("definition").first()).toHaveText("2 h 00 min");
  await expectNoA11yViolations(page);

  // The function answers again; Retry (from the keyboard) rebuilds the week.
  await page.unroute(REBUILD);
  const rebuilt = page.waitForResponse(
    (r) => r.url().includes("/functions/v1/rebuild-segments") && r.request().method() === "POST",
  );
  const retry = failed.getByRole("button", { name: "Retry" });
  await retry.focus();
  await page.keyboard.press("Enter");
  expect((await rebuilt).status()).toBe(200);
  await expect(failed).toBeHidden({ timeout: 20_000 });
  await expect(totals.getByRole("definition").first()).toHaveText("2 h 00 min");
});
