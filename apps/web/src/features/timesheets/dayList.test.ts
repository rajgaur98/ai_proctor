import { describe, expect, it } from "vitest";
import type { ManualEntry } from "../day/entryData";
import {
  canMerge,
  editRange,
  isBillable,
  localDay,
  mergePartner,
  middleTime,
  onDay,
  splitPoint,
  type TrackedSegment,
  trackedRuns,
  weekDayList,
} from "./dayList";

const LA = "America/Los_Angeles";

const entry = (startAt: string, endAt: string, over: Partial<ManualEntry> = {}): ManualEntry => ({
  id: `${startAt}-${endAt}`,
  startAt,
  endAt,
  projectId: "p1",
  taskId: null,
  reason: "Offline",
  note: null,
  status: "pending",
  decisionNote: null,
  ...over,
});

const seg = (
  startAt: string,
  endAt: string,
  over: Partial<TrackedSegment> = {},
): TrackedSegment => ({
  day: "2026-03-16",
  type: "verified",
  startAt,
  endAt,
  projectId: "p1",
  taskId: null,
  flagged: false,
  excluded: false,
  ...over,
});

describe("trackedRuns", () => {
  it("joins back-to-back segments of the same assignment, summing raw seconds", () => {
    const runs = trackedRuns([
      seg("2026-03-16T16:00:07Z", "2026-03-16T16:20:00Z"),
      seg("2026-03-16T16:20:00Z", "2026-03-16T17:00:00Z", { type: "meeting" }),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      startAt: "2026-03-16T16:00:07Z",
      endAt: "2026-03-16T17:00:00Z",
      seconds: 3593,
    });
  });
  it("keeps a gap, another project or task, and flagged or excluded time apart", () => {
    const runs = trackedRuns([
      seg("2026-03-16T16:00:00Z", "2026-03-16T16:10:00Z"),
      seg("2026-03-16T16:20:00Z", "2026-03-16T16:30:00Z"),
      seg("2026-03-16T16:30:00Z", "2026-03-16T16:40:00Z", { taskId: "t1" }),
      seg("2026-03-16T16:40:00Z", "2026-03-16T16:50:00Z", { taskId: "t1", flagged: true }),
      seg("2026-03-16T16:50:00Z", "2026-03-16T17:00:00Z", {
        taskId: "t1",
        flagged: true,
        excluded: true,
      }),
      seg("2026-03-16T17:00:00Z", "2026-03-16T17:10:00Z", { projectId: null }),
    ]);
    expect(runs).toHaveLength(6);
    expect(runs.reduce((a, r) => a + r.seconds, 0)).toBe(3600);
  });
  it("leaves out manual segments, sorts by start", () => {
    const runs = trackedRuns([
      seg("2026-03-16T18:00:00Z", "2026-03-16T19:00:00Z"),
      seg("2026-03-16T16:00:00Z", "2026-03-16T17:00:00Z", { type: "manual" }),
      seg("2026-03-16T15:00:00Z", "2026-03-16T15:30:00Z"),
    ]);
    expect(runs.map((r) => r.startAt)).toEqual(["2026-03-16T15:00:00Z", "2026-03-16T18:00:00Z"]);
  });
});

describe("weekDayList", () => {
  it("puts each entry on the local day it starts and orders items by time", () => {
    const days = ["2026-03-16", "2026-03-17"];
    // 23:30 on the 16th in Los Angeles is the 17th in UTC.
    const late = entry("2026-03-17T06:30:00Z", "2026-03-17T07:30:00Z");
    const morning = entry("2026-03-16T15:00:00Z", "2026-03-16T16:00:00Z");
    const list = weekDayList(
      days,
      [seg("2026-03-16T17:00:00Z", "2026-03-16T18:00:00Z")],
      [late, morning],
      LA,
    );
    expect(list[0]?.items.map((i) => i.kind)).toEqual(["manual", "tracked", "manual"]);
    expect(list[0]?.items.at(-1)).toMatchObject({ kind: "manual", seconds: 3600 });
    expect(list[1]?.items).toEqual([]);
  });
});

describe("canMerge and mergePartner", () => {
  const a = entry("2026-03-16T20:00:00Z", "2026-03-16T21:00:00Z");
  const b = entry("2026-03-16T21:00:00Z", "2026-03-16T21:30:00Z");
  it("merges entries that touch, on one day, with the same project and task", () => {
    expect(canMerge(a, b, LA)).toBe(true);
    expect(mergePartner(a, [a, b], LA)).toBe(b);
    expect(mergePartner(b, [a, b], LA)).toBeNull();
  });
  it("not with a gap, another project or task, or a rejected entry", () => {
    expect(canMerge(a, { ...b, startAt: "2026-03-16T21:00:01Z" }, LA)).toBe(false);
    expect(canMerge(a, { ...b, projectId: null }, LA)).toBe(false);
    expect(canMerge(a, { ...b, taskId: "t1" }, LA)).toBe(false);
    expect(canMerge(a, { ...b, status: "rejected" }, LA)).toBe(false);
    expect(canMerge({ ...a, status: "rejected" }, b, LA)).toBe(false);
  });
  it("not across local midnight", () => {
    const before = entry("2026-03-17T06:00:00Z", "2026-03-17T07:00:00Z");
    const after = entry("2026-03-17T07:00:00Z", "2026-03-17T08:00:00Z");
    expect(localDay(before.startAt, LA)).toBe("2026-03-16");
    expect(localDay(after.startAt, LA)).toBe("2026-03-17");
    expect(canMerge(before, after, LA)).toBe(false);
  });
});

describe("splitPoint", () => {
  const e = entry("2026-03-16T20:00:00Z", "2026-03-16T22:00:00Z"); // 13:00–15:00 PDT
  it("is the time on the entry's day, strictly inside it", () => {
    expect(splitPoint(e, "14:00", LA)).toBe("2026-03-16T14:00:00.000-07:00");
    expect(splitPoint(e, "13:00", LA)).toBeNull();
    expect(splitPoint(e, "15:00", LA)).toBeNull();
    expect(splitPoint(e, "16:00", LA)).toBeNull();
    expect(splitPoint(e, "", LA)).toBeNull();
  });
  it("parts that sum to the entry's seconds", () => {
    const odd = entry("2026-03-16T20:00:07Z", "2026-03-16T21:59:53Z");
    const at = splitPoint(odd, "13:47", LA) ?? "";
    const first = (Date.parse(at) - Date.parse(odd.startAt)) / 1000;
    const second = (Date.parse(odd.endAt) - Date.parse(at)) / 1000;
    expect(first + second).toBe((Date.parse(odd.endAt) - Date.parse(odd.startAt)) / 1000);
    expect(first).toBe(2813);
  });
  it("finds a time after midnight in an entry that runs past it", () => {
    const night = entry("2026-03-17T05:00:00Z", "2026-03-17T09:00:00Z"); // 22:00–02:00
    expect(splitPoint(night, "01:00", LA)).toBe("2026-03-17T01:00:00.000-07:00");
    expect(splitPoint(night, "23:00", LA)).toBe("2026-03-16T23:00:00.000-07:00");
  });
  it("defaults to a minute near the middle", () => {
    expect(middleTime(e, LA)).toBe("14:00");
  });
});

describe("onDay", () => {
  it("keeps the local start time and the length to the second", () => {
    const e = entry("2026-03-16T20:00:30Z", "2026-03-16T21:30:45Z");
    expect(onDay(e, "2026-03-18", LA)).toEqual({
      startAt: "2026-03-18T13:00:30.000-07:00",
      endAt: "2026-03-18T14:30:45.000-07:00",
    });
    expect(onDay(e, "", LA)).toBeNull();
  });
  it("keeps the wall-clock start across a DST change", () => {
    // 13:00 PST on 6 March; 8 March 2026 is the switch to PDT.
    const e = entry("2026-03-06T21:00:00Z", "2026-03-06T22:00:00Z");
    expect(onDay(e, "2026-03-09", LA)?.startAt).toBe("2026-03-09T13:00:00.000-07:00");
  });
});

describe("editRange", () => {
  it("is the times on the day, the end on the next day when it isn't after the start", () => {
    expect(editRange("2026-03-16", "13:00", "14:30", LA)).toEqual({
      startAt: "2026-03-16T13:00:00.000-07:00",
      endAt: "2026-03-16T14:30:00.000-07:00",
    });
    expect(editRange("2026-03-16", "22:00", "01:00", LA)?.endAt).toBe(
      "2026-03-17T01:00:00.000-07:00",
    );
    expect(editRange("2026-03-16", "", "01:00", LA)).toBeNull();
  });
});

describe("isBillable", () => {
  const projects = [
    { id: "p1", billable: true },
    { id: "p2", billable: false },
  ];
  const tasks = [{ id: "t1", billable: false }];
  it("is the task's flag, else the project's; Unassigned isn't", () => {
    expect(isBillable("p1", null, projects, tasks)).toBe(true);
    expect(isBillable("p1", "t1", projects, tasks)).toBe(false);
    expect(isBillable("p2", null, projects, tasks)).toBe(false);
    expect(isBillable(null, null, projects, tasks)).toBe(false);
  });
});
