import { describe, expect, it } from "vitest";
import { hours, occurrence, type ShiftRule, windowsBetween } from "./shift.ts";

const la = (days: number[], start: string, end: string): ShiftRule => ({
  days,
  start,
  end,
  timezone: "America/Los_Angeles",
});

describe("occurrence", () => {
  it("is in the shift's own time zone", () => {
    // Monday 2026-10-19, 09:00 in Los Angeles = 16:00 UTC (PDT).
    const w = occurrence(la([1], "09:00", "17:30"), "2026-10-19");
    expect(w?.start.toISOString()).toBe("2026-10-19T16:00:00.000Z");
    expect(w && hours(w)).toBe(8.5);
  });

  it("is null on a day off", () => {
    expect(occurrence(la([1], "09:00", "17:00"), "2026-10-20")).toBeNull();
  });

  it("crosses midnight and belongs to its start day", () => {
    const night = la([6], "22:00", "06:00");
    const w = occurrence(night, "2026-10-24");
    expect(w?.start.toISOString()).toBe("2026-10-25T05:00:00.000Z");
    expect(w?.end.toISOString()).toBe("2026-10-25T13:00:00.000Z");
    expect(occurrence(night, "2026-10-25")).toBeNull();
  });

  it("is an hour shorter across spring-forward and longer across fall-back", () => {
    const night = la([1, 2, 3, 4, 5, 6, 7], "22:00", "06:00");
    // US DST ends Sunday 2026-11-01 and starts Sunday 2027-03-14.
    const fallBack = occurrence(night, "2026-10-31");
    const springForward = occurrence(night, "2027-03-13");
    expect(fallBack && hours(fallBack)).toBe(9);
    expect(springForward && hours(springForward)).toBe(7);
  });

  it("moves a start inside the DST gap forward", () => {
    // 02:30 doesn't exist in LA on 2027-03-14; it becomes 03:30 PDT (10:30 UTC).
    const w = occurrence(la([7], "02:30", "06:00"), "2027-03-14");
    expect(w?.start.toISOString()).toBe("2027-03-14T10:30:00.000Z");
  });
});

describe("windowsBetween", () => {
  it("includes a night shift that started the day before", () => {
    const night = la([1, 2, 3, 4, 5], "22:00", "06:00");
    // Tuesday 2026-10-20 in LA, midnight to midnight.
    const ws = windowsBetween(
      [night],
      new Date("2026-10-20T07:00:00Z"),
      new Date("2026-10-21T07:00:00Z"),
    );
    expect(ws.map((w) => w.start.toISOString())).toEqual([
      "2026-10-20T05:00:00.000Z", // Monday's, ending Tuesday 06:00
      "2026-10-21T05:00:00.000Z", // Tuesday's
    ]);
  });
});
