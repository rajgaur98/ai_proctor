import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import type { ManualEntry } from "../day/entryData";
import type { Project, Task } from "../projects/projectData";
import {
  canLogTo,
  copyOutcomes,
  copyPlan,
  isFavourite,
  lastWeekRows,
  nextWeekTime,
  shownFavourites,
  skipText,
} from "./copyWeek";
import type { BreakdownRow } from "./summary";
import type { GridAssignment } from "./weekGridModel";
import { weekDays } from "./weeks";

const zone = "America/Los_Angeles";
// The week of 2 March 2026 (PST); the next one starts on 9 March, the day after the clocks
// go forward.
const lastWeek = weekDays("2026-03-02");
const now = DateTime.fromISO("2026-03-12T12:00:00", { zone });

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  name: id,
  clientId: null,
  billable: true,
  archived: false,
  memberIds: ["erin"],
  ...over,
});
const task = (id: string, projectId: string, archived = false): Task => ({
  id,
  projectId,
  name: id,
  billable: true,
  archived,
});
const mine = [project("p1"), project("p2")];
const tasks = [task("t1", "p1"), task("old", "p1", true), task("t2", "p2")];
const canLog = (a: GridAssignment) => canLogTo(a, mine, tasks);

const entry = (over: Partial<ManualEntry>): ManualEntry => ({
  id: "e1",
  startAt: "2026-03-02T10:00:00-08:00",
  endAt: "2026-03-02T12:00:00-08:00",
  projectId: "p1",
  taskId: null,
  reason: "Workshop",
  note: null,
  status: "approved",
  decisionNote: null,
  ...over,
});

const row = (over: Partial<BreakdownRow>): BreakdownRow => ({
  day: "2026-03-02",
  type: "verified",
  projectId: "p1",
  taskId: null,
  counted: true,
  flagged: false,
  excluded: false,
  seconds: 3600,
  ...over,
});

describe("nextWeekTime", () => {
  it("keeps the weekday and wall-clock time across a clock change", () => {
    const moved = nextWeekTime("2026-03-02T10:00:00-08:00", zone);
    expect(DateTime.fromISO(moved, { zone }).toFormat("yyyy-MM-dd HH:mm ZZ")).toBe(
      "2026-03-09 10:00 -07:00",
    );
    // Seven days less an hour, in absolute time.
    expect(Date.parse(moved) - Date.parse("2026-03-02T10:00:00-08:00")).toBe(
      (7 * 24 - 1) * 3600_000,
    );
  });

  it("is seven days exactly when the offset doesn't change", () => {
    const moved = nextWeekTime("2026-03-16T23:30:00-07:00", zone);
    expect(Date.parse(moved) - Date.parse("2026-03-16T23:30:00-07:00")).toBe(7 * 24 * 3600_000);
  });
});

describe("canLogTo", () => {
  it("allows Unassigned, the person's projects and their active tasks", () => {
    expect(canLog({ projectId: null, taskId: null })).toBe(true);
    expect(canLog({ projectId: "p1", taskId: null })).toBe(true);
    expect(canLog({ projectId: "p1", taskId: "t1" })).toBe(true);
    expect(canLog({ projectId: "p3", taskId: null })).toBe(false);
    expect(canLog({ projectId: "p1", taskId: "old" })).toBe(false);
    expect(canLog({ projectId: "p1", taskId: "t2" })).toBe(false);
  });
});

describe("lastWeekRows", () => {
  it("takes every row with time last week once, tracked or manual", () => {
    const rows = lastWeekRows(
      lastWeek,
      [row({}), row({ day: "2026-03-03" }), row({ projectId: "p1", taskId: "t1", type: "manual" })],
      [entry({ projectId: "p2", taskId: "t2", status: "pending" })],
      zone,
      [],
      canLog,
    );
    expect(rows).toEqual([
      { projectId: "p1", taskId: null },
      { projectId: "p1", taskId: "t1" },
      { projectId: "p2", taskId: "t2" },
    ]);
  });

  it("leaves out Unassigned, excluded time, rejected entries and other weeks", () => {
    const rows = lastWeekRows(
      lastWeek,
      [
        row({ projectId: null }),
        row({ projectId: "p2", excluded: true }),
        row({ projectId: "p2", day: "2026-03-09" }),
      ],
      [
        entry({ projectId: "p2", status: "rejected" }),
        entry({
          id: "e2",
          projectId: "p2",
          startAt: "2026-03-09T10:00:00-07:00",
          endAt: "2026-03-09T11:00:00-07:00",
        }),
      ],
      zone,
      [],
      canLog,
    );
    expect(rows).toEqual([]);
  });

  it("leaves out rows the person can't log to any more, and keeps the ones added", () => {
    const rows = lastWeekRows(
      lastWeek,
      [row({ projectId: "gone" }), row({ projectId: "p1", taskId: "old" })],
      [],
      zone,
      [{ projectId: "p2", taskId: null }],
      canLog,
    );
    expect(rows).toEqual([{ projectId: "p2", taskId: null }]);
  });

  it("puts an entry on the local day it starts on", () => {
    // Sunday 8 March 23:00 in Los Angeles is Monday in UTC: still last week.
    const rows = lastWeekRows(
      lastWeek,
      [],
      [entry({ startAt: "2026-03-08T23:00:00-07:00", endAt: "2026-03-09T00:30:00-07:00" })],
      zone,
      [],
      canLog,
    );
    expect(rows).toEqual([{ projectId: "p1", taskId: null }]);
  });
});

describe("copyPlan", () => {
  it("moves each of last week's entries seven days on, in time order", () => {
    const plan = copyPlan(
      [
        entry({
          id: "b",
          startAt: "2026-03-03T09:00:00-08:00",
          endAt: "2026-03-03T10:00:00-08:00",
        }),
        entry({ id: "a" }),
      ],
      lastWeek,
      zone,
      now,
      canLog,
    );
    expect(plan.map((p) => [p.entry.id, p.startAt, p.endAt, p.expected])).toEqual([
      ["a", "2026-03-09T10:00:00.000-07:00", "2026-03-09T12:00:00.000-07:00", null],
      ["b", "2026-03-10T09:00:00.000-07:00", "2026-03-10T10:00:00.000-07:00", null],
    ]);
  });

  it("copies pending and approved entries, not rejected ones or other weeks'", () => {
    const plan = copyPlan(
      [
        entry({ id: "pending", status: "pending" }),
        entry({ id: "rejected", status: "rejected" }),
        entry({
          id: "older",
          startAt: "2026-02-27T09:00:00-08:00",
          endAt: "2026-02-27T10:00:00-08:00",
        }),
      ],
      lastWeek,
      zone,
      now,
      canLog,
    );
    expect(plan.map((p) => p.entry.id)).toEqual(["pending"]);
  });

  it("says which it already knows will be skipped, and why", () => {
    const plan = copyPlan(
      [
        // Thursday 5 March 11:00-13:00 -> Thursday 12 March, past `now` (12:00).
        entry({
          id: "future",
          startAt: "2026-03-05T11:00:00-08:00",
          endAt: "2026-03-05T13:00:00-08:00",
        }),
        entry({ id: "left", projectId: "p3" }),
        entry({ id: "archived", taskId: "old" }),
        entry({
          id: "unassigned",
          projectId: null,
          startAt: "2026-03-04T09:00:00-08:00",
          endAt: "2026-03-04T10:00:00-08:00",
        }),
      ],
      lastWeek,
      zone,
      now,
      canLog,
    );
    expect(Object.fromEntries(plan.map((p) => [p.entry.id, p.expected]))).toEqual({
      future: "in_the_future",
      left: "project_not_allowed",
      archived: "task_not_allowed",
      unassigned: null,
    });
  });
});

describe("copyOutcomes", () => {
  it("joins the plan with what the database did", () => {
    const plan = copyPlan(
      [
        entry({ id: "a" }),
        entry({
          id: "b",
          startAt: "2026-03-03T09:00:00-08:00",
          endAt: "2026-03-03T10:00:00-08:00",
        }),
        entry({
          id: "c",
          startAt: "2026-03-04T09:00:00-08:00",
          endAt: "2026-03-04T10:00:00-08:00",
        }),
      ],
      lastWeek,
      zone,
      now,
      canLog,
    );
    const outcomes = copyOutcomes(plan, [
      { entryId: "a", id: "new-a", skipped: null },
      { entryId: "b", id: null, skipped: "overlaps_manual_entry" },
    ]);
    expect(outcomes.map((o) => [o.entry.id, o.skipped])).toEqual([
      ["a", null],
      ["b", "overlaps_manual_entry"],
      // Not in the answer at all: it isn't there any more.
      ["c", "entry_not_found"],
    ]);
  });
});

describe("skipText", () => {
  it("says each reason in words, and falls back to the code", () => {
    expect(skipText("overlaps_manual_entry")).toBe("It overlaps another manual entry.");
    expect(skipText("day_locked")).toBe("Its day is in an approved timesheet.");
    expect(skipText("in_the_future")).toBe("It would end in the future.");
    expect(skipText("project_not_allowed")).toBe("You can't log time to its project any more.");
    expect(skipText("something_new")).toBe("something_new");
  });
});

describe("favourites", () => {
  it("shows only pinned rows the person can log to", () => {
    const favs = [
      { projectId: "p1", taskId: null },
      { projectId: "p1", taskId: "old" },
      { projectId: "gone", taskId: null },
      { projectId: "p2", taskId: "t2" },
    ];
    expect(shownFavourites(favs, canLog)).toEqual([
      { projectId: "p1", taskId: null },
      { projectId: "p2", taskId: "t2" },
    ]);
  });

  it("knows a pinned row by project and task", () => {
    const favs = [{ projectId: "p1", taskId: null }];
    expect(isFavourite(favs, { projectId: "p1", taskId: null })).toBe(true);
    expect(isFavourite(favs, { projectId: "p1", taskId: "t1" })).toBe(false);
  });
});
