// Pure helpers for the seat map of the Team page (DSH-09 #251, DSH-11 #308): people as
// chairs round tables sized to their team, laid out on one canvas grouped by team. Kept
// out of the components so they can be unit-tested. Units are canvas pixels at 100% zoom.
import { type PresenceStatus, statusLabel, statusStyle } from "../../components/StatusChip";
import { formatTime } from "../../lib/time";
import type { TeamRow } from "./grid";

/** Distance between neighbouring chairs along a long side. */
export const PITCH = 50;
/** A chair's drawn size. */
export const CHAIR_SIZE = 40;
/** Half the table's depth: the radius of its rounded ends. */
export const TABLE_RADIUS = 44;
/** Distance from the table's edge to a chair's centre. */
const CHAIR_GAP = 34;
/** Chairs round each end once a table has enough people; the long sides take the rest. */
export const PER_END = 2;
/** The most chairs one table holds (DSH-11); a bigger team continues on another table. */
export const MAX_SEATS = 60;
/** The band above a table for its label. */
export const LABEL_BAND = 30;
/** From the table's centre line to the edge of its box. */
const REACH = TABLE_RADIUS + CHAIR_GAP + CHAIR_SIZE / 2;

export interface TableShape {
  /** Chairs on each part, clockwise from the top. */
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** Length of the straight sides. */
  length: number;
  /** The table's box: chairs and the label band included. */
  width: number;
  height: number;
}

/**
 * The table for `n` people, with no empty chairs. The ends keep their chairs (two each from
 * six people up; a smaller table fills the long sides first) and the long sides grow by a
 * chair every two people, so a bigger team never gets a shorter table.
 */
export function tableShape(n: number): TableShape {
  const count = Math.min(Math.max(Math.floor(n), 0), MAX_SEATS);
  const ends = Math.min(2 * PER_END, Math.max(0, count - 2));
  const sides = count - ends;
  const slots = Math.max(1, Math.ceil(sides / 2));
  const length = slots * PITCH;
  return {
    top: Math.ceil(sides / 2),
    right: Math.ceil(ends / 2),
    bottom: Math.floor(sides / 2),
    left: Math.floor(ends / 2),
    length,
    width: length + 2 * REACH,
    height: LABEL_BAND + 2 * REACH,
  };
}

export interface SeatPosition {
  /** The chair's centre, from the table box's top-left corner. */
  x: number;
  y: number;
  /** Degrees to turn a chair drawn facing down so it faces the table. */
  rotate: number;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function normalize(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** The table body's geometry inside its box. */
export function tableBody(shape: TableShape): {
  cx: number;
  cy: number;
  left: number;
  right: number;
} {
  const cx = shape.width / 2;
  return { cx, cy: LABEL_BAND + REACH, left: cx - shape.length / 2, right: cx + shape.length / 2 };
}

const seatCache = new Map<number, SeatPosition[]>();

/**
 * The chairs of a table for `n` people, in clockwise order from the top-left: the top side
 * left to right, the right end top to bottom, the bottom side right to left, the left end
 * bottom to top. Arrow keys follow this order. Shared per size, so don't mutate.
 */
export function tableSeats(n: number): SeatPosition[] {
  const count = Math.min(Math.max(Math.floor(n), 0), MAX_SEATS);
  const cached = seatCache.get(count);
  if (cached) return cached;
  const shape = tableShape(count);
  const { cy, left, right } = tableBody(shape);
  const offset = TABLE_RADIUS + CHAIR_GAP;
  const along = (i: number, of: number) => round(left + (shape.length * (i + 0.5)) / of);
  const arc = (endX: number, degrees: number): SeatPosition => {
    const a = (degrees * Math.PI) / 180;
    return {
      x: round(endX + offset * Math.cos(a)),
      y: round(cy + offset * Math.sin(a)),
      rotate: normalize(degrees + 90),
    };
  };
  const seats: SeatPosition[] = [];
  for (let i = 0; i < shape.top; i++) {
    seats.push({ x: along(i, shape.top), y: cy - offset, rotate: 0 });
  }
  for (let i = 0; i < shape.right; i++) {
    seats.push(arc(right, -90 + (180 * (i + 1)) / (shape.right + 1)));
  }
  for (let i = shape.bottom - 1; i >= 0; i--) {
    seats.push({ x: along(i, shape.bottom), y: cy + offset, rotate: 180 });
  }
  for (let i = 0; i < shape.left; i++) {
    seats.push(arc(left, 90 + (180 * (i + 1)) / (shape.left + 1)));
  }
  seatCache.set(count, seats);
  return seats;
}

/** Splits `people` into as few tables as hold them, as evenly as possible. */
export function splitTables<T>(people: T[], capacity = MAX_SEATS): T[][] {
  if (people.length === 0) return [];
  const tables = Math.ceil(people.length / capacity);
  const base = Math.floor(people.length / tables);
  const extra = people.length % tables;
  const out: T[][] = [];
  let at = 0;
  for (let t = 0; t < tables; t++) {
    const size = base + (t < extra ? 1 : 0);
    out.push(people.slice(at, at + size));
    at += size;
  }
  return out;
}

export interface SeatGroup {
  /** The team's id, "none" for people without a team, "all" when the org has no teams. */
  key: string;
  name: string;
  /** Everyone in it, in name order. */
  people: TeamRow[];
}

const byName = (a: TeamRow, b: TeamRow) =>
  (a.full_name ?? "").localeCompare(b.full_name ?? "") ||
  (a.user_id ?? "").localeCompare(b.user_id ?? "");

/**
 * Who sits together: each team (by name) with its people (by name), then anyone without a
 * team; everyone together when the org has no teams. A team with nobody the viewer sees gets
 * no table. Status plays no part, so a status change never moves anyone.
 */
export function seatGroups(rows: TeamRow[], teams: { id: string; name: string }[]): SeatGroup[] {
  const sorted = [...rows].sort(byName);
  if (teams.length === 0) {
    return sorted.length ? [{ key: "all", name: "Everyone", people: sorted }] : [];
  }
  const byTeam = new Map<string, TeamRow[]>();
  const none: TeamRow[] = [];
  const known = new Set(teams.map((t) => t.id));
  for (const r of sorted) {
    if (r.team_id && known.has(r.team_id)) {
      const list = byTeam.get(r.team_id) ?? [];
      list.push(r);
      byTeam.set(r.team_id, list);
    } else {
      none.push(r);
    }
  }
  const groups = [...teams]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((t) => ({ key: t.id, name: t.name, people: byTeam.get(t.id) ?? [] }))
    .filter((g) => g.people.length > 0);
  if (none.length) groups.push({ key: "none", name: "No team", people: none });
  return groups;
}

export interface PlacedTable {
  key: string;
  /** The group (team) it belongs to. */
  group: string;
  /** The team's name: every table of a team carries the same label. */
  name: string;
  /** Which of the team's tables this is (0-based), and how many it has. */
  index: number;
  of: number;
  /** Who sits here, in seat order. */
  people: string[];
  /** The table's box on the canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
  shape: TableShape;
  seats: SeatPosition[];
}

export interface SeatLayout {
  tables: PlacedTable[];
  /** The canvas's extent. */
  width: number;
  height: number;
  /** How long a row of tables may be. */
  rowWidth: number;
  /** Where each person sits. */
  seatOf: Map<string, { table: number; seat: number }>;
}

/** Space between neighbouring tables, across and down. */
export const GUTTER_X = 60;
export const GUTTER_Y = 40;
/** A table's place is rounded up to this, so most joins and leaves move nothing. */
const CELL_STEP = 4 * PITCH;
/** The row length is rounded up to this, so it rarely changes as the org grows. */
const ROW_STEP = 1000;
/** The canvas's target shape, about a laptop screen's. */
const ASPECT = 1.6;

/** The width a table's place takes on the canvas. */
export function cellWidth(shape: TableShape): number {
  return Math.ceil(shape.width / CELL_STEP) * CELL_STEP + GUTTER_X;
}

/** A table's accessible name: the team, and which of its tables when it has several. */
export function tableLabel(t: Pick<PlacedTable, "name" | "index" | "of">): string {
  return t.of > 1 ? `${t.name} · table ${t.index + 1} of ${t.of}` : t.name;
}

/**
 * Places every group's tables on the canvas in packed rows, in group order. A table's place
 * is its width rounded up to a step, and the row length depends only on the org's size
 * (rounded up too), so someone joining or leaving moves nothing before their team and
 * usually nothing at all.
 */
export function layoutSeats(groups: SeatGroup[]): SeatLayout {
  const pending = groups.flatMap((g) => {
    const split = splitTables(g.people);
    return split.map((people, index) => ({
      key: `${g.key}-${index}`,
      group: g.key,
      name: g.name,
      index,
      of: split.length,
      people: people.map((p) => p.user_id ?? ""),
      shape: tableShape(people.length),
    }));
  });
  const cellH = tableShape(1).height + GUTTER_Y;
  const widest = cellWidth(tableShape(MAX_SEATS));
  const area = pending.reduce((sum, t) => sum + cellWidth(t.shape) * cellH, 0);
  const rowWidth = Math.max(widest, Math.ceil(Math.sqrt(area * ASPECT) / ROW_STEP) * ROW_STEP);

  const tables: PlacedTable[] = [];
  const seatOf = new Map<string, { table: number; seat: number }>();
  let x = 0;
  let y = 0;
  let width = 0;
  for (const t of pending) {
    const cell = cellWidth(t.shape);
    if (x > 0 && x + cell > rowWidth) {
      x = 0;
      y += cellH;
    }
    t.people.forEach((id, seat) => {
      seatOf.set(id, { table: tables.length, seat });
    });
    tables.push({
      ...t,
      x,
      y,
      w: t.shape.width,
      h: t.shape.height,
      seats: tableSeats(t.people.length),
    });
    width = Math.max(width, x + t.shape.width);
    x += cell;
  }
  return { tables, width, height: tables.length ? y + cellH - GUTTER_Y : 0, rowWidth, seatOf };
}

/**
 * What the layout depends on: the teams and who is in which, by name. Status, since, project
 * and check-ins don't count, so live updates reuse the layout (DSH-11).
 */
export function layoutKey(rows: TeamRow[], teams: { id: string; name: string }[]): string {
  const parts = teams.map((t) => `${t.id}:${t.name}`);
  parts.push("#");
  for (const r of rows) parts.push(`${r.user_id}/${r.team_id ?? ""}/${r.full_name ?? ""}`);
  return parts.join("|");
}

export type SeatMatch =
  | { kind: "team"; group: string; name: string; tables: number[] }
  | { kind: "person"; userId: string; name: string; table: number; seat: number };

/**
 * The teams and people whose name contains `query` (any case): teams first, in canvas
 * order, then people in canvas order.
 */
export function findSeats(
  layout: SeatLayout,
  nameOf: (userId: string) => string,
  query: string,
): SeatMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const teams = new Map<string, { kind: "team"; group: string; name: string; tables: number[] }>();
  const people: SeatMatch[] = [];
  layout.tables.forEach((t, i) => {
    if (t.name.toLowerCase().includes(q)) {
      const m = teams.get(t.group) ?? { kind: "team", group: t.group, name: t.name, tables: [] };
      m.tables.push(i);
      teams.set(t.group, m);
    }
    t.people.forEach((id, seat) => {
      const name = nameOf(id);
      if (name.toLowerCase().includes(q)) {
        people.push({ kind: "person", userId: id, name, table: i, seat });
      }
    });
  });
  return [...teams.values(), ...people];
}

/** The tables of one group (team), by index. */
export function groupTables(layout: SeatLayout, group: string): number[] {
  const out: number[] = [];
  layout.tables.forEach((t, i) => {
    if (t.group === group) out.push(i);
  });
  return out;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The smallest box round some tables. */
export function tablesBox(layout: SeatLayout, indexes: number[]): Box | null {
  const ts = indexes.map((i) => layout.tables[i]).filter((t): t is PlacedTable => !!t);
  if (ts.length === 0) return null;
  const x = Math.min(...ts.map((t) => t.x));
  const y = Math.min(...ts.map((t) => t.y));
  return {
    x,
    y,
    w: Math.max(...ts.map((t) => t.x + t.w)) - x,
    h: Math.max(...ts.map((t) => t.y + t.h)) - y,
  };
}

/** A chair's centre on the canvas. */
export function seatPoint(t: PlacedTable, seat: number): { x: number; y: number } {
  const s = t.seats[seat] ?? { x: t.w / 2, y: t.h / 2 };
  return { x: t.x + s.x, y: t.y + s.y };
}

export type SeatTone = "active" | "inactive";

/**
 * Green only for Active: working, clocked in and neither idle nor away. Every other status,
 * including any added later, is red.
 */
export function seatTone(status: PresenceStatus | null | undefined): SeatTone {
  return status === "active" ? "active" : "inactive";
}

/** The statuses that count as not active, named as the status filter names them. */
export function inactiveLabels(): string[] {
  return (Object.keys(statusStyle) as PresenceStatus[])
    .filter((s) => seatTone(s) === "inactive")
    .map((s) => (s === "tamper" ? "tamper" : statusStyle[s].label.toLowerCase()));
}

/** The seat's status text, e.g. "On break since 10:05" (in the viewer's time zone). */
export function seatStatus(row: TeamRow, zone: string): string {
  const label = statusLabel((row.status ?? "off_shift") as PresenceStatus, row.tamper_reason);
  return row.since ? `${label} since ${formatTime(row.since, zone, zone)}` : label;
}

/** The seat's accessible name, e.g. "Erin Employee, On break since 10:05". */
export function seatName(row: TeamRow, zone: string): string {
  return `${row.full_name ?? "Unknown"}, ${seatStatus(row, zone)}`;
}

/** Roving focus round a table of `count` seats: the seat a key moves to, or null. */
export function nextSeat(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
