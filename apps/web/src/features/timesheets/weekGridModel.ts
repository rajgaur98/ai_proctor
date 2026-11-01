// The week as a grid (#262, TS-32): project/task rows by the week's days, each cell with
// that day's tracked and manual time for the row apart. Pure, so it's unit-tested. Every
// total is a sum of raw seconds (TS-05/06); only display rounds. Pending manual time is
// shown but not counted (TS-08), like the rest of the week page.
import type { ManualEntry } from "../day/entryData";
import { localDay } from "./dayList";
import { assignmentKey, type BreakdownRow } from "./summary";

/** One project (null: Unassigned) and task (null: none). */
export interface GridAssignment {
  projectId: string | null;
  taskId: string | null;
}

export interface GridSums {
  /** Counted time from check-ins, excluded time left out. */
  tracked: number;
  /** Counted manual time: approved entries. */
  manual: number;
  /** Manual time asked for and not decided yet: shown, not counted. */
  pending: number;
  /** Tracked plus manual: the worked time. */
  total: number;
}

export interface GridCell extends GridSums {
  day: string;
  /** The row's manual entries that start on this day, in time order. */
  entries: ManualEntry[];
}

export interface GridRow extends GridAssignment, GridSums {
  key: string;
  cells: GridCell[];
}

export interface WeekGrid {
  days: string[];
  rows: GridRow[];
  /** Per day, every row's cells added up. */
  dayTotals: GridSums[];
  total: GridSums;
}

function blank(): GridSums {
  return { tracked: 0, manual: 0, pending: 0, total: 0 };
}

function addInto(into: GridSums, s: GridSums) {
  into.tracked += s.tracked;
  into.manual += s.manual;
  into.pending += s.pending;
  into.total += s.total;
}

/** A task belongs to its project: Unassigned time has none (as in the week summary). */
function normal(projectId: string | null, taskId: string | null | undefined): GridAssignment {
  return { projectId, taskId: projectId === null ? null : (taskId ?? null) };
}

/**
 * The grid of the week's `days`. Counted time comes from the breakdown (the same rows as
 * the week's totals, so the grid's total is the page's worked time); pending time and the
 * cells' entries come from the manual entries, on the local day each starts on. Unassigned
 * is always a row, and `added` rows (picked by the employee, no time yet) are kept. Rows
 * sort by `label`, Unassigned last.
 */
export function weekGrid(
  days: string[],
  breakdown: BreakdownRow[],
  entries: ManualEntry[],
  zone: string,
  added: GridAssignment[],
  label: (a: GridAssignment) => string,
): WeekGrid {
  const rows = new Map<string, GridRow>();
  const rowFor = (a: GridAssignment): GridRow => {
    const key = assignmentKey(a.projectId, a.taskId);
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        ...a,
        ...blank(),
        cells: days.map((day) => ({ day, ...blank(), entries: [] })),
      };
      rows.set(key, row);
    }
    return row;
  };

  rowFor({ projectId: null, taskId: null });
  for (const a of added) rowFor(normal(a.projectId, a.taskId));

  for (const r of breakdown) {
    const i = days.indexOf(r.day);
    if (i === -1 || !r.counted || r.excluded || r.seconds === 0) continue;
    const cell = rowFor(normal(r.projectId, r.taskId)).cells[i];
    if (!cell) continue;
    if (r.type === "manual") cell.manual += r.seconds;
    else cell.tracked += r.seconds;
    cell.total += r.seconds;
  }

  // Rejected entries last, so they only join rows that exist; then each cell in time order.
  const sorted = [...entries].sort(
    (a, b) =>
      Number(a.status === "rejected") - Number(b.status === "rejected") ||
      Date.parse(a.startAt) - Date.parse(b.startAt),
  );
  for (const e of sorted) {
    const i = days.indexOf(localDay(e.startAt, zone));
    if (i === -1) continue;
    const a = normal(e.projectId, e.taskId);
    // A rejected entry is listed in its cell but doesn't add a row of its own.
    if (e.status === "rejected" && !rows.has(assignmentKey(a.projectId, a.taskId))) continue;
    const cell = rowFor(a).cells[i];
    if (!cell) continue;
    cell.entries.push(e);
    if (e.status === "pending")
      cell.pending += (Date.parse(e.endAt) - Date.parse(e.startAt)) / 1000;
  }

  const dayTotals = days.map(() => blank());
  const total = blank();
  for (const row of rows.values()) {
    row.cells.forEach((cell, i) => {
      cell.entries.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
      addInto(row, cell);
      const day = dayTotals[i];
      if (day) addInto(day, cell);
    });
    addInto(total, row);
  }

  const ordered = [...rows.values()].sort(
    (a, b) =>
      Number(a.projectId === null) - Number(b.projectId === null) ||
      label(a).localeCompare(label(b)),
  );
  return { days, rows: ordered, dayTotals, total };
}

export interface GridPosition {
  row: number;
  col: number;
}

/**
 * Where an arrow, Home or End key moves the focus in a grid of `rows` by `cols` cells,
 * stopping at the edges (Home and End go to the row's first and last cell). Null for any
 * other key.
 */
export function moveInGrid(
  at: GridPosition,
  key: string,
  rows: number,
  cols: number,
): GridPosition | null {
  const clamp = (n: number, size: number) => Math.min(Math.max(n, 0), Math.max(size - 1, 0));
  switch (key) {
    case "ArrowLeft":
      return { row: at.row, col: clamp(at.col - 1, cols) };
    case "ArrowRight":
      return { row: at.row, col: clamp(at.col + 1, cols) };
    case "ArrowUp":
      return { row: clamp(at.row - 1, rows), col: at.col };
    case "ArrowDown":
      return { row: clamp(at.row + 1, rows), col: at.col };
    case "Home":
      return { row: at.row, col: 0 };
    case "End":
      return { row: at.row, col: clamp(cols - 1, cols) };
    default:
      return null;
  }
}
