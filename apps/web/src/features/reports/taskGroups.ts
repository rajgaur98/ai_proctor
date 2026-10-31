// Reports by task (#269, DSH-10): `report_task_rows` gives worked and flagged seconds per
// person, project and task; this groups them by project, then task, for the table. Seconds
// are added up as they come and rounded only for display (formatDuration).
import { type ExportTable, exportHours as hours } from "../../lib/exportFile";

/** One person's seconds on one project and task (null project: Unassigned; null task: none). */
export interface TaskSeconds {
  userId: string;
  projectId: string | null;
  taskId: string | null;
  workedS: number;
  flaggedS: number;
}

export interface TaskLine {
  taskId: string | null;
  name: string;
  workedS: number;
  flaggedS: number;
  /** People with time on it. */
  people: number;
}

export interface ProjectGroup extends Omit<TaskLine, "taskId"> {
  projectId: string | null;
  /** The project's tasks in its order, then "No task"; none for Unassigned. */
  tasks: TaskLine[];
}

export interface TaskReport {
  projects: ProjectGroup[];
  total: { workedS: number; flaggedS: number; people: number };
}

export const UNASSIGNED = "Unassigned";
export const NO_TASK = "No task";

interface Named {
  id: string;
  name: string;
}

/**
 * Groups the rows by project (by name, Unassigned last) and task (in `tasks`' order, which
 * is each project's, then "No task"). `tasks` are every project's tasks in order; a row
 * whose project or task isn't among them still counts, under a placeholder name.
 */
export function groupByTask(
  rows: TaskSeconds[],
  projects: Named[],
  tasks: (Named & { projectId: string })[],
): TaskReport {
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const taskName = new Map(tasks.map((t) => [t.id, t.name]));
  const taskRank = new Map(tasks.map((t, i) => [t.id, i]));

  const acc = new Map<
    string,
    { projectId: string | null; seconds: Sum; tasks: Map<string, { taskId: string | null } & Sum> }
  >();
  const total = sum();
  for (const r of rows) {
    const key = r.projectId ?? "";
    let group = acc.get(key);
    if (!group) {
      group = { projectId: r.projectId, seconds: sum(), tasks: new Map() };
      acc.set(key, group);
    }
    add(group.seconds, r);
    add(total, r);
    if (r.projectId === null) continue;
    const taskKey = r.taskId ?? "";
    let line = group.tasks.get(taskKey);
    if (!line) {
      line = { taskId: r.taskId, ...sum() };
      group.tasks.set(taskKey, line);
    }
    add(line, r);
  }

  const projectsOut: ProjectGroup[] = [...acc.values()].map((g) => ({
    projectId: g.projectId,
    name: g.projectId === null ? UNASSIGNED : (projectName.get(g.projectId) ?? "Unknown project"),
    ...done(g.seconds),
    tasks: [...g.tasks.values()]
      .sort((a, b) => rank(a.taskId) - rank(b.taskId))
      .map((t) => ({
        taskId: t.taskId,
        name: t.taskId === null ? NO_TASK : (taskName.get(t.taskId) ?? "Unknown task"),
        ...done(t),
      })),
  }));
  projectsOut.sort(
    (a, b) =>
      Number(a.projectId === null) - Number(b.projectId === null) || a.name.localeCompare(b.name),
  );
  return { projects: projectsOut, total: done(total) };

  // Tasks in their order, unknown ones after them, "No task" last.
  function rank(taskId: string | null): number {
    if (taskId === null) return Number.POSITIVE_INFINITY;
    return taskRank.get(taskId) ?? tasks.length;
  }
}

interface Sum {
  workedS: number;
  flaggedS: number;
  people: Set<string>;
}

function sum(): Sum {
  return { workedS: 0, flaggedS: 0, people: new Set() };
}

function add(into: Sum, r: TaskSeconds) {
  into.workedS += r.workedS;
  into.flaggedS += r.flaggedS;
  into.people.add(r.userId);
}

function done(s: Sum) {
  return { workedS: s.workedS, flaggedS: s.flaggedS, people: s.people.size };
}

export const TASK_REPORT_HEADER = ["Project", "Task", "Worked (h)", "Flagged (h)", "People"];

/**
 * The task report's table as a file (#255 part 2): each project's row (Task empty), then
 * its tasks in order, then the Total row, as the page shows them. Hours are decimals from
 * the raw seconds.
 */
export function taskReportTable(report: TaskReport): ExportTable {
  return {
    sheet: "Report by task",
    header: TASK_REPORT_HEADER,
    rows: [
      ...report.projects.flatMap((p) => [
        [p.name, "", hours(p.workedS), hours(p.flaggedS), p.people],
        ...p.tasks.map((t) => [p.name, t.name, hours(t.workedS), hours(t.flaggedS), t.people]),
      ]),
      ["Total", "", hours(report.total.workedS), hours(report.total.flaggedS), report.total.people],
    ],
  };
}
