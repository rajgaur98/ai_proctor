// Pure helpers for the seat view of the Team page (DSH-09, #251): people as chairs
// around oval tables. Kept out of the component so they can be unit-tested.
import { type PresenceStatus, statusLabel } from "../../components/StatusChip";
import { formatTime } from "../../lib/time";
import type { TeamRow } from "./grid";

/** Chairs around one table: seven along each long side and four round each end. */
export const TABLE_SEATS = 22;
const PER_SIDE = 7;
const PER_END = 4;

/** The table drawing's coordinate box; seats are placed in it. */
export const TABLE_VIEW = { width: 760, height: 340 } as const;
const CX = TABLE_VIEW.width / 2;
const CY = TABLE_VIEW.height / 2;
/** Half the table's depth: the radius of its rounded ends. */
export const TABLE_RADIUS = 80;
/** Length of the straight sides. */
export const TABLE_STRAIGHT = 462;
/** Distance from the table's edge to a chair's centre. */
const CHAIR_GAP = 42;
/** A chair's drawn size, in the same units. */
export const CHAIR_SIZE = 46;

export interface SeatPosition {
  x: number;
  y: number;
  /** Degrees to turn a chair drawn facing down so it faces the table. */
  rotate: number;
}

function onArc(endX: number, degrees: number): SeatPosition {
  const r = TABLE_RADIUS + CHAIR_GAP;
  const a = (degrees * Math.PI) / 180;
  return {
    x: round(endX + r * Math.cos(a)),
    y: round(CY + r * Math.sin(a)),
    rotate: normalize(degrees + 90),
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function normalize(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * The chairs of one table in clockwise order from the top-left: the top side left to
 * right, the right end top to bottom, the bottom side right to left, the left end bottom
 * to top. Arrow keys follow this order.
 */
export function tableSeats(): SeatPosition[] {
  const left = CX - TABLE_STRAIGHT / 2;
  const right = CX + TABLE_STRAIGHT / 2;
  const step = TABLE_STRAIGHT / PER_SIDE;
  const offset = TABLE_RADIUS + CHAIR_GAP;
  const arcStep = 180 / (PER_END + 1);
  const seats: SeatPosition[] = [];
  for (let i = 0; i < PER_SIDE; i++) {
    seats.push({ x: round(left + step * (i + 0.5)), y: CY - offset, rotate: 0 });
  }
  for (let i = 1; i <= PER_END; i++) seats.push(onArc(right, -90 + arcStep * i));
  for (let i = PER_SIDE - 1; i >= 0; i--) {
    seats.push({ x: round(left + step * (i + 0.5)), y: CY + offset, rotate: 180 });
  }
  for (let i = 1; i <= PER_END; i++) seats.push(onArc(left, 90 + arcStep * i));
  return seats;
}

/**
 * Which of a table's chairs `n` people take: spread evenly round the table, in order,
 * so a small team doesn't bunch up on one side.
 */
export function spreadSeats(n: number, capacity = TABLE_SEATS): number[] {
  const count = Math.min(Math.max(n, 0), capacity);
  return Array.from({ length: count }, (_, i) => Math.floor((i * capacity) / count));
}

/** Splits `people` into as few tables as hold them, as evenly as possible. */
export function splitTables<T>(people: T[], capacity = TABLE_SEATS): T[][] {
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

export interface SeatTable {
  key: string;
  label: string;
  people: TeamRow[];
}

/**
 * The tables to draw. With every team shown (`teamId` ""), each team gets its own
 * tables, in the teams' order, then anyone without a team; with one team picked (or no
 * teams in the org), everyone shares. People sit in name order so a status change
 * never moves anyone.
 */
export function seatTables(
  rows: TeamRow[],
  teams: { id: string; name: string }[],
  teamId: string,
): SeatTable[] {
  const byName = [...rows].sort((a, b) => (a.full_name ?? "").localeCompare(b.full_name ?? ""));
  const groups: { key: string; name: string; people: TeamRow[] }[] = [];
  if (teamId || teams.length === 0) {
    const name = teams.find((t) => t.id === teamId)?.name ?? "Everyone";
    groups.push({ key: teamId || "all", name, people: byName });
  } else {
    for (const t of teams) {
      groups.push({ key: t.id, name: t.name, people: byName.filter((r) => r.team_id === t.id) });
    }
    const known = new Set(teams.map((t) => t.id));
    groups.push({
      key: "none",
      name: "No team",
      people: byName.filter((r) => !r.team_id || !known.has(r.team_id)),
    });
  }
  return groups.flatMap((g) => {
    const split = splitTables(g.people);
    return split.map((people, i) => ({
      key: `${g.key}-${i}`,
      label: split.length > 1 ? `${g.name} · table ${i + 1} of ${split.length}` : g.name,
      people,
    }));
  });
}

export type SeatTone = "active" | "inactive";

/**
 * Green only for Active: working, clocked in and neither idle nor away. Everything else
 * (idle, away, locked, on break, paused, in a meeting, offline, tamper, off shift) is red.
 */
export function seatTone(status: PresenceStatus | null | undefined): SeatTone {
  return status === "active" ? "active" : "inactive";
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
