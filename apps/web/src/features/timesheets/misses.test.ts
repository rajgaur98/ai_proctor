import { describe, expect, it } from "vitest";
import { missesBySegment, type WeekMiss } from "./misses";
import type { FlaggedSegment } from "./timesheetData";

const seg = (id: string, startAt: string, endAt: string): FlaggedSegment => ({
  id,
  day: startAt.slice(0, 10),
  type: "unverified",
  startAt,
  endAt,
  projectId: null,
  excluded: false,
  excludedReason: null,
  decision: null,
});
const miss = (id: string, at: string, kind: string | null = null): WeekMiss => ({
  id,
  at,
  kind,
  remark: null,
});

describe("missesBySegment", () => {
  const segments = [
    seg("a", "2026-10-26T14:03:12Z", "2026-10-26T14:58:00Z"),
    seg("b", "2026-10-27T09:00:00Z", "2026-10-27T09:30:00Z"),
  ];

  it("puts each miss on the flagged segment it starts, in time order", () => {
    const { bySegment, other } = missesBySegment(segments, [
      miss("m2", "2026-10-26T14:40:00Z", "meeting"),
      miss("m1", "2026-10-26T14:03:12Z", "other"),
      miss("m3", "2026-10-27T09:10:00Z"),
    ]);
    expect(bySegment.get("a")?.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(bySegment.get("b")?.map((m) => m.id)).toEqual(["m3"]);
    expect(other).toEqual([]);
  });

  it("keeps a miss outside every flagged segment, so it still shows", () => {
    const { bySegment, other } = missesBySegment(segments, [
      miss("end", "2026-10-26T14:58:00Z"),
      miss("later", "2026-10-28T10:00:00Z"),
    ]);
    expect(bySegment.size).toBe(0);
    expect(other.map((m) => m.id)).toEqual(["end", "later"]);
  });
});
