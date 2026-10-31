// The week's day list (#263, TS-30): tracked time and manual entries per local day, and
// the times the split, merge and duplicate actions send. Pure, so it's unit-tested; the
// database checks every rule again. Seconds stay raw (TS-05); only display rounds.
import { DateTime } from "luxon";
import type { ManualEntry } from "../day/entryData";
import type { Project, Task } from "../projects/projectData";

/** A stored segment of counted time, as the day list reads it. */
export interface TrackedSegment {
  day: string;
  type: string;
  startAt: string;
  endAt: string;
  projectId: string | null;
  taskId: string | null;
  flagged: boolean;
  excluded: boolean;
}

export type DayItem =
  | {
      kind: "tracked";
      startAt: string;
      endAt: string;
      seconds: number;
      projectId: string | null;
      taskId: string | null;
      flagged: boolean;
      excluded: boolean;
    }
  | { kind: "manual"; startAt: string; endAt: string; seconds: number; entry: ManualEntry };

export interface DayList {
  day: string;
  items: DayItem[];
}

function seconds(startAt: string, endAt: string): number {
  return (Date.parse(endAt) - Date.parse(startAt)) / 1000;
}

/** The local day (in `zone`) an instant falls on. */
export function localDay(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { zone }).toISODate() ?? "";
}

/** "13:05" in `zone`. */
export function localTime(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { zone }).toFormat("HH:mm");
}

/** The instant of `time` ("HH:mm") on `day` in `zone`; null when either is missing. */
export function atLocal(day: string, time: string, zone: string): DateTime | null {
  if (!day || !/^\d{2}:\d{2}$/.test(time)) return null;
  const t = DateTime.fromISO(`${day}T${time}`, { zone });
  return t.isValid ? t : null;
}

/**
 * Tracked segments as runs: back-to-back segments of the same project, task and review
 * state read as one stretch (the rebuild cuts time at every check-in and status change).
 * Manual segments are left out: the day list shows the entries themselves.
 */
export function trackedRuns(segments: TrackedSegment[]): Extract<DayItem, { kind: "tracked" }>[] {
  const sorted = segments
    .filter((s) => s.type !== "manual")
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const runs: Extract<DayItem, { kind: "tracked" }>[] = [];
  for (const s of sorted) {
    const last = runs.at(-1);
    if (
      last &&
      Date.parse(last.endAt) === Date.parse(s.startAt) &&
      last.projectId === s.projectId &&
      last.taskId === s.taskId &&
      last.flagged === s.flagged &&
      last.excluded === s.excluded
    ) {
      last.endAt = s.endAt;
      last.seconds += seconds(s.startAt, s.endAt);
    } else {
      runs.push({
        kind: "tracked",
        startAt: s.startAt,
        endAt: s.endAt,
        seconds: seconds(s.startAt, s.endAt),
        projectId: s.projectId,
        taskId: s.taskId,
        flagged: s.flagged,
        excluded: s.excluded,
      });
    }
  }
  return runs;
}

/**
 * Each day of the week with its tracked runs and manual entries in time order. A
 * segment belongs to its stored day; an entry to the local day it starts on.
 */
export function weekDayList(
  days: string[],
  segments: TrackedSegment[],
  entries: ManualEntry[],
  zone: string,
): DayList[] {
  return days.map((day) => {
    const tracked = trackedRuns(segments.filter((s) => s.day === day));
    const manual: DayItem[] = entries
      .filter((e) => localDay(e.startAt, zone) === day)
      .map((e) => ({
        kind: "manual",
        startAt: e.startAt,
        endAt: e.endAt,
        seconds: seconds(e.startAt, e.endAt),
        entry: e,
      }));
    const items = [...tracked, ...manual].sort(
      (a, b) => Date.parse(a.startAt) - Date.parse(b.startAt),
    );
    return { day, items };
  });
}

/**
 * Whether `next` can be merged into `entry`: both the employee's to change (not
 * rejected), the first ending where the second starts, on the same local day, with the
 * same project and task (merge_manual_entries).
 */
export function canMerge(entry: ManualEntry, next: ManualEntry, zone: string): boolean {
  return (
    entry.id !== next.id &&
    entry.status !== "rejected" &&
    next.status !== "rejected" &&
    Date.parse(entry.endAt) === Date.parse(next.startAt) &&
    localDay(entry.startAt, zone) === localDay(next.startAt, zone) &&
    entry.projectId === next.projectId &&
    entry.taskId === next.taskId
  );
}

/** The entry of `entries` that `entry` can merge with (the one it runs into), if any. */
export function mergePartner(
  entry: ManualEntry,
  entries: ManualEntry[],
  zone: string,
): ManualEntry | null {
  return entries.find((n) => canMerge(entry, n, zone)) ?? null;
}

/**
 * The instant `time` ("HH:mm", in `zone`) inside the entry, for a split: on the entry's
 * start day, or the next day for an entry that runs past midnight. Null when it isn't
 * strictly between the entry's start and end.
 */
export function splitPoint(entry: ManualEntry, time: string, zone: string): string | null {
  const start = Date.parse(entry.startAt);
  const end = Date.parse(entry.endAt);
  const day = localDay(entry.startAt, zone);
  for (const d of [day, DateTime.fromISO(day).plus({ days: 1 }).toISODate() ?? ""]) {
    const at = atLocal(d, time, zone);
    if (at && at.toMillis() > start && at.toMillis() < end) return at.toISO();
  }
  return null;
}

/** A whole minute near the middle of the entry, as "HH:mm" in `zone`: the split dialog's default. */
export function middleTime(entry: ManualEntry, zone: string): string {
  const mid = (Date.parse(entry.startAt) + Date.parse(entry.endAt)) / 2;
  return DateTime.fromMillis(mid, { zone }).startOf("minute").toFormat("HH:mm");
}

/**
 * The entry's times moved to `day`: the same local start time there and the same length
 * to the second. Null without a day.
 */
export function onDay(
  entry: Pick<ManualEntry, "startAt" | "endAt">,
  day: string,
  zone: string,
): { startAt: string; endAt: string } | null {
  const start = atLocal(day, localTime(entry.startAt, zone), zone);
  if (!start) return null;
  const withSeconds = start.set({
    second: DateTime.fromISO(entry.startAt, { zone }).second,
  });
  const end = withSeconds.plus({ seconds: seconds(entry.startAt, entry.endAt) });
  return { startAt: withSeconds.toISO() ?? "", endAt: end.toISO() ?? "" };
}

/**
 * The start and end an edit sends: `start` and `end` ("HH:mm", in `zone`) on `day`, the
 * end on the next day when it isn't after the start (an entry past midnight).
 */
export function editRange(
  day: string,
  start: string,
  end: string,
  zone: string,
): { startAt: string; endAt: string } | null {
  const s = atLocal(day, start, zone);
  let e = atLocal(day, end, zone);
  if (!s || !e) return null;
  if (e <= s) e = e.plus({ days: 1 });
  return { startAt: s.toISO() ?? "", endAt: e.toISO() ?? "" };
}

/** Billable is the task's flag when there is one, else the project's; Unassigned isn't. */
export function isBillable(
  projectId: string | null,
  taskId: string | null,
  projects: Pick<Project, "id" | "billable">[],
  tasks: Pick<Task, "id" | "billable">[],
): boolean {
  if (!projectId) return false;
  const task = taskId ? tasks.find((t) => t.id === taskId) : undefined;
  if (task) return task.billable;
  return projects.find((p) => p.id === projectId)?.billable ?? false;
}
