// #323 (DSH-01, DSH-11): the Live team list with more people on shift than it draws at once.
// The team read is answered with the seed's real rows plus LIST_PEOPLE made-up Offline people
// (so the list is long without seeding thousands of users); Erin is real and Active, so in
// status order she sits below all of them, off screen. Checks that only the rows on screen are
// in the page, that the table tells screen readers its full size, scrolling to the end, a live
// update on an off-screen row, the keys (the window follows the focus), sorting, search and
// export of every row, and axe.
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { agentFor } from "./agent";
import { expectNoA11yViolations, MANAGER_EMAIL, pressUntilFocused } from "./helpers";

const LIST_PEOPLE = 600;
const ORG = "00000000-0000-4000-8000-000000000001";
const MAX = "00000000-0000-4000-8000-0000000000b1";

function madeUp(i: number) {
  return {
    user_id: `00000000-0000-4000-9323-${String(i).padStart(12, "0")}`,
    org_id: ORG,
    full_name: `List Person ${String(i).padStart(4, "0")}`,
    role: "employee",
    manager_id: MAX,
    timezone: "America/Los_Angeles",
    status: "offline",
    since: new Date(Date.now() - (i % 90) * 60_000).toISOString(),
    last_checkin_at: null,
    last_checkin_outcome: null,
    project_id: null,
    checkins_shown_today: 0,
    checkins_passed_today: 0,
    scheduled_today: true,
    tamper_reason: null,
    team_id: null,
  };
}

/** Adds the made-up people to every read of the team (one page: fewer than a thousand rows). */
async function longTeam(page: Page) {
  const extra = Array.from({ length: LIST_PEOPLE }, (_, i) => madeUp(i + 1));
  await page.route(/\/rest\/v1\/team_live\b/, async (route) => {
    const response = await route.fetch();
    const real = (await response.json()) as unknown[];
    const rows = [...real, ...extra];
    const headers: Record<string, string> = {
      ...response.headers(),
      "content-range": `0-${rows.length - 1}/${rows.length}`,
    };
    delete headers["content-length"];
    delete headers["content-encoding"];
    await route.fulfill({ response, json: rows, headers });
  });
}

const drawnRows = (page: Page) => page.locator("table tbody tr[aria-rowindex]");

/** The aria-rowindex of the row whose link has focus (the header row is 1). */
const focusedRow = (page: Page) =>
  page.evaluate(() =>
    Number(document.activeElement?.closest("tr")?.getAttribute("aria-rowindex") ?? 0),
  );

test("a long live list draws only the rows on screen and follows scrolling, live updates and the keys", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const erin = await agentFor("erin@acme.test");
  await erin("clock_out", { reason: "manual" });
  await erin("clock_in", { reason: "manual" });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await longTeam(page);
    await page.goto("/sign-in");
    await page.getByLabel("Work email").fill(MANAGER_EMAIL);
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
    await expect(page.locator('[aria-live="polite"]')).toHaveText(/^Live/, { timeout: 10_000 });

    // The whole list's size for screen readers; only a screenful (and a few) in the page.
    const table = page.getByRole("table");
    await expect(page.getByRole("link", { name: "View day for List Person 0001" })).toBeVisible();
    const total = Number(await table.getAttribute("aria-rowcount")) - 1;
    expect(total).toBeGreaterThan(LIST_PEOPLE);
    await expect(table.getByRole("caption")).toContainText(`On shift, ${total} people.`);
    expect(await drawnRows(page).count()).toBeLessThan(60);
    await expect(drawnRows(page).first()).toHaveAttribute("aria-rowindex", "2");
    const erinRow = page.getByRole("row").filter({ hasText: "Erin Employee" });
    await expect(erinRow).toHaveCount(0);
    await expectNoA11yViolations(page);

    // A live update to a row that isn't drawn shows when it's scrolled to.
    await erin("lock");
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(erinRow).toBeInViewport();
    await expect(erinRow.getByText("Away · locked")).toBeVisible({ timeout: 15_000 });
    // The end of the list is its last row, in place.
    const lastRow = page.locator(`tr[aria-rowindex="${total + 1}"]`);
    await expect(lastRow).toBeInViewport();
    expect(await drawnRows(page).count()).toBeLessThan(60);
    await expectNoA11yViolations(page);

    // From the keyboard, under reduced motion: no scrolling animation, the row is on screen
    // as soon as the key is handled.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => window.scrollTo(0, 0));
    const first = drawnRows(page).first().getByRole("link");
    await page.getByRole("searchbox", { name: "Search people" }).focus();
    await pressUntilFocused(page, first);
    await page.keyboard.press("End");
    const lastLink = lastRow.getByRole("link");
    await expect(lastLink).toBeFocused();
    expect(await lastRow.evaluate((tr) => tr.getBoundingClientRect().bottom <= innerHeight)).toBe(
      true,
    );
    await page.keyboard.press("Home");
    expect(await focusedRow(page)).toBe(2);
    await expect(page.locator("a:focus")).toBeInViewport();
    await page.keyboard.press("ArrowDown");
    expect(await focusedRow(page)).toBe(3);
    await page.keyboard.press("PageDown");
    expect(await focusedRow(page)).toBeGreaterThan(8);
    await expect(page.locator("a:focus")).toBeInViewport();
    // Tab goes row to row as it always did, and the window keeps up.
    const before = await focusedRow(page);
    for (let i = 0; i < 30; i++) await page.keyboard.press("Tab");
    expect(await focusedRow(page)).toBe(before + 30);
    await expect(page.locator("a:focus")).toBeInViewport();
    await page.keyboard.press("Shift+Tab");
    expect(await focusedRow(page)).toBe(before + 29);

    // The focused row stays in the page when it's scrolled far away, so the keys pick up from
    // it.
    const held = await focusedRow(page);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.locator(`tr[aria-rowindex="${held}"] a`)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    expect(await focusedRow(page)).toBe(held - 1);
    await expect(page.locator("a:focus")).toBeInViewport();
    await page.emulateMedia({ reducedMotion: null });

    // Sorting and search work on every row, not only the drawn ones.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByLabel("Sort").selectOption("name");
    await expect(drawnRows(page).first()).not.toContainText("List Person");
    await page.getByRole("searchbox", { name: "Search people" }).fill("List Person 0600");
    await expect(drawnRows(page)).toHaveCount(1);
    await expect(drawnRows(page).first()).toContainText("List Person 0600");
    await page.getByRole("searchbox", { name: "Search people" }).fill("");

    // The export is every row on the list, drawn or not.
    await page.getByRole("button", { name: "Export live team" }).click();
    const dialog = page.getByRole("dialog", { name: "Export live team" });
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download CSV" }).click();
    const file = await download;
    const lines = (await readFile((await file.path()) ?? "", "utf8")).split("\r\n");
    expect(lines.filter((l) => l !== "")).toHaveLength(total + 1);
    await page.keyboard.press("Escape");

    // On a phone a row stacks its cells into a taller card; the window measures it again and the end
    // of the list is still its last row.
    await page.setViewportSize({ width: 390, height: 800 });
    // The list grows once the taller rows are measured, so scroll to the end until it stays.
    await expect(async () => {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(lastRow).toBeInViewport({ timeout: 500 });
    }).toPass({ timeout: 5_000 });
    expect(await drawnRows(page).count()).toBeLessThan(60);
    await expectNoA11yViolations(page);
  } finally {
    await erin("unlock");
    await erin("clock_out", { reason: "manual" });
  }
});
