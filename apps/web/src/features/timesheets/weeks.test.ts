import { describe, expect, it } from "vitest";
import {
  addWeeks,
  dayLabel,
  recentWeeks,
  weekDays,
  weekLabel,
  weekStartDay,
  weekStartOf,
} from "./weeks";

describe("weekStartDay", () => {
  it("reads the policy value, Monday by default", () => {
    expect(weekStartDay(undefined)).toBe(1);
    expect(weekStartDay("sunday")).toBe(7);
    expect(weekStartDay("Wednesday")).toBe(3);
    expect(weekStartDay("someday")).toBe(1);
    expect(weekStartDay(3)).toBe(1);
  });
});

describe("weekStartOf", () => {
  it("finds the start on or before a day", () => {
    // 2026-03-18 is a Wednesday.
    expect(weekStartOf("2026-03-18", 1)).toBe("2026-03-16");
    expect(weekStartOf("2026-03-16", 1)).toBe("2026-03-16");
    expect(weekStartOf("2026-03-22", 1)).toBe("2026-03-16");
    expect(weekStartOf("2026-03-18", 7)).toBe("2026-03-15");
    expect(weekStartOf("2026-03-18", 3)).toBe("2026-03-18");
    expect(weekStartOf("2026-03-17", 3)).toBe("2026-03-11");
  });

  it("crosses month and year ends", () => {
    expect(weekStartOf("2027-01-01", 1)).toBe("2026-12-28");
  });
});

describe("weeks", () => {
  it("lists seven days across a clock change", () => {
    expect(weekDays("2026-03-02")).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
    ]);
  });

  it("steps by whole weeks", () => {
    expect(addWeeks("2026-03-16", -1)).toBe("2026-03-09");
    expect(addWeeks("2026-12-28", 1)).toBe("2027-01-04");
  });

  it("lists recent weeks, newest first", () => {
    expect(recentWeeks("2026-03-18", 1, 3)).toEqual(["2026-03-16", "2026-03-09", "2026-03-02"]);
  });

  it("labels", () => {
    expect(weekLabel("2026-10-06")).toBe("Week of 6 Oct");
    expect(dayLabel("2026-10-06")).toBe("Tue 6 Oct");
  });
});
