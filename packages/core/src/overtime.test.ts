import { describe, expect, it } from "vitest";
import { isOver, overtimeFromPolicy, thresholdLabel, weekOf } from "./overtime.ts";

describe("isOver", () => {
  it("is above the threshold, not at it", () => {
    expect(isOver(8 * 3600, 8)).toBe(false);
    expect(isOver(8 * 3600 + 1, 8)).toBe(true);
    expect(isOver(0, 8)).toBe(false);
  });

  it("is never over when the threshold is off", () => {
    expect(isOver(100 * 3600, null)).toBe(false);
    expect(isOver(100 * 3600, 0)).toBe(false);
  });

  it("compares decimal hours in whole seconds", () => {
    // 7.3 * 3600 is 26279.999... in floating point.
    expect(isOver(26280, 7.3)).toBe(false);
    expect(isOver(26281, 7.3)).toBe(true);
    expect(isOver(37.5 * 3600, 37.5)).toBe(false);
    expect(isOver(37.5 * 3600 + 1, 37.5)).toBe(true);
  });
});

describe("overtimeFromPolicy", () => {
  it("reads the two keys, off when missing, null or not a positive number", () => {
    expect(overtimeFromPolicy({ overtime_daily_hours: 8, overtime_weekly_hours: 40 })).toEqual({
      dailyHours: 8,
      weeklyHours: 40,
    });
    expect(overtimeFromPolicy({ overtime_daily_hours: null })).toEqual({
      dailyHours: null,
      weeklyHours: null,
    });
    expect(overtimeFromPolicy({ overtime_daily_hours: "8", overtime_weekly_hours: 0 })).toEqual({
      dailyHours: null,
      weeklyHours: null,
    });
    expect(overtimeFromPolicy(null)).toEqual({ dailyHours: null, weeklyHours: null });
  });
});

describe("thresholdLabel", () => {
  it("drops trailing zeros", () => {
    expect(thresholdLabel(8)).toBe("8 h");
    expect(thresholdLabel(37.5)).toBe("37.5 h");
    expect(thresholdLabel(7.25)).toBe("7.25 h");
  });
});

describe("weekOf", () => {
  it("finds the week start on or before the day", () => {
    // 2026-03-16 is a Monday.
    expect(weekOf("2026-03-16", "monday")).toBe("2026-03-16");
    expect(weekOf("2026-03-22", "monday")).toBe("2026-03-16");
    expect(weekOf("2026-03-23", "monday")).toBe("2026-03-23");
    expect(weekOf("2026-03-22", "sunday")).toBe("2026-03-22");
    expect(weekOf("2026-03-21", "sunday")).toBe("2026-03-15");
    expect(weekOf("2026-03-18", "thursday")).toBe("2026-03-12");
  });

  it("treats a missing or unknown week start as Monday", () => {
    expect(weekOf("2026-03-19", null)).toBe("2026-03-16");
    expect(weekOf("2026-03-19", "Funday")).toBe("2026-03-16");
    expect(weekOf("2026-03-19", "MONDAY")).toBe("2026-03-16");
  });

  it("crosses months and years", () => {
    expect(weekOf("2026-01-01", "monday")).toBe("2025-12-29");
  });
});
