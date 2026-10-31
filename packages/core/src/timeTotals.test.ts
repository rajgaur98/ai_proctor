import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AssignedSeconds,
  billingCatalog,
  isBillable,
  overtimeAbove,
  type WorkTotals,
  workTotals,
} from "./timeTotals.ts";

// Northwind's billable Website revamp (a billable and a non-billable task), Internal with
// no client and not billable (one billable task), and Acme's billable Support.
const catalog = billingCatalog(
  [
    { id: "revamp", clientId: "northwind", billable: true },
    { id: "internal", clientId: null, billable: false },
    { id: "support", clientId: "acme", billable: true },
  ],
  [
    { id: "design", billable: true },
    { id: "testing", billable: false },
    { id: "hiring", billable: true },
  ],
);

const sum = (xs: { seconds: number }[]) => xs.reduce((a, x) => a + x.seconds, 0);

describe("isBillable", () => {
  it("takes the task's flag when the time has a task, else the project's", () => {
    expect(isBillable("revamp", null, catalog)).toBe(true);
    expect(isBillable("revamp", "design", catalog)).toBe(true);
    expect(isBillable("revamp", "testing", catalog)).toBe(false);
    expect(isBillable("internal", null, catalog)).toBe(false);
    expect(isBillable("internal", "hiring", catalog)).toBe(true);
  });

  it("never counts Unassigned time, and falls back for ids it doesn't know", () => {
    expect(isBillable(null, "design", catalog)).toBe(false);
    expect(isBillable("revamp", "gone", catalog)).toBe(true);
    expect(isBillable("gone", null, catalog)).toBe(false);
  });
});

describe("workTotals", () => {
  const rows: AssignedSeconds[] = [
    { projectId: "revamp", taskId: "design", seconds: 7200 },
    { projectId: "revamp", taskId: "testing", seconds: 1800 },
    { projectId: "revamp", taskId: null, seconds: 900 },
    { projectId: "revamp", taskId: "design", seconds: 59 },
    { projectId: "internal", seconds: 3600 },
    { projectId: "internal", taskId: "hiring", seconds: 600 },
    { projectId: null, taskId: "stray", seconds: 1200 },
    { projectId: "support", seconds: 0 },
  ];
  const t = workTotals(rows, catalog);

  it("splits worked time into billable and non-billable from raw seconds", () => {
    expect(t.seconds).toBe(7200 + 1800 + 900 + 59 + 3600 + 600 + 1200);
    expect(t.billable).toBe(7200 + 900 + 59 + 600);
    expect(t.nonBillable).toBe(1800 + 3600 + 1200);
  });

  it("totals by client, keeping Unassigned apart from projects without a client", () => {
    expect(t.byClient).toEqual([
      {
        clientId: "northwind",
        unassigned: false,
        seconds: 9959,
        billable: 8159,
        nonBillable: 1800,
      },
      { clientId: null, unassigned: false, seconds: 4200, billable: 600, nonBillable: 3600 },
      { clientId: null, unassigned: true, seconds: 1200, billable: 0, nonBillable: 1200 },
    ]);
  });

  it("totals by project, leaving out groups with no time", () => {
    expect(t.byProject.map((p) => [p.projectId, p.clientId, p.seconds, p.billable])).toEqual([
      ["revamp", "northwind", 9959, 8159],
      ["internal", null, 4200, 600],
      [null, null, 1200, 0],
    ]);
  });

  it("totals by project and task; Unassigned time has no task", () => {
    expect(t.byTask.map((x) => [x.projectId, x.taskId, x.seconds, x.billable])).toEqual([
      ["revamp", "design", 7259, 7259],
      ["internal", null, 3600, 0],
      ["revamp", "testing", 1800, 0],
      [null, null, 1200, 0],
      ["revamp", null, 900, 900],
      ["internal", "hiring", 600, 600],
    ]);
  });

  it("orders ties: Unassigned last, time without a task first", () => {
    const tie = workTotals(
      [
        { projectId: null, seconds: 60 },
        { projectId: "revamp", taskId: "design", seconds: 60 },
        { projectId: "revamp", seconds: 60 },
      ],
      catalog,
    );
    expect(tie.byTask.map((x) => [x.projectId, x.taskId])).toEqual([
      ["revamp", null],
      ["revamp", "design"],
      [null, null],
    ]);
    expect(tie.byProject.map((p) => p.projectId)).toEqual(["revamp", null]);
  });

  it("is empty for no time", () => {
    expect(workTotals([], catalog)).toEqual({
      seconds: 0,
      billable: 0,
      nonBillable: 0,
      byClient: [],
      byProject: [],
      byTask: [],
    });
  });

  // TS-06: whatever the time, every way of cutting it adds up to the total, to the second.
  it("parts always sum to the total in raw seconds (property)", () => {
    // taskId is sometimes left out altogether.
    const row: fc.Arbitrary<AssignedSeconds> = fc.record(
      {
        projectId: fc.constantFrom(null, "revamp", "internal", "support", "gone"),
        taskId: fc.constantFrom(null, "design", "testing", "hiring", "gone"),
        seconds: fc.integer({ min: 0, max: 12 * 3600 }),
      },
      { requiredKeys: ["projectId", "seconds"] },
    );
    fc.assert(
      fc.property(fc.array(row, { maxLength: 60 }), (rs) => {
        const w: WorkTotals = workTotals(rs, catalog);
        expect(w.seconds).toBe(sum(rs));
        expect(w.billable + w.nonBillable).toBe(w.seconds);
        for (const parts of [w.byClient, w.byProject, w.byTask]) {
          expect(sum(parts)).toBe(w.seconds);
          expect(parts.reduce((a, p) => a + p.billable, 0)).toBe(w.billable);
          for (const p of parts) {
            expect(p.billable + p.nonBillable).toBe(p.seconds);
            expect(p.seconds).toBeGreaterThan(0);
          }
        }
        // The order of the input never changes the result.
        expect(workTotals([...rs].reverse(), catalog)).toEqual(w);
      }),
    );
  });
});

describe("overtimeAbove", () => {
  it("is the worked time above the threshold, in seconds", () => {
    expect(overtimeAbove(9 * 3600 + 30 * 60, 8)).toBe(5400);
    expect(overtimeAbove(40 * 3600 + 1, 37.5)).toBe(2.5 * 3600 + 1);
  });

  it("is 0 at or under the threshold, or when it is off", () => {
    expect(overtimeAbove(8 * 3600, 8)).toBe(0);
    expect(overtimeAbove(100 * 3600, null)).toBe(0);
  });
});
