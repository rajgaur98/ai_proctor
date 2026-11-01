// Copying last week into this one on the week grid (#264, TS-34), and which pinned rows
// show. Pure, so it's unit-tested. By default only last week's rows (project/task) are
// copied, as empty rows. With "include hours", last week's manual entries are copied too:
// each becomes a new request seven local days later at the same times (the database does
// it, under every rule of a request), and each one that can't be copied is skipped with
// its reason. Tracked time is never copied.
import { DateTime } from "luxon";
import type { ManualEntry } from "../day/entryData";
import type { Project, Task } from "../projects/projectData";
import { localDay } from "./dayList";
import { assignmentKey, type BreakdownRow } from "./summary";
import type { GridAssignment } from "./weekGridModel";

/** Why an entry isn't copied: the database's rule codes, and entry_not_found. */
export type SkipCode = string;

export interface CopyItem {
  entry: ManualEntry;
  /** Where the copy goes: the same local times, seven days later. */
  startAt: string;
  endAt: string;
  /** Why it won't be copied, as far as the browser can tell; null if it should be. */
  expected: SkipCode | null;
}

export interface CopyResult {
  entryId: string;
  /** The new entry, when it was copied. */
  id: string | null;
  skipped: SkipCode | null;
}

export interface CopyOutcome {
  entry: ManualEntry;
  startAt: string;
  endAt: string;
  /** Null when it was copied. */
  skipped: SkipCode | null;
}

/** `iso` moved seven local days on in `zone`: the same weekday and wall-clock time. */
export function nextWeekTime(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { zone }).plus({ days: 7 }).toISO() ?? iso;
}

/** Whether the person can log new time to `a` now: Unassigned, or a project of theirs and an active task of it. */
export function canLogTo(a: GridAssignment, mine: Project[], tasks: Task[]): boolean {
  if (a.projectId === null) return true;
  if (!mine.some((p) => p.id === a.projectId)) return false;
  return (
    a.taskId === null ||
    tasks.some((t) => t.id === a.taskId && t.projectId === a.projectId && !t.archived)
  );
}

function unique(rows: GridAssignment[]): GridAssignment[] {
  const seen = new Map<string, GridAssignment>();
  for (const r of rows) {
    const key = assignmentKey(r.projectId, r.taskId);
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

/**
 * Last week's rows (its `days`): every project/task with time in it, tracked or manual
 * (rejected entries and excluded time don't count), and the rows `added` to it. Only rows
 * the person can still log to; Unassigned is always a row, so it isn't one of them.
 */
export function lastWeekRows(
  days: string[],
  breakdown: BreakdownRow[],
  entries: ManualEntry[],
  zone: string,
  added: GridAssignment[],
  canLog: (a: GridAssignment) => boolean,
): GridAssignment[] {
  const rows: GridAssignment[] = [];
  for (const r of breakdown) {
    if (days.includes(r.day) && !r.excluded && r.seconds > 0) {
      rows.push({ projectId: r.projectId, taskId: r.projectId ? (r.taskId ?? null) : null });
    }
  }
  for (const e of entries) {
    if (e.status !== "rejected" && days.includes(localDay(e.startAt, zone))) {
      rows.push({ projectId: e.projectId, taskId: e.projectId ? e.taskId : null });
    }
  }
  rows.push(...added);
  return unique(rows).filter((a) => a.projectId !== null && canLog(a));
}

/**
 * What "include hours" copies: last week's (`days`) pending and approved manual entries,
 * in time order, each with where its copy goes and why it won't be copied if the browser
 * can already tell (it would end after `now`, or its project or task can't take time).
 * The database decides; overlaps and locked days only it can see.
 */
export function copyPlan(
  entries: ManualEntry[],
  days: string[],
  zone: string,
  now: DateTime,
  canLog: (a: GridAssignment) => boolean,
): CopyItem[] {
  return entries
    .filter((e) => e.status !== "rejected" && days.includes(localDay(e.startAt, zone)))
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
    .map((entry) => {
      const startAt = nextWeekTime(entry.startAt, zone);
      const endAt = nextWeekTime(entry.endAt, zone);
      const a = { projectId: entry.projectId, taskId: entry.taskId };
      const expected =
        Date.parse(endAt) > now.toMillis()
          ? "in_the_future"
          : !canLog({ projectId: a.projectId, taskId: null })
            ? "project_not_allowed"
            : !canLog(a)
              ? "task_not_allowed"
              : null;
      return { entry, startAt, endAt, expected };
    });
}

/** The plan with what the database did: copied, or skipped and why. */
export function copyOutcomes(plan: CopyItem[], results: CopyResult[]): CopyOutcome[] {
  const byId = new Map(results.map((r) => [r.entryId, r]));
  return plan.map(({ entry, startAt, endAt }) => {
    const r = byId.get(entry.id);
    return {
      entry,
      startAt,
      endAt,
      skipped: r ? (r.id ? null : (r.skipped ?? "entry_not_found")) : "entry_not_found",
    };
  });
}

const skipTexts: Record<string, string> = {
  in_the_future: "It would end in the future.",
  project_not_allowed: "You can't log time to its project any more.",
  task_not_allowed: "Its task isn't available any more.",
  overlaps_clocked_time: "It overlaps time you were clocked in.",
  overlaps_manual_entry: "It overlaps another manual entry.",
  day_locked: "Its day is in an approved timesheet.",
  range_too_long: "It's longer than 24 hours.",
  entry_not_found: "It no longer exists.",
};

/** Why an entry was skipped, in words. */
export function skipText(code: SkipCode): string {
  return skipTexts[code] ?? code;
}

/**
 * The pinned rows that show on the grid: projects the person can log to and active tasks
 * of them. Others stay pinned (the person can unpin them) but aren't shown.
 */
export function shownFavourites(
  favourites: GridAssignment[],
  canLog: (a: GridAssignment) => boolean,
): GridAssignment[] {
  return favourites.filter((f) => f.projectId !== null && canLog(f));
}

/** Whether `a` is one of `favourites`. */
export function isFavourite(favourites: GridAssignment[], a: GridAssignment): boolean {
  const key = assignmentKey(a.projectId, a.taskId);
  return favourites.some((f) => assignmentKey(f.projectId, f.taskId) === key);
}
