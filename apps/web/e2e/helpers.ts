// Shared e2e setup for the seeded Acme org. Specs share the seed users and the local
// database keeps every earlier run, so each spec creates what it reads and puts shared
// state (Erin's week) back where it needs it: it must pass alone and after any other (#195).
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { DateTime } from "luxon";
import { agentFor, clientFor } from "./agent";

export const ERIN = "00000000-0000-4000-8000-0000000000c1";
export const ERIN_EMAIL = "erin@acme.test";
export const MANAGER_EMAIL = "manager@acme.test";
export const ERIN_ZONE = "America/Los_Angeles";

/** Erin's current week, Monday-based like the seed org, in her time zone. */
export const erinWeek = DateTime.now().setZone(ERIN_ZONE).startOf("week").toISODate() ?? "";

/** The seven ISO dates of the week starting `week`. */
export function weekDays(week: string): string[] {
  return Array.from(
    { length: 7 },
    (_, d) => DateTime.fromISO(week).plus({ days: d }).toISODate() ?? week,
  );
}

/** Erin's today, in her time zone. */
export function erinToday(): string {
  return DateTime.now().setZone(ERIN_ZONE).toISODate() ?? "";
}

/**
 * Rebuilds a person's time segments for `days` now, rather than waiting for the
 * five-minute job (which needs Vault secrets the e2e stack doesn't set).
 */
export async function rebuildSegments(
  userId: string,
  days: string[],
  client?: Awaited<ReturnType<typeof clientFor>>,
) {
  const as = client ?? (await clientFor(MANAGER_EMAIL));
  const results = await Promise.all(
    days.map((day) => as.functions.invoke("rebuild-segments", { body: { user_id: userId, day } })),
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) throw failed.error;
}

/** Opens every one of Erin's weeks to changes again, whatever earlier specs did to them. */
export async function resetErinWeeks() {
  const manager = await clientFor(MANAGER_EMAIL);
  const { data, error } = await manager.from("timesheets").select("id, status").eq("user_id", ERIN);
  if (error) throw error;
  for (const sheet of data) {
    if (sheet.status === "approved") {
      const r = await manager.rpc("reopen_timesheet", { p_id: sheet.id, p_reason: "e2e reset" });
      if (r.error) throw r.error;
    }
    if (sheet.status === "approved" || sheet.status === "submitted") {
      const r = await manager.rpc("return_timesheet", { p_id: sheet.id, p_comment: "e2e reset" });
      if (r.error) throw r.error;
    }
  }
}

/**
 * Reopens every approved week of a person the manager manages (back to submitted), so a
 * spec can set reasons on their misses (#252: an approved week locks them) whatever
 * earlier specs approved.
 */
export async function reopenApprovedWeeks(userId: string) {
  const manager = await clientFor(MANAGER_EMAIL);
  const { data, error } = await manager
    .from("timesheets")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "approved");
  if (error) throw error;
  for (const sheet of data) {
    const r = await manager.rpc("reopen_timesheet", { p_id: sheet.id, p_reason: "e2e reset" });
    if (r.error) throw r.error;
  }
}

/**
 * Unpins every row Erin pinned to her week grid (#264): pinned rows are on every week, so
 * a spec that pins puts them back, and a spec that counts the grid's rows starts clean.
 */
export async function clearErinFavourites() {
  const erin = await clientFor(ERIN_EMAIL);
  const { data, error } = await erin.from("timesheet_favourites").select("project_id, task_id");
  if (error) throw error;
  for (const f of data) {
    const r = await erin.rpc("set_timesheet_favourite", {
      p_project_id: f.project_id,
      p_task_id: f.task_id as string,
      p_pinned: false,
    });
    if (r.error) throw r.error;
  }
}

/** Erin submits her current week (call `resetErinWeeks` first). Returns the sheet's id. */
export async function submitErinWeek(): Promise<string> {
  const erin = await clientFor(ERIN_EMAIL);
  const ensured = await erin.rpc("ensure_timesheet", { p_user_id: ERIN, p_period_start: erinWeek });
  if (ensured.error) throw ensured.error;
  const submitted = await erin.rpc("submit_timesheet", { p_id: ensured.data });
  if (submitted.error) throw submitted.error;
  return ensured.data;
}

/**
 * Erin works a short stretch today with a missed check-in, so her week has worked time
 * and an unverified, flagged segment. Today's segments are rebuilt before it returns.
 */
export async function flaggedTime() {
  const erin = await agentFor(ERIN_EMAIL);
  await erin("clock_out", { reason: "manual" });
  await erin("clock_in", { reason: "manual" });
  await erin("checkin", {
    // Scheduled well before it was shown, so it sorts ahead of the check-ins other
    // specs add today.
    scheduled_at: new Date(Date.now() - 3_600_000).toISOString(),
    shown_at: new Date().toISOString(),
    outcome: "miss",
    wrong_clicks: 0,
    idle_s_at_show: 0,
    device_state: "active",
    object_keys: [],
    flags: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await erin("clock_out", { reason: "manual" });
  await rebuildSegments(ERIN, [erinToday()]);
}

/**
 * Settles every flagged segment in Erin's week as `client` (who must be able to decide
 * it): kept, or included again if an earlier run excluded it. Rebuilds the week first,
 * as the timesheet page does when it opens, so no flagged time other specs left is missed.
 */
export async function settleErinFlagged(
  client: Awaited<ReturnType<typeof clientFor>>,
  sheetId: string,
) {
  await rebuildSegments(
    ERIN,
    weekDays(erinWeek).filter((d) => d <= erinToday()),
    client,
  );
  const flagged = await client.rpc("timesheet_flagged_segments", {
    p_user_id: ERIN,
    p_from: erinWeek,
    p_to: weekDays(erinWeek).at(-1) ?? erinWeek,
  });
  if (flagged.error) throw flagged.error;
  for (const s of flagged.data) {
    const kept = await client.rpc("edit_segment", {
      p_timesheet_id: sheetId,
      p_kind: s.decision === "exclude" ? "include" : "keep",
      p_start_at: s.start_at,
      p_end_at: s.end_at,
      p_project_id: null as unknown as string,
      p_reason: "e2e" as string,
    });
    if (kept.error) throw kept.error;
  }
}

/**
 * A CSS selector for the `<time>` a check-in row shows, to the second, so a spec picks
 * the row it created rather than the newest (other specs add check-ins on the same day).
 */
export function timeAt(iso: string): string {
  return `time[datetime^="${iso.slice(0, 19)}"]`;
}

/**
 * A team of `userIds` in the Acme org (#66), made as the admin, with a name no other run
 * uses. The people named leave whatever team they were in. Remove it with `removeTeam`.
 */
export async function makeTeam(
  prefix: string,
  userIds: string[],
): Promise<{ id: string; name: string }> {
  const admin = await clientFor("admin@acme.test");
  const name = `${prefix} ${Date.now()}`;
  const saved = await admin.rpc("save_team", {
    p_team_id: null as unknown as string,
    p_name: name,
  });
  if (saved.error) throw saved.error;
  const members = await admin.rpc("set_team_members", {
    p_team_id: saved.data,
    p_user_ids: userIds,
  });
  if (members.error) throw members.error;
  return { id: saved.data, name };
}

/** Deletes a team `makeTeam` made; its members are left without a team. */
export async function removeTeam(id: string) {
  const admin = await clientFor("admin@acme.test");
  const { error } = await admin.rpc("delete_team", { p_team_id: id });
  if (error) throw error;
}

/** Runs axe (WCAG 2 A/AA, 2.1 AA) on the page and fails on any violation. */
export async function expectNoA11yViolations(page: Page) {
  // An element mid-animation can fail color-contrast for a frame, so let running
  // animations finish before axe measures (not endless ones like a spinner, which never
  // finish). This can't catch one that starts while axe runs, e.g. a control enabled when
  // its data arrives, so controls switch state without a fade (#285, the Button).
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}
