import { describe, expect, it } from "vitest";
import { presetOf, presetRange, rangeProblem } from "./range";

// 2026-03-18 is a Wednesday.
describe("presetRange", () => {
  it("this week runs from the week start to the week's last day", () => {
    expect(presetRange("this-week", "2026-03-18", 1)).toEqual({
      from: "2026-03-16",
      to: "2026-03-22",
    });
    expect(presetRange("this-week", "2026-03-16", 1)).toEqual({
      from: "2026-03-16",
      to: "2026-03-22",
    });
    expect(presetRange("this-week", "2026-03-22", 1)).toEqual({
      from: "2026-03-16",
      to: "2026-03-22",
    });
  });

  it("follows the org's week start", () => {
    // Sunday-based weeks.
    expect(presetRange("this-week", "2026-03-18", 7)).toEqual({
      from: "2026-03-15",
      to: "2026-03-21",
    });
    expect(presetRange("last-week", "2026-03-18", 7)).toEqual({
      from: "2026-03-08",
      to: "2026-03-14",
    });
  });

  it("last week is the seven days before this week", () => {
    expect(presetRange("last-week", "2026-03-18", 1)).toEqual({
      from: "2026-03-09",
      to: "2026-03-15",
    });
    expect(presetRange("last-week", "2026-03-02", 1)).toEqual({
      from: "2026-02-23",
      to: "2026-03-01",
    });
  });

  it("this month is the calendar month, to its last day", () => {
    expect(presetRange("this-month", "2026-03-18", 1)).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(presetRange("this-month", "2026-02-10", 1)).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(presetRange("this-month", "2028-02-10", 1)).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });
});

describe("presetOf", () => {
  it("names the preset a range is, or none", () => {
    expect(presetOf({ from: "2026-03-09", to: "2026-03-15" }, "2026-03-18", 1)).toBe("last-week");
    expect(presetOf({ from: "2026-03-16", to: "2026-03-22" }, "2026-03-18", 1)).toBe("this-week");
    expect(presetOf({ from: "2026-03-16", to: "2026-03-18" }, "2026-03-18", 1)).toBeNull();
  });
});

describe("rangeProblem", () => {
  it("accepts a range of up to a year and explains the rest", () => {
    expect(rangeProblem({ from: "2026-03-16", to: "2026-03-16" })).toBeNull();
    expect(rangeProblem({ from: "2025-03-16", to: "2026-03-16" })).toBeNull();
    expect(rangeProblem({ from: "2025-03-15", to: "2026-03-16" })).toContain("a year");
    expect(rangeProblem({ from: "2026-03-22", to: "2026-03-16" })).toContain("same or later");
    expect(rangeProblem({ from: "", to: "2026-03-16" })).toContain("same or later");
  });
});
