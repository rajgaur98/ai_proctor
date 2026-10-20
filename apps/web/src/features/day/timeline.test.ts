import { describe, expect, it } from "vitest";
import {
  barSegments,
  barSpan,
  type DaySegment,
  localDay,
  markerLeft,
  shiftText,
  ticks,
  typeTotals,
} from "./timeline";

const zone = "America/Los_Angeles";
// Monday 2026-10-19 in LA (PDT, UTC-7).
const day = localDay("2026-10-19", zone);
const shift = { days: [1], start: "09:00", end: "17:00", timezone: zone };
const iso = (hhmm: string) => `2026-10-19T${hhmm}:00-07:00`;
const ms = (hhmm: string) => Date.parse(iso(hhmm));
const seg = (type: DaySegment["type"], from: string, to: string, flagged = false): DaySegment => ({
  type,
  start: ms(from),
  end: ms(to),
  flagged,
  excluded: false,
  counted: true,
});

describe("barSpan", () => {
  it("covers the shift", () => {
    expect(barSpan(day, zone, [shift], [], [])).toEqual({
      start: ms("09:00"),
      end: ms("17:00"),
    });
  });

  it("widens to activity outside the shift, rounded to the hour", () => {
    const segs = [seg("verified", "08:20", "18:10")];
    expect(barSpan(day, zone, [shift], segs, [])).toEqual({
      start: ms("08:00"),
      end: ms("19:00"),
    });
  });

  it("falls back to 09:00–17:00 with nothing to show", () => {
    expect(barSpan(day, zone, [], [], [])).toEqual({
      start: ms("09:00"),
      end: ms("17:00"),
    });
  });

  it("includes the tail of last night's shift", () => {
    const night = { days: [7], start: "22:00", end: "06:00", timezone: zone };
    expect(barSpan(day, zone, [night], [], []).start).toBe(ms("00:00"));
  });
});

describe("barSegments", () => {
  const span = { start: ms("09:00"), end: ms("17:00") };

  it("clips to the span, drops what falls outside and keeps the flag", () => {
    const segs = barSegments(span, [
      seg("verified", "08:00", "11:00"),
      seg("idle", "11:00", "12:00", true),
      seg("break", "17:30", "18:00"),
    ]);
    expect(segs.map((s) => [s.type, s.left, s.width, s.flagged])).toEqual([
      ["verified", 0, 25, false],
      ["idle", 25, 12.5, true],
    ]);
  });
});

describe("typeTotals", () => {
  it("sums raw seconds per type, largest first", () => {
    expect(
      typeTotals([
        seg("verified", "09:00", "10:00"),
        seg("idle", "10:00", "10:05", true),
        seg("verified", "10:05", "11:00"),
      ]),
    ).toEqual([
      { type: "verified", seconds: 7_200 - 300 },
      { type: "idle", seconds: 300 },
    ]);
  });
});

describe("shiftText", () => {
  it("lists the shifts that start that day, in the employee's zone", () => {
    expect(shiftText([shift], "2026-10-19", zone)).toBe("Shift 09:00–17:00 (PDT)");
    expect(shiftText([shift], "2026-10-20", zone)).toBe("No shift");
  });
});

describe("markers and ticks", () => {
  const span = { start: ms("09:00"), end: ms("17:00") };

  it("places a check-in where it was shown", () => {
    const c = {
      id: "1",
      scheduledAt: iso("12:58"),
      shownAt: iso("13:00"),
      outcome: "miss" as const,
      deferralReason: null,
    };
    expect(markerLeft(span, c)).toBe(50);
    expect(markerLeft(span, { ...c, shownAt: iso("18:00") })).toBeNull();
  });

  it("puts a deferred check-in, which was never shown, at the time it was due", () => {
    const c = {
      id: "c2",
      scheduledAt: iso("13:00"),
      shownAt: null,
      outcome: "deferred" as const,
      deferralReason: "call",
    };
    expect(markerLeft(span, c)).toBe(50);
  });

  it("calls the end of a full-day bar 24:00, not 00:00 again", () => {
    const full = { start: ms("00:00"), end: ms("00:00") + 24 * 3_600_000 };
    const labels = ticks(full, zone).map((t) => t.label);
    expect(labels[0]).toBe("00:00");
    expect(labels[labels.length - 1]).toBe("24:00");
  });

  it("labels hours in the given zone", () => {
    expect(ticks(span, zone).map((t) => t.label)).toEqual(["10:00", "12:00", "14:00", "16:00"]);
  });
});
