// Timesheet totals (#266, TS-29): worked time split into billable and non-billable, and by
// client, project and task, for the week page and the Timesheets list. Every total is a
// sum of raw seconds (TS-05/06); rounding happens only when a number is shown, so the
// parts always add up to the whole. Billable follows the export (TS-22/26): the task's
// flag when the time has a task, else the project's; time without a project (Unassigned,
// PRJ-03) is non-billable.
import { isOver } from "./overtime.ts";

/** Worked seconds on one project (null: Unassigned) and task (null or left out: none). */
export interface AssignedSeconds {
  projectId: string | null;
  taskId?: string | null;
  seconds: number;
}

/** What decides billable and the client: the org's projects and tasks, by id. */
export interface BillingCatalog {
  projects: ReadonlyMap<string, { clientId: string | null; billable: boolean }>;
  tasks: ReadonlyMap<string, { billable: boolean }>;
}

export function billingCatalog(
  projects: readonly { id: string; clientId: string | null; billable: boolean }[],
  tasks: readonly { id: string; billable: boolean }[],
): BillingCatalog {
  return {
    projects: new Map(projects.map((p) => [p.id, { clientId: p.clientId, billable: p.billable }])),
    tasks: new Map(tasks.map((t) => [t.id, { billable: t.billable }])),
  };
}

/** The task's billable flag when there is one, else the project's; Unassigned never is. */
export function isBillable(
  projectId: string | null,
  taskId: string | null | undefined,
  catalog: BillingCatalog,
): boolean {
  if (projectId === null) return false;
  const task = taskId ? catalog.tasks.get(taskId) : undefined;
  return task?.billable ?? catalog.projects.get(projectId)?.billable ?? false;
}

/** Worked seconds and their billable and non-billable parts (billable + nonBillable = seconds). */
export interface BillableSplit {
  seconds: number;
  billable: number;
  nonBillable: number;
}

export interface ClientTotal extends BillableSplit {
  /** The project's client; null for a project without one, or for Unassigned time. */
  clientId: string | null;
  /** Time without a project, kept apart from projects without a client. */
  unassigned: boolean;
}

export interface ProjectTotal extends BillableSplit {
  /** Null is Unassigned. */
  projectId: string | null;
  clientId: string | null;
}

export interface TaskTotal extends BillableSplit {
  projectId: string | null;
  /** Null: time on the project without a task (Unassigned time never has one). */
  taskId: string | null;
}

export interface WorkTotals extends BillableSplit {
  byClient: ClientTotal[];
  byProject: ProjectTotal[];
  byTask: TaskTotal[];
}

function split(): BillableSplit {
  return { seconds: 0, billable: 0, nonBillable: 0 };
}

function addTo(into: BillableSplit, seconds: number, billable: boolean) {
  into.seconds += seconds;
  if (billable) into.billable += seconds;
  else into.nonBillable += seconds;
}

function group<T extends BillableSplit>(
  map: Map<string, T>,
  key: string,
  make: () => T,
  seconds: number,
  billable: boolean,
) {
  let g = map.get(key);
  if (!g) {
    g = make();
    map.set(key, g);
  }
  addTo(g, seconds, billable);
}

function cmp(a: string | null, b: string | null): number {
  const x = a ?? "";
  const y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Largest first. On a tie, Unassigned last, then (for tasks) time without a task first,
 * then by id so the order never depends on the input's.
 */
function bySize<T extends BillableSplit>(rank: (t: T) => number[], id: (t: T) => string) {
  return (a: T, b: T) => {
    if (b.seconds !== a.seconds) return b.seconds - a.seconds;
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      const d = (ra[i] ?? 0) - (rb[i] ?? 0);
      if (d !== 0) return d;
    }
    return cmp(id(a), id(b));
  };
}

const SEP = "\u0000";

/**
 * Totals of worked time: billable and non-billable, and by client, project and task, each
 * group with its own billable split. Groups with no time are left out. Seconds are summed
 * as given (whole seconds from the database), never rounded.
 */
export function workTotals(rows: readonly AssignedSeconds[], catalog: BillingCatalog): WorkTotals {
  const total = split();
  const clients = new Map<string, ClientTotal>();
  const projects = new Map<string, ProjectTotal>();
  const tasks = new Map<string, TaskTotal>();
  for (const r of rows) {
    if (r.seconds === 0) continue;
    const projectId = r.projectId;
    // A task belongs to its project: Unassigned time has none.
    const taskId = projectId === null ? null : (r.taskId ?? null);
    const clientId =
      projectId === null ? null : (catalog.projects.get(projectId)?.clientId ?? null);
    const unassigned = projectId === null;
    const billable = isBillable(projectId, taskId, catalog);
    addTo(total, r.seconds, billable);
    group(
      clients,
      unassigned ? "u" : `c${clientId ?? ""}`,
      () => ({ clientId, unassigned, ...split() }),
      r.seconds,
      billable,
    );
    group(
      projects,
      projectId ?? "",
      () => ({ projectId, clientId, ...split() }),
      r.seconds,
      billable,
    );
    group(
      tasks,
      `${projectId ?? ""}${SEP}${taskId ?? ""}`,
      () => ({ projectId, taskId, ...split() }),
      r.seconds,
      billable,
    );
  }
  const keep = <T extends BillableSplit>(m: Map<string, T>) =>
    [...m.values()].filter((g) => g.seconds !== 0);
  return {
    ...total,
    byClient: keep(clients).sort(
      bySize(
        (c) => [Number(c.unassigned), Number(c.clientId === null)],
        (c) => c.clientId ?? "",
      ),
    ),
    byProject: keep(projects).sort(
      bySize(
        (p) => [Number(p.projectId === null)],
        (p) => p.projectId ?? "",
      ),
    ),
    byTask: keep(tasks).sort(
      bySize(
        (t) => [Number(t.projectId === null), Number(t.taskId !== null)],
        (t) => `${t.projectId ?? ""}${SEP}${t.taskId ?? ""}`,
      ),
    ),
  };
}

/**
 * Worked seconds above an overtime threshold of `thresholdHours` (TS-19), 0 when not over
 * or off. Only shown next to the totals; nothing is paid or deducted.
 */
export function overtimeAbove(seconds: number, thresholdHours: number | null): number {
  if (thresholdHours === null || !isOver(seconds, thresholdHours)) return 0;
  return seconds - Math.round(thresholdHours * 3600);
}
