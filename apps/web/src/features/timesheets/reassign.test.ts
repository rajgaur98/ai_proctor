import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import type { Project } from "../projects/projectData";
import {
  allowedProjects,
  canReassignWeek,
  daySpan,
  type TimeSegment,
  unassignedSpans,
} from "./reassign";

const seg = (startAt: string, endAt: string, over: Partial<TimeSegment> = {}): TimeSegment => ({
  startAt,
  endAt,
  projectId: null,
  counted: true,
  excluded: false,
  flagged: false,
  ...over,
});

describe("canReassignWeek", () => {
  it("is the employee's own draft or returned week", () => {
    expect(canReassignWeek(true, "draft")).toBe(true);
    expect(canReassignWeek(true, "returned")).toBe(true);
  });
  it("is never a submitted or approved week, or someone else's", () => {
    expect(canReassignWeek(true, "submitted")).toBe(false);
    expect(canReassignWeek(true, "approved")).toBe(false);
    expect(canReassignWeek(false, "draft")).toBe(false);
    expect(canReassignWeek(true, undefined)).toBe(false);
  });
});

describe("allowedProjects", () => {
  const project = (id: string, over: Partial<Project> = {}): Project => ({
    id,
    name: id,
    clientId: null,
    billable: false,
    archived: false,
    memberIds: ["me"],
    ...over,
  });
  it("keeps assigned, active projects", () => {
    const list = [
      project("a"),
      project("b", { memberIds: ["someone"] }),
      project("c", { archived: true }),
    ];
    expect(allowedProjects(list, "me").map((p) => p.id)).toEqual(["a"]);
  });
});

describe("unassignedSpans", () => {
  it("joins touching segments and sums raw seconds", () => {
    const spans = unassignedSpans([
      seg("2026-03-16T16:00:00Z", "2026-03-16T17:00:00Z"),
      seg("2026-03-16T17:00:00Z", "2026-03-16T17:20:00Z", { flagged: true }),
      seg("2026-03-16T19:00:00Z", "2026-03-16T19:00:30Z"),
    ]);
    expect(spans).toEqual([
      {
        startAt: "2026-03-16T16:00:00Z",
        endAt: "2026-03-16T17:20:00Z",
        seconds: 4800,
        flagged: true,
      },
      {
        startAt: "2026-03-16T19:00:00Z",
        endAt: "2026-03-16T19:00:30Z",
        seconds: 30,
        flagged: false,
      },
    ]);
  });

  it("orders by time whatever the input order", () => {
    const spans = unassignedSpans([
      seg("2026-03-17T16:00:00Z", "2026-03-17T17:00:00Z"),
      seg("2026-03-16T16:00:00Z", "2026-03-16T17:00:00Z"),
    ]);
    expect(spans.map((s) => s.startAt)).toEqual(["2026-03-16T16:00:00Z", "2026-03-17T16:00:00Z"]);
  });

  it("leaves out assigned, uncounted and excluded time", () => {
    const spans = unassignedSpans([
      seg("2026-03-16T16:00:00Z", "2026-03-16T17:00:00Z", { projectId: "p1" }),
      seg("2026-03-16T17:00:00Z", "2026-03-16T17:30:00Z", { counted: false }),
      seg("2026-03-16T18:00:00Z", "2026-03-16T18:10:00Z", { excluded: true, flagged: true }),
    ]);
    expect(spans).toEqual([]);
  });

  it("does not join across a gap or an assigned segment", () => {
    const spans = unassignedSpans([
      seg("2026-03-16T16:00:00Z", "2026-03-16T17:00:00Z"),
      seg("2026-03-16T17:00:00Z", "2026-03-16T18:00:00Z", { projectId: "p1" }),
      seg("2026-03-16T18:00:00Z", "2026-03-16T19:00:00Z"),
    ]);
    expect(spans).toHaveLength(2);
  });
});

describe("daySpan", () => {
  const zone = "America/Los_Angeles";
  it("is the whole local day for a past day", () => {
    const now = DateTime.fromISO("2026-03-20T12:00:00Z");
    expect(daySpan("2026-03-16", zone, now)).toEqual({
      startAt: "2026-03-16T07:00:00.000Z",
      endAt: "2026-03-17T07:00:00.000Z",
    });
  });
  it("stops at now for today", () => {
    const now = DateTime.fromISO("2026-03-16T20:00:00Z");
    expect(daySpan("2026-03-16", zone, now)?.endAt).toBe("2026-03-16T20:00:00.000Z");
  });
  it("is null for a day that hasn't started", () => {
    const now = DateTime.fromISO("2026-03-16T20:00:00Z");
    expect(daySpan("2026-03-18", zone, now)).toBeNull();
  });
  it("follows a 23-hour daylight saving day", () => {
    const now = DateTime.fromISO("2026-03-20T12:00:00Z");
    expect(daySpan("2026-03-08", zone, now)).toEqual({
      startAt: "2026-03-08T08:00:00.000Z",
      endAt: "2026-03-09T07:00:00.000Z",
    });
  });
});
