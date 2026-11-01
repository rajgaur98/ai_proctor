// #265 (#254 part 6, TS-33): comments on a week's rows and manual entries, and the lock
// banner. On Erin's submitted week Max comments on a row and on an entry, Erin sees who
// submitted it and replies, and each side is notified. Order-independent: the week is one
// nobody has touched, picked per run.
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

/** The `timesheet.commented` notifications someone has about a comment, by its words. */
async function toldAbout(email: string, words: string) {
  const client = await clientFor(email);
  const { data, error } = await client
    .from("notifications")
    .select("payload")
    .eq("kind", "timesheet.commented");
  if (error) throw error;
  return data
    .map((n) => n.payload as { excerpt?: string; to?: string })
    .filter((p) => p.excerpt === words);
}

test("comments: a manager comments on a row and an entry, the employee replies; the week shows it's locked", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  const rowComment = `Was this the checkout work? ${stamp}`;
  const entryComment = `What did the workshop cover? ${stamp}`;
  const reply = `Yes, the checkout flows ${stamp}`;
  const day = await freshDay();
  const week = weekOf(day, "monday");

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

  // Max opens the week: it's locked for Erin, and says who submitted it and when.
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  await expect(
    page.getByText(
      /^Submitted by Erin Employee on \w{3} \d{1,2} \w{3}, \d\d:\d\d\. Locked for Erin while it's reviewed\.$/,
    ),
  ).toBeVisible({ timeout: 15_000 });

  // He comments on the Website revamp row.
  const panel = page.getByRole("region", { name: /^Comments/ });
  const row = panel.getByRole("region", { name: "Website revamp", exact: true });
  await expect(row).toContainText("No comments yet.");
  await row.getByRole("button", { name: "Comment on Website revamp" }).click();
  await row.getByRole("button", { name: "Post comment" }).click();
  await expect(row.getByRole("alert")).toHaveText("Write a comment");
  await row.getByLabel("Comment on Website revamp").fill(rowComment);
  await expectNoA11yViolations(page);
  await row.getByRole("button", { name: "Post comment" }).click();
  await expect(row.getByRole("listitem").filter({ hasText: rowComment })).toContainText("You");
  await expect(row.getByRole("button", { name: "Reply on Website revamp" })).toBeVisible();

  // And on the manual entry, from the day list.
  const theDay = page
    .getByRole("region", { name: "Days", exact: true })
    .getByRole("region", { name: dayName(day), exact: true });
  await theDay.getByRole("button", { name: `Comments on ${entryName}` }).click();
  await theDay.getByRole("button", { name: `Comment on ${entryName}` }).click();
  await theDay.getByLabel(`Comment on ${entryName}`).fill(entryComment);
  await theDay.getByRole("button", { name: "Post comment" }).click();
  await expect(theDay.getByText(entryComment)).toBeVisible();
  await expect(theDay.getByRole("button", { name: `Comments on ${entryName} (1)` })).toBeVisible();
  // The panel shows it under the entry's row too.
  await expect(row).toContainText(`On the entry ${entryName}`);
  await expect(row).toContainText(entryComment);
  await expectNoA11yViolations(page);

  // Erin is told about both.
  expect(await toldAbout(ERIN_EMAIL, rowComment)).toEqual([
    expect.objectContaining({ to: "employee" }),
  ]);
  expect(await toldAbout(ERIN_EMAIL, entryComment)).toHaveLength(1);
  expect(await toldAbout(MANAGER_EMAIL, rowComment)).toHaveLength(0);
  await signOut(page, "Max Manager");

  // Erin sees her week locked while it's reviewed, reads Max's comment and replies.
  await signIn(page, ERIN_EMAIL, /\/me$/);
  await page.goto(`/timesheets/${ERIN}?week=${week}`);
  await expect(
    page.getByText(
      /^Submitted by you on \w{3} \d{1,2} \w{3}, \d\d:\d\d\. Locked while your manager reviews it\.$/,
    ),
  ).toBeVisible({ timeout: 15_000 });
  const erinRow = page
    .getByRole("region", { name: /^Comments/ })
    .getByRole("region", { name: "Website revamp", exact: true });
  await expect(erinRow.getByRole("listitem").filter({ hasText: rowComment })).toContainText(
    "Max Manager",
  );
  await erinRow.getByRole("button", { name: "Reply on Website revamp" }).click();
  await erinRow.getByLabel("Comment on Website revamp").fill(reply);
  await erinRow.getByRole("button", { name: "Post comment" }).click();
  await expect(erinRow.getByRole("listitem").filter({ hasText: reply })).toContainText("You");
  await expectNoA11yViolations(page);

  // Max is told about the reply; Erin isn't told about her own.
  expect(await toldAbout(MANAGER_EMAIL, reply)).toEqual([
    expect.objectContaining({ to: "reviewer" }),
  ]);
  expect(await toldAbout(ERIN_EMAIL, reply)).toHaveLength(0);
});
