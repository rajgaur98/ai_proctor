import { describe, expect, it } from "vitest";
import { barSpan, localDay, markerLeft, segments, ticks, totals } from "./timeline";

const zone = "America/Los_Angeles";
// Monday 2026-10-19 in LA (PDT, UTC-7).
const day = localDay("2026-10-19", zone);
const shift = { days: [1], start: "09:00", end: "17:00", timezone: zone };
const iso = (hhmm: string) => `2026-10-19T${hhmm}:00-07:00`;
const ms = (hhmm: string) => Date.parse(iso(hhmm));

describe("barSpan", () => {
  it("covers the shift", () => {
    expect(barSpan(day, zone, [shift], [], [], ms("12:00"))).toEqual({
      start: ms("09:00"),
      end: ms("17:00"),
    });
  });

  it("widens to activity outside the shift, rounded to the hour", () => {
    const periods = [{ status: "active" as const, start: iso("08:20"), end: iso("18:10") }];
    expect(barSpan(day, zone, [shift], periods, [], ms("20:00"))).toEqual({
      start: ms("08:00"),
      end: ms("19:00"),
    });
  });

  it("falls back to 09:00–17:00 with nothing to show", () => {
    expect(barSpan(day, zone, [], [], [], ms("12:00"))).toEqual({
      start: ms("09:00"),
      end: ms("17:00"),
    });
  });

  it("includes the tail of last night's shift", () => {
    const night = { days: [7], start: "22:00", end: "06:00", timezone: zone };
    expect(barSpan(day, zone, [night], [], [], ms("12:00")).start).toBe(ms("00:00"));
  });
});

describe("segments", () => {
  const span = { start: ms("09:00"), end: ms("17:00") };

  it("clips to the span, runs open periods to now, skips off shift", () => {
    const segs = segments(
      span,
      [
        { status: "active", start: iso("08:00"), end: iso("11:00") },
        { status: "off_shift", start: iso("11:00"), end: iso("12:00") },
        { status: "on_break", start: iso("12:00"), end: null },
      ],
      ms("13:00"),
    );
    expect(segs.map((s) => [s.status, s.left, s.width])).toEqual([
      ["active", 0, 25],
      ["on_break", 37.5, 12.5],
    ]);
    expect(totals(segs)).toEqual([
      { status: "active", reason: null, minutes: 120 },
      { status: "on_break", reason: null, minutes: 60 },
    ]);
  });
});

describe("tamper reasons on the bar", () => {
  const span = { start: ms("09:00"), end: ms("17:00") };

  it("keeps the reason on a segment and totals each reason apart", () => {
    const segs = segments(
      span,
      [
        { status: "tamper", reason: "agent_stopped", start: iso("09:00"), end: iso("09:10") },
        { status: "active", start: iso("09:10"), end: iso("10:00") },
        { status: "tamper", reason: "no_heartbeat", start: iso("10:00"), end: iso("10:05") },
        { status: "tamper", reason: "agent_stopped", start: iso("10:05"), end: iso("10:10") },
      ],
      ms("13:00"),
    );
    expect(segs.map((s) => s.reason)).toEqual([
      "agent_stopped",
      null,
      "no_heartbeat",
      "agent_stopped",
    ]);
    expect(totals(segs)).toEqual([
      { status: "active", reason: null, minutes: 50 },
      { status: "tamper", reason: "agent_stopped", minutes: 15 },
      { status: "tamper", reason: "no_heartbeat", minutes: 5 },
    ]);
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

  it("labels hours in the given zone", () => {
    expect(ticks(span, zone).map((t) => t.label)).toEqual(["10:00", "12:00", "14:00", "16:00"]);
  });
});
