import { describe, expect, it } from "vitest";
import { type DigestReport, digestLineText, digestSummary, plural } from "./digest.ts";

const report = (over: Partial<DigestReport>): DigestReport => ({
  user_id: "u",
  full_name: "Someone",
  worked_s: 0,
  flagged_s: 0,
  misses: 0,
  late_clock_ins: 0,
  ...over,
});

describe("digestSummary", () => {
  it("lists reports by name with hours and minutes", () => {
    const s = digestSummary([
      report({ user_id: "b", full_name: "Lucas Martin", worked_s: 3600, misses: 1 }),
      report({
        user_id: "a",
        full_name: "Erin Employee",
        worked_s: 12_600,
        flagged_s: 1800,
        misses: 1,
        late_clock_ins: 1,
      }),
    ]);
    expect(s.lines).toEqual([
      {
        userId: "a",
        name: "Erin Employee",
        worked: "3:30",
        flagged: "0:30",
        misses: 1,
        lateClockIns: 1,
      },
      {
        userId: "b",
        name: "Lucas Martin",
        worked: "1:00",
        flagged: "0:00",
        misses: 1,
        lateClockIns: 0,
      },
    ]);
  });

  it("adds the totals up from raw seconds, rounding only for display", () => {
    // 29 s + 29 s: each rounds to 0:00 alone, together they are a minute.
    const s = digestSummary([
      report({ user_id: "a", full_name: "A", worked_s: 29, flagged_s: 31 }),
      report({ user_id: "b", full_name: "B", worked_s: 31, flagged_s: 29 }),
    ]);
    expect(s.lines.map((l) => l.worked)).toEqual(["0:00", "0:01"]);
    expect(s.total.worked).toBe("0:01");
    expect(s.total.flagged).toBe("0:01");
  });

  it("treats missing or bad numbers as zero", () => {
    const s = digestSummary([
      report({ worked_s: Number.NaN, flagged_s: -5, misses: undefined as unknown as number }),
    ]);
    expect(s.total).toEqual({ worked: "0:00", flagged: "0:00", misses: 0, lateClockIns: 0 });
  });

  it("keeps the same order for the same names", () => {
    const s = digestSummary([
      report({ user_id: "2", full_name: "Sam" }),
      report({ user_id: "1", full_name: "Sam" }),
    ]);
    expect(s.lines.map((l) => l.userId)).toEqual(["1", "2"]);
  });
});

describe("digest text", () => {
  it("writes one line per report", () => {
    expect(
      digestLineText({
        name: "Erin Employee",
        worked: "7:26",
        flagged: "0:30",
        misses: 1,
        lateClockIns: 2,
      }),
    ).toBe("Erin Employee: 7:26 worked, 0:30 flagged, 1 missed check-in, 2 late clock-ins");
  });

  it("pluralises", () => {
    expect(plural(0, "miss", "misses")).toBe("0 misses");
    expect(plural(1, "miss", "misses")).toBe("1 miss");
  });
});
