// #299 (TS-33 on the grid of TS-32): comments from the weekly grid. On Erin's submitted week
// Max comments on a row from its header and sees the count, and on a manual entry from its
// cell; Erin opens the row's thread from the grid and replies; an admin who doesn't review
// the week reads it. The grid's keyboard model is unchanged: the comment button is in the
// Tab order next to the row's cells. Order-independent: the week is one nobody has touched,
// picked per run.
import { weekOf } from "@ai-proctor/core";
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import {
  ERIN,
  ERIN_EMAIL,
  ERIN_ZONE,
  expectNoA11yViolations,
  MANAGER_EMAIL,
  rebuildSegments,
  weekDays,
} from "./helpers";

const REVAMP = "00000000-0000-4000-8000-0000000000f1";
const ADMIN_EMAIL = "admin@acme.test";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

async function signOut(page: Page, name: string) {
  await page.getByLabel(`Account menu for ${name}`).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

/**
 * A past day in a week of Erin's nobody has touched: no segments, no manual entries and
 * no timesheet. The local database keeps every earlier run, so it is picked per run.
 */
async function freshDay(): Promise<string> {
  const manager = await clientFor(MANAGER_EMAIL);
  for (let i = 0; i < 80; i++) {
    const day =
      DateTime.now()
        .setZone(ERIN_ZONE)
        .minus({ days: 400 + ((Date.now() + i * 17) % 900) })
        .toISODate() ?? "";
    const week = weekOf(day, "monday");
    const last = weekDays(week).at(-1) ?? week;
    const [segments, entries, sheets] = await Promise.all([
      manager
        .from("time_segments")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ERIN)
        .gte("day", week)
        .lte("day", last),
      manager
        .from("manual_entries")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ERIN)
        .gte("start_at", DateTime.fromISO(week, { zone: ERIN_ZONE }).minus({ days: 1 }).toISO())
        .lte("start_at", DateTime.fromISO(last, { zone: ERIN_ZONE }).plus({ days: 2 }).toISO()),
      manager
        .from("timesheets")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ERIN)
        .eq("period_start", week),
    ]);
    for (const r of [segments, entries, sheets]) if (r.error) throw r.error;
    if (segments.count === 0 && entries.count === 0 && sheets.count === 0) return day;
  }
  throw new Error("no fresh week found for Erin");
}

/** "13:00" as the page shows it: in the viewer's zone (the browser's, this machine's). */
const hm = (t: DateTime) => t.toLocal().toFormat("HH:mm");
const dayName = (d: string) => DateTime.fromISO(d, { zone: "utc" }).toFormat("ccc d LLL");

async function openGrid(page: Page, week: string) {
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  const grid = page.getByRole("grid", { name: "Week grid" });
  await expect(grid).toBeVisible({ timeout: 15_000 });
  return grid;
}

test("week grid comments: a manager comments on a row and an entry, the employee replies from the grid", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const rowComment = `Was this the checkout work? ${stamp}`;
  const entryComment = `What did the workshop cover? ${stamp}`;
  const reply = `Yes, the checkout flows ${stamp}`;
  const day = await freshDay();
  const week = weekOf(day, "monday");
  const days = weekDays(week);

  // Erin's approved two hours on Website revamp that day, in a week she has submitted.
  const start = DateTime.fromISO(`${day}T13:00`, { zone: ERIN_ZONE });
  const end = start.plus({ hours: 2 });
  const erin = await clientFor(ERIN_EMAIL);
  const manager = await clientFor(MANAGER_EMAIL);
  const requested = await erin.rpc("request_manual_entry", {
    p_start_at: start.toISO() ?? "",
    p_end_at: end.toISO() ?? "",
    p_project_id: REVAMP,
    p_reason: `Client workshop ${stamp}`,
  });
  if (requested.error) throw requested.error;
  const decided = await manager.rpc("decide_manual_entry", {
    p_id: requested.data,
    p_approve: true,
  });
  if (decided.error) throw decided.error;
  await rebuildSegments(ERIN, [day], manager);
  const sheet = await erin.rpc("ensure_timesheet", { p_user_id: ERIN, p_period_start: week });
  if (sheet.error) throw sheet.error;
  const submitted = await erin.rpc("submit_timesheet", { p_id: sheet.data });
  if (submitted.error) throw submitted.error;
  const entryName = `${hm(start)}–${hm(end)} on ${dayName(day)}`;

  // Max opens the week as a grid. Each row header has a comment button with its count; the
  // header itself is still named by the row alone.
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  const grid = await openGrid(page, week);
  await expect(grid.locator("tbody").getByRole("rowheader")).toHaveText([
    "Website revamp",
    "Unassigned",
  ]);
  await expect(grid.getByRole("rowheader", { name: "Website revamp", exact: true })).toBeVisible();
  const rowButton = (n: number) =>
    grid.getByRole("button", { name: `Comments on Website revamp, ${n}`, exact: true });
  await expect(rowButton(0)).toBeVisible();
  await expect(
    grid.getByRole("button", { name: "Comments on Unassigned, 0", exact: true }),
  ).toBeVisible();
  await expectNoA11yViolations(page);

  // The button is in the Tab order next to the row's cells, and the arrow keys still move
  // between cells only.
  const cell = (row: string, d: string) =>
    grid.getByRole("gridcell", { name: new RegExp(`^${row}, ${dayName(d)}:`) });
  await rowButton(0).focus();
  await page.keyboard.press("Tab");
  await expect(cell("Website revamp", days[0] ?? week)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(cell("Website revamp", days[1] ?? week)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(cell("Unassigned", days[1] ?? week)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+Tab");
  await expect(rowButton(0)).toBeFocused();

  // He opens the row's thread with the keyboard and comments.
  await page.keyboard.press("Enter");
  const thread = page.getByRole("dialog", { name: "Comments on Website revamp" });
  await expect(thread).toBeVisible();
  await expect(thread).toContainText("No comments yet.");
  await thread.getByRole("button", { name: "Comment on Website revamp" }).click();
  await thread.getByLabel("Comment on Website revamp").fill(rowComment);
  await expectNoA11yViolations(page);
  await thread.getByRole("button", { name: "Post comment" }).click();
  await expect(thread.getByRole("listitem").filter({ hasText: rowComment })).toContainText("You");
  await expect(thread.getByRole("button", { name: "Reply on Website revamp" })).toBeVisible();
  await expectNoA11yViolations(page);

  // Escape closes it and gives the focus back to the button, which counts the comment.
  await page.keyboard.press("Escape");
  await expect(thread).toBeHidden();
  await expect(rowButton(1)).toBeFocused();
  await expect(rowButton(1)).toHaveAttribute("data-count", "1");
  // The Comments panel stays, as the review summary.
  await expect(
    page
      .getByRole("region", { name: /^Comments/ })
      .getByRole("region", { name: "Website revamp", exact: true }),
  ).toContainText(rowComment);

  // He comments on the manual entry from its cell.
  await cell("Website revamp", day).click();
  const cellDialog = page.getByRole("dialog", { name: `Website revamp · ${dayName(day)}` });
  await expect(cellDialog).toBeVisible();
  await cellDialog.getByRole("button", { name: `Comments on ${entryName}` }).click();
  await cellDialog.getByRole("button", { name: `Comment on ${entryName}` }).click();
  await cellDialog.getByLabel(`Comment on ${entryName}`).fill(entryComment);
  await cellDialog.getByRole("button", { name: "Post comment" }).click();
  await expect(cellDialog.getByText(entryComment)).toBeVisible();
  await expect(
    cellDialog.getByRole("button", { name: `Comments on ${entryName} (1)` }),
  ).toBeVisible();
  await expectNoA11yViolations(page);
  await page.keyboard.press("Escape");
  await expect(cellDialog).toBeHidden();
  // An entry's comments aren't the row's: its count is unchanged.
  await expect(rowButton(1)).toBeVisible();
  await signOut(page, "Max Manager");

  // Erin opens the row's thread from her grid, reads Max's comment and replies.
  await signIn(page, ERIN_EMAIL, /\/me$/);
  const erinGrid = await openGrid(page, week);
  const erinRow = (n: number) =>
    erinGrid.getByRole("button", { name: `Comments on Website revamp, ${n}`, exact: true });
  await erinRow(1).click();
  const erinThread = page.getByRole("dialog", { name: "Comments on Website revamp" });
  await expect(erinThread.getByRole("listitem").filter({ hasText: rowComment })).toContainText(
    "Max Manager",
  );
  await erinThread.getByRole("button", { name: "Reply on Website revamp" }).click();
  await erinThread.getByLabel("Comment on Website revamp").fill(reply);
  await erinThread.getByRole("button", { name: "Post comment" }).click();
  await expect(erinThread.getByRole("listitem").filter({ hasText: reply })).toContainText("You");
  await expectNoA11yViolations(page);
  await erinThread.getByRole("button", { name: "Close" }).click();
  await expect(erinThread).toBeHidden();
  await expect(erinRow(2)).toBeVisible();

  // And she reads the entry's thread in its cell.
  await erinGrid
    .getByRole("gridcell", { name: new RegExp(`^Website revamp, ${dayName(day)}:`) })
    .click();
  const erinCell = page.getByRole("dialog", { name: `Website revamp · ${dayName(day)}` });
  await erinCell.getByRole("button", { name: `Comments on ${entryName} (1)` }).click();
  // The comment is the innermost list item (the entry's own item holds its thread).
  await expect(
    erinCell.getByRole("listitem").filter({ hasText: entryComment }).last(),
  ).toContainText("Max Manager");
  await expect(erinCell.getByRole("button", { name: `Reply on ${entryName}` })).toBeVisible();
  await expectNoA11yViolations(page);
  await page.keyboard.press("Escape");
  await signOut(page, "Erin Employee");

  // Max is told about Erin's reply.
  const told = await manager
    .from("notifications")
    .select("payload")
    .eq("kind", "timesheet.commented");
  if (told.error) throw told.error;
  expect(told.data.map((n) => (n.payload as { excerpt?: string }).excerpt)).toContain(reply);

  // An admin who doesn't review Erin's week reads the threads but can't write.
  await signIn(page, ADMIN_EMAIL, /\/team$/);
  const adminGrid = await openGrid(page, week);
  await adminGrid
    .getByRole("button", { name: "Comments on Website revamp, 2", exact: true })
    .click();
  const adminThread = page.getByRole("dialog", { name: "Comments on Website revamp" });
  await expect(adminThread.getByRole("listitem")).toHaveCount(2);
  await expect(adminThread.getByRole("button", { name: /^(Reply|Comment) on / })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // A row with no comments has no button for someone who can't write.
  await expect(adminGrid.getByRole("button", { name: /^Comments on Unassigned/ })).toHaveCount(0);
});
