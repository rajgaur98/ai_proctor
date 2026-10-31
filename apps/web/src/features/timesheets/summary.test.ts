import { describe, expect, it } from "vitest";
import {
  type BreakdownRow,
  formatDuration,
  projectSplit,
  summarizeWeek,
  taskSplit,
} from "./summary";

const row = (over: Partial<BreakdownRow>): BreakdownRow => ({
  day: "2026-03-16",
  type: "verified",
  projectId: "p1",
  counted: true,
  flagged: false,
  excluded: false,
  seconds: 3600,
  ...over,
});

const days = ["2026-03-16", "2026-03-17"];

describe("summarizeWeek", () => {
  it("sums worked, flagged, break and manual from raw seconds", () => {
    const s = summarizeWeek(
      [
        row({ seconds: 7200 }),
        row({ type: "idle", flagged: true, seconds: 1200 }),
        row({ type: "break", counted: false, seconds: 2700, projectId: null }),
        row({ day: "2026-03-17", type: "manual", seconds: 5400, projectId: "p2" }),
      ],
      days,
    );
    expect(s.total.worked).toBe(7200 + 1200 + 5400);
    expect(s.total.flagged).toBe(1200);
    expect(s.total.breakTime).toBe(2700);
    expect(s.total.manual).toBe(5400);
    expect(s.days[0]?.worked).toBe(8400);
    expect(s.days[1]?.manual).toBe(5400);
  });

  it("takes excluded time out of worked and flagged, and counts it apart", () => {
    const s = summarizeWeek(
      [row({ type: "unverified", flagged: true, excluded: true, seconds: 1500 }), row({})],
      days,
    );
    expect(s.total.worked).toBe(3600);
    expect(s.total.flagged).toBe(0);
    expect(s.total.excluded).toBe(1500);
  });

  it("row sums and totals agree on raw seconds (TS-06)", () => {
    const s = summarizeWeek(
      [row({ seconds: 59 }), row({ day: "2026-03-17", seconds: 59 }), row({ seconds: 59 })],
      days,
    );
    expect(s.days.reduce((a, d) => a + d.worked, 0)).toBe(s.total.worked);
    expect(s.total.worked).toBe(177);
  });

  it("splits worked time by project, Unassigned included", () => {
    const s = summarizeWeek(
      [row({ seconds: 600 }), row({ projectId: null, seconds: 1800 }), row({ projectId: "p2" })],
      days,
    );
    expect(projectSplit(s.total.byProject)).toEqual([
      { projectId: "p2", seconds: 3600 },
      { projectId: null, seconds: 1800 },
      { projectId: "p1", seconds: 600 },
    ]);
  });

  // #254: the same worked time split by project and task; Unassigned time has no task.
  it("splits worked time by project and task, adding up to the project split", () => {
    const s = summarizeWeek(
      [
        row({ taskId: "t1", seconds: 1200 }),
        row({ taskId: "t1", seconds: 600, day: "2026-03-17" }),
        row({ seconds: 600 }),
        row({ taskId: "t2", seconds: 600 }),
        row({ projectId: null, taskId: "stray", seconds: 600 }),
        row({ taskId: "t1", seconds: 900, counted: false }),
      ],
      days,
    );
    expect(taskSplit(s.total.byTask)).toEqual([
      { projectId: "p1", taskId: "t1", seconds: 1800 },
      { projectId: "p1", taskId: null, seconds: 600 },
      { projectId: "p1", taskId: "t2", seconds: 600 },
      { projectId: null, taskId: null, seconds: 600 },
    ]);
    expect(taskSplit(s.days[0]?.byTask ?? new Map())[0]).toEqual({
      projectId: "p1",
      taskId: "t1",
      seconds: 1200,
    });
    const byTask = [...s.total.byTask.values()].reduce((a, b) => a + b.seconds, 0);
    expect(byTask).toBe(s.total.worked);
  });

  it("ignores days outside the week", () => {
    expect(summarizeWeek([row({ day: "2026-03-30" })], days).total.worked).toBe(0);
  });
});

describe("formatDuration", () => {
  it("shows hours and minutes", () => {
    expect(formatDuration(38 * 3600 + 20 * 60)).toBe("38 h 20 min");
    expect(formatDuration(3600 + 5 * 60)).toBe("1 h 05 min");
    expect(formatDuration(45 * 60)).toBe("45 min");
    expect(formatDuration(0)).toBe("0 min");
  });

  it("rounds to the minute only for display", () => {
    expect(formatDuration(89)).toBe("1 min");
    expect(formatDuration(91)).toBe("2 min");
  });
});
