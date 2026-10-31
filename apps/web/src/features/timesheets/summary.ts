// What a week adds up to (#43, TS-05/06): segment seconds from the database,
// summed raw and rounded only for display. Excluded time (a manager's reasoned
// exclusion of flagged time, TS-02) is not worked and not flagged any more.
import { dayLabel } from "./weeks";

export interface BreakdownRow {
  day: string;
  type: string;
  projectId: string | null;
  /** The project's task (#254, PRJ-05); none when left out. */
  taskId?: string | null;
  counted: boolean;
  flagged: boolean;
  excluded: boolean;
  seconds: number;
}

export interface DaySummary {
  day: string;
  label: string;
  worked: number;
  flagged: number;
  excluded: number;
  breakTime: number;
  manual: number;
  /** Worked seconds per project (null is Unassigned). */
  byProject: Map<string | null, number>;
  /** Worked seconds per project and task (#254), keyed by `assignmentKey`. */
  byTask: Map<string, Assignment>;
}

/** Worked time on one project (null: Unassigned) and task (null: none). */
export interface Assignment {
  projectId: string | null;
  taskId: string | null;
  seconds: number;
}

export function assignmentKey(projectId: string | null, taskId: string | null): string {
  return `${projectId ?? ""}\u0000${taskId ?? ""}`;
}

export interface WeekSummary {
  days: DaySummary[];
  total: Omit<DaySummary, "day" | "label">;
}

function blank(): Omit<DaySummary, "day" | "label"> {
  return {
    worked: 0,
    flagged: 0,
    excluded: 0,
    breakTime: 0,
    manual: 0,
    byProject: new Map(),
    byTask: new Map(),
  };
}

function add(into: Omit<DaySummary, "day" | "label">, r: BreakdownRow) {
  if (r.counted && !r.excluded) {
    into.worked += r.seconds;
    into.byProject.set(r.projectId, (into.byProject.get(r.projectId) ?? 0) + r.seconds);
    // A task belongs to its project: Unassigned time has none.
    const taskId = r.projectId === null ? null : (r.taskId ?? null);
    const key = assignmentKey(r.projectId, taskId);
    const a = into.byTask.get(key) ?? { projectId: r.projectId, taskId, seconds: 0 };
    a.seconds += r.seconds;
    into.byTask.set(key, a);
    if (r.type === "manual") into.manual += r.seconds;
  }
  if (r.flagged && !r.excluded) into.flagged += r.seconds;
  if (r.excluded) into.excluded += r.seconds;
  if (r.type === "break") into.breakTime += r.seconds;
}

export function summarizeWeek(rows: BreakdownRow[], days: string[]): WeekSummary {
  const total = blank();
  const out = days.map((day): DaySummary => {
    const d = { day, label: dayLabel(day), ...blank() };
    for (const r of rows) if (r.day === day) add(d, r);
    return d;
  });
  for (const r of rows) if (days.includes(r.day)) add(total, r);
  return { days: out, total };
}

/** "38 h 20 min", "45 min", "0 min": hours and minutes, rounded to the minute. */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

/** Projects by worked time, largest first; Unassigned (null) last on a tie. */
export function projectSplit(byProject: Map<string | null, number>) {
  return [...byProject.entries()]
    .filter(([, seconds]) => seconds > 0)
    .map(([projectId, seconds]) => ({ projectId, seconds }))
    .sort(
      (a, b) =>
        b.seconds - a.seconds || Number(a.projectId === null) - Number(b.projectId === null),
    );
}

/**
 * Project and task pairs by worked time, largest first; on a tie Unassigned last and, within
 * a project, time without a task first.
 */
export function taskSplit(byTask: Map<string, Assignment>): Assignment[] {
  return [...byTask.values()]
    .filter((a) => a.seconds > 0)
    .sort(
      (a, b) =>
        b.seconds - a.seconds ||
        Number(a.projectId === null) - Number(b.projectId === null) ||
        Number(a.taskId !== null) - Number(b.taskId !== null),
    );
}
