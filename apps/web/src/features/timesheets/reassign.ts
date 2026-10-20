// Employee project re-assignment (#139, PRJ-03/04): which weeks and projects an
// employee may move time to, and the Unassigned spans worth offering. The database
// enforces every rule (reassign_my_time); these helpers only decide what to show.
import { DateTime } from "luxon";
import type { Project } from "../projects/projectData";
import type { SheetStatus } from "./timesheetData";

/** A stored segment, as far as the re-assign panel needs it. */
export interface TimeSegment {
  startAt: string;
  endAt: string;
  projectId: string | null;
  counted: boolean;
  excluded: boolean;
  flagged: boolean;
}

/** A stretch of counted, Unassigned time (touching segments joined). */
export interface UnassignedSpan {
  startAt: string;
  endAt: string;
  seconds: number;
  /** Part of it is flagged; re-assigning moves the project only, never the flag. */
  flagged: boolean;
}

/** PRJ-04: the employee re-assigns while the week is a draft (or returned to them). */
export function canReassignWeek(isSelf: boolean, status: SheetStatus | undefined): boolean {
  return isSelf && (status === "draft" || status === "returned");
}

/** Projects the person is assigned to and that aren't archived (the database's rule). */
export function allowedProjects(projects: Project[], userId: string): Project[] {
  return projects.filter((p) => !p.archived && p.memberIds.includes(userId));
}

/** Counted, not excluded, Unassigned segments, with segments that touch joined. */
export function unassignedSpans(segments: TimeSegment[]): UnassignedSpan[] {
  const sorted = segments
    .filter((s) => s.counted && !s.excluded && s.projectId === null)
    .map((s) => ({ ...s, start: Date.parse(s.startAt), end: Date.parse(s.endAt) }))
    .sort((a, b) => a.start - b.start);
  const out: (UnassignedSpan & { end: number })[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && last.end === s.start) {
      last.endAt = s.endAt;
      last.end = s.end;
      last.flagged ||= s.flagged;
    } else {
      out.push({ startAt: s.startAt, endAt: s.endAt, end: s.end, seconds: 0, flagged: s.flagged });
    }
  }
  return out.map(({ end: _end, ...span }) => ({
    ...span,
    seconds: (Date.parse(span.endAt) - Date.parse(span.startAt)) / 1000,
  }));
}

/**
 * The span of one employee-local day, ending now if the day isn't over: what "change
 * the project of this day" covers. Null for a day that hasn't started.
 */
export function daySpan(
  day: string,
  zone: string,
  now: DateTime = DateTime.now(),
): { startAt: string; endAt: string } | null {
  const start = DateTime.fromISO(day, { zone }).startOf("day");
  const end = DateTime.min(start.plus({ days: 1 }), now);
  if (!start.isValid || end <= start) return null;
  return { startAt: start.toUTC().toISO() ?? "", endAt: end.toUTC().toISO() ?? "" };
}
