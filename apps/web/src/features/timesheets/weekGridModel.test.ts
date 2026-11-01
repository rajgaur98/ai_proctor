import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ManualEntry } from "../day/entryData";
import { localDay } from "./dayList";
import { type BreakdownRow, summarizeWeek } from "./summary";
import { type GridAssignment, moveInGrid, type WeekGrid, weekGrid } from "./weekGridModel";
import { weekDays } from "./weeks";

const days = weekDays("2026-03-16");
const zone = "America/Los_Angeles";
const label = (a: GridAssignment) => `${a.projectId ?? "Unassigned"}/${a.taskId ?? ""}`;

const row = (over: Partial<BreakdownRow>): BreakdownRow => ({
  day: "2026-03-16",
  type: "verified",
  projectId: "p1",
  taskId: null,
  counted: true,
  flagged: false,
  excluded: false,
  seconds: 3600,
  ...over,
});

const entry = (over: Partial<ManualEntry>): ManualEntry => ({
  id: "e1",
  startAt: "2026-03-16T13:00:00-07:00",
  endAt: "2026-03-16T15:00:00-07:00",
  projectId: "p1",
  taskId: null,
  reason: "Offline",
  note: null,
  status: "pending",
  decisionNote: null,
  ...over,
});

const find = (g: WeekGrid, projectId: string | null, taskId: string | null = null) =>
  g.rows.find((r) => r.projectId === projectId && r.taskId === taskId);

describe("weekGrid", () => {
  it("keeps tracked and manual time apart per project/task row and day", () => {
    const g = weekGrid(
      days,
      [
        row({ seconds: 7200 }),
        row({ type: "manual", seconds: 1800 }),
        row({ day: "2026-03-17", projectId: "p1", taskId: "t1", seconds: 900 }),
        row({ projectId: null, seconds: 600 }),
      ],
      [],
      zone,
      [],
      label,
    );
    const p1 = find(g, "p1");
    expect(p1?.cells[0]).toMatchObject({ tracked: 7200, manual: 1800, total: 9000 });
    expect(find(g, "p1", "t1")?.cells[1]?.tracked).toBe(900);
    expect(find(g, null)?.cells[0]?.tracked).toBe(600);
    expect(g.dayTotals[0]?.total).toBe(9600);
    expect(g.total).toEqual({ tracked: 8700, manual: 1800, pending: 0, total: 10500 });
  });

  it("leaves out uncounted and excluded time; flagged time still counts", () => {
    const g = weekGrid(
      days,
      [
        row({ type: "break", counted: false, seconds: 2700 }),
        row({ type: "unverified", flagged: true, excluded: true, seconds: 1500 }),
        row({ type: "idle", flagged: true, seconds: 300 }),
      ],
      [],
      zone,
      [],
      label,
    );
    expect(g.total.total).toBe(300);
  });

  it("shows pending entries on the local day they start, not counted (TS-08)", () => {
    const g = weekGrid(
      days,
      [],
      [
        // 23:30 Monday in Los Angeles is Tuesday in UTC: it's Monday's.
        entry({ startAt: "2026-03-17T06:30:00Z", endAt: "2026-03-17T07:30:00Z" }),
        entry({ id: "e2", status: "approved" }),
      ],
      zone,
      [],
      label,
    );
    const cell = find(g, "p1")?.cells[0];
    expect(cell?.pending).toBe(3600);
    expect(cell?.total).toBe(0);
    expect(cell?.entries.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(g.total.pending).toBe(3600);
  });

  it("lists a rejected entry only in a row that has other time", () => {
    const rejected = entry({ id: "r", status: "rejected", projectId: "p2" });
    expect(find(weekGrid(days, [], [rejected], zone, [], label), "p2")).toBeUndefined();
    const g = weekGrid(days, [row({ projectId: "p2" })], [rejected], zone, [], label);
    expect(find(g, "p2")?.cells[0]?.entries).toHaveLength(1);
    expect(find(g, "p2")?.cells[0]?.pending).toBe(0);
  });

  it("always has Unassigned, last, and keeps added rows with no time", () => {
    const g = weekGrid(
      days,
      [row({ projectId: "b" })],
      [],
      zone,
      [
        { projectId: "a", taskId: "t" },
        { projectId: "b", taskId: null },
      ],
      label,
    );
    expect(g.rows.map((r) => r.key)).toEqual(["a\u0000t", "b\u0000", "\u0000"]);
    expect(find(g, "a", "t")?.total).toBe(0);
  });

  it("drops a task given with Unassigned time", () => {
    const g = weekGrid(days, [row({ projectId: null, taskId: "t1" })], [], zone, [], label);
    expect(g.rows).toHaveLength(1);
    expect(find(g, null)?.tracked).toBe(3600);
  });
});

const ids = ["p1", "p2", null] as const;
const breakdownRow = fc.record({
  day: fc.constantFrom(...days, "2026-03-23"),
  type: fc.constantFrom("verified", "idle", "manual", "break"),
  projectId: fc.constantFrom(...ids),
  taskId: fc.constantFrom("t1", "t2", null),
  counted: fc.boolean(),
  flagged: fc.boolean(),
  excluded: fc.boolean(),
  seconds: fc.integer({ min: 0, max: 86_400 }),
});
const manualEntry = fc
  .record({
    day: fc.integer({ min: -1, max: 7 }),
    startSecond: fc.integer({ min: 0, max: 86_399 }),
    length: fc.integer({ min: 1, max: 86_400 }),
    projectId: fc.constantFrom(...ids),
    taskId: fc.constantFrom("t1", null),
    status: fc.constantFrom("pending", "approved", "rejected") as fc.Arbitrary<
      ManualEntry["status"]
    >,
  })
  .map((e) => {
    const start = Date.parse("2026-03-16T00:00:00-07:00") + (e.day * 86_400 + e.startSecond) * 1000;
    return entry({
      startAt: new Date(start).toISOString(),
      endAt: new Date(start + e.length * 1000).toISOString(),
      projectId: e.projectId,
      taskId: e.taskId,
      status: e.status,
    });
  });

/** Entries with distinct ids. */
const manualEntries = fc.array(manualEntry).map((es) => es.map((e, i) => ({ ...e, id: `e${i}` })));

describe("weekGrid properties", () => {
  it("row, day and week totals are the sums of the cells (TS-06)", () => {
    fc.assert(
      fc.property(fc.array(breakdownRow), manualEntries, (rows, entries) => {
        const g = weekGrid(days, rows, entries, zone, [], label);
        for (const key of ["tracked", "manual", "pending", "total"] as const) {
          for (const r of g.rows) {
            expect(r[key]).toBe(r.cells.reduce((s, c) => s + c[key], 0));
          }
          g.dayTotals.forEach((d, i) => {
            expect(d[key]).toBe(g.rows.reduce((s, r) => s + (r.cells[i]?.[key] ?? 0), 0));
          });
          expect(g.total[key]).toBe(g.rows.reduce((s, r) => s + r[key], 0));
          expect(g.total[key]).toBe(g.dayTotals.reduce((s, d) => s + d[key], 0));
        }
        for (const r of g.rows) {
          for (const c of r.cells) expect(c.total).toBe(c.tracked + c.manual);
        }
      }),
    );
  });

  it("no second is lost: the grid's total is the week's worked time", () => {
    fc.assert(
      fc.property(fc.array(breakdownRow), manualEntries, (rows, entries) => {
        const g = weekGrid(days, rows, entries, zone, [], label);
        const week = summarizeWeek(rows, days).total;
        expect(g.total.total).toBe(week.worked);
        expect(g.total.manual).toBe(week.manual);
        const pending = entries
          .filter((e) => e.status === "pending" && days.includes(localDay(e.startAt, zone)))
          .reduce((s, e) => s + (Date.parse(e.endAt) - Date.parse(e.startAt)) / 1000, 0);
        expect(g.total.pending).toBe(pending);
      }),
    );
  });

  it("every entry of the week sits in exactly one cell", () => {
    fc.assert(
      fc.property(fc.array(breakdownRow), manualEntries, (rows, entries) => {
        const g = weekGrid(days, rows, entries, zone, [], label);
        const placed = g.rows.flatMap((r) => r.cells.flatMap((c) => c.entries.map((e) => e.id)));
        expect(new Set(placed).size).toBe(placed.length);
        for (const e of entries.filter((e) => e.status !== "rejected")) {
          expect(placed.includes(e.id)).toBe(days.includes(localDay(e.startAt, zone)));
        }
      }),
    );
  });
});

describe("moveInGrid", () => {
  it("moves with the arrows and stops at the edges", () => {
    expect(moveInGrid({ row: 0, col: 0 }, "ArrowRight", 3, 7)).toEqual({ row: 0, col: 1 });
    expect(moveInGrid({ row: 0, col: 0 }, "ArrowLeft", 3, 7)).toEqual({ row: 0, col: 0 });
    expect(moveInGrid({ row: 0, col: 3 }, "ArrowDown", 3, 7)).toEqual({ row: 1, col: 3 });
    expect(moveInGrid({ row: 2, col: 3 }, "ArrowDown", 3, 7)).toEqual({ row: 2, col: 3 });
    expect(moveInGrid({ row: 2, col: 6 }, "ArrowRight", 3, 7)).toEqual({ row: 2, col: 6 });
    expect(moveInGrid({ row: 1, col: 3 }, "Home", 3, 7)).toEqual({ row: 1, col: 0 });
    expect(moveInGrid({ row: 1, col: 3 }, "End", 3, 7)).toEqual({ row: 1, col: 6 });
    expect(moveInGrid({ row: 1, col: 3 }, "Enter", 3, 7)).toBeNull();
  });

  it("always lands inside the grid", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 7 }),
        fc.array(fc.constantFrom("ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End")),
        (rows, cols, keys) => {
          let at = { row: 0, col: 0 };
          for (const k of keys) at = moveInGrid(at, k, rows, cols) ?? at;
          expect(at.row).toBeGreaterThanOrEqual(0);
          expect(at.row).toBeLessThan(rows);
          expect(at.col).toBeGreaterThanOrEqual(0);
          expect(at.col).toBeLessThan(cols);
        },
      ),
    );
  });
});
