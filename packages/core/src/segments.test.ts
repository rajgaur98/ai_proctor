import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildSegments,
  type DayInput,
  localDayBounds,
  type Segment,
  type SegmentType,
  segmentTotals,
} from "./segments.ts";

const at = (iso: string) => Date.parse(iso) / 1000;
const t = (hhmm: string) => at(`2026-10-19T${hhmm}:00Z`);
const day = { start: t("00:00"), end: at("2026-10-20T00:00:00Z") };
const policy = { breaksPaid: false, pauseMaxS: 15 * 60, pauseDailyMaxS: 60 * 60 };

function input(partial: Partial<DayInput>): DayInput {
  return {
    day,
    now: day.end,
    clockSessions: [],
    manualEntries: [],
    breaks: [],
    pauses: [],
    statusPeriods: [],
    checkins: [],
    projectSwitches: [],
    policy,
    ...partial,
  };
}

const show = (segments: Segment[]) =>
  segments.map((s) => {
    const hhmm = (x: number) => new Date(x * 1000).toISOString().slice(11, 16);
    return `${hhmm(s.start)}-${hhmm(s.end)} ${s.type}${s.projectId ? ` ${s.projectId}` : ""}`;
  });

describe("buildSegments", () => {
  // LLD section 06, the morning drawn there.
  const morning = input({
    clockSessions: [{ start: t("09:00"), end: t("13:00"), projectId: null }],
    statusPeriods: [
      { status: "in_meeting", start: t("09:00"), end: t("09:30") },
      { status: "idle", start: t("10:30"), end: t("11:00") },
    ],
    checkins: [
      { at: t("09:40"), outcome: "pass" },
      { at: t("10:50"), outcome: "miss" },
      { at: t("11:15"), outcome: "pass" },
      { at: t("12:40"), outcome: "pass" },
    ],
    pauses: [{ start: t("11:30"), end: t("11:42") }],
    breaks: [{ start: t("12:00"), end: t("12:30") }],
  });

  it("matches the LLD's worked morning", () => {
    const segments = buildSegments(morning);
    expect(show(segments)).toEqual([
      "09:00-09:30 meeting",
      "09:30-10:30 verified",
      "10:30-10:50 idle",
      "10:50-11:15 unverified",
      "11:15-11:30 verified",
      "11:30-11:42 pause",
      "11:42-12:00 verified",
      "12:00-12:30 break",
      "12:30-13:00 verified",
    ]);
    const totals = segmentTotals(segments);
    expect(totals.worked).toBe(3.5 * 3600);
    expect(totals.flagged).toBe(45 * 60);
    expect(totals.byType).toMatchObject({
      idle: 20 * 60,
      unverified: 25 * 60,
      pause: 12 * 60,
      break: 30 * 60,
    });
  });

  it("counts breaks when the org pays them", () => {
    const paid = segmentTotals(
      buildSegments({ ...morning, policy: { ...policy, breaksPaid: true } }),
    );
    expect(paid.worked).toBe(4 * 3600);
  });

  it("splits pauses at the per-pause and daily caps", () => {
    const segments = buildSegments(
      input({
        clockSessions: [{ start: t("09:00"), end: t("17:00"), projectId: null }],
        pauses: [
          { start: t("10:00"), end: t("10:20") }, // 15 counted, 5 over the per-pause cap
          { start: t("11:00"), end: t("11:15") },
          { start: t("12:00"), end: t("12:15") },
          { start: t("13:00"), end: t("13:15") }, // only 15 of the day's 60 left before this
          { start: t("14:00"), end: t("14:10") }, // all over the daily cap
        ],
      }),
    );
    const totals = segmentTotals(segments);
    expect(totals.byType.pause).toBe(60 * 60);
    expect(totals.byType.pause_over_cap).toBe(15 * 60);
    expect(show(segments)).toContain("10:15-10:20 pause_over_cap");
    expect(show(segments)).toContain("14:00-14:10 pause_over_cap");
  });

  // BRK-06: a pause across local midnight is split there. The per-pause cap covers the
  // whole pause (anchored at its start); each day has its own daily cap.
  describe("pauses across midnight", () => {
    const day1 = day;
    const day2 = { start: day.end, end: day.end + 24 * H };
    const night = (pauses: DayInput["pauses"], p = policy): [DayInput, DayInput] => {
      const facts = {
        clockSessions: [{ start: t("20:00"), end: day2.start + 2 * H, projectId: null }],
        pauses,
        policy: p,
      };
      return [
        input({ ...facts, day: day1, now: day2.end }),
        input({ ...facts, day: day2, now: day2.end }),
      ];
    };

    it("counts the first 15 minutes of the whole pause, across the two days", () => {
      const [a, b] = night([{ start: t("23:50"), end: day2.start + 30 * 60 }]);
      expect(show(buildSegments(a))).toEqual(["20:00-23:50 verified", "23:50-00:00 pause"]);
      expect(show(buildSegments(b))).toEqual([
        "00:00-00:05 pause",
        "00:05-00:30 pause_over_cap",
        "00:30-02:00 verified",
      ]);
    });

    it("gives each day its own daily cap", () => {
      // Day one has 55 minutes counted before midnight: only 5 of the late pause's
      // 10 eligible minutes fit. Day two starts clean, so its 5 eligible minutes count.
      const earlier = [
        { start: t("20:00"), end: t("20:15") },
        { start: t("21:00"), end: t("21:15") },
        { start: t("22:00"), end: t("22:15") },
        { start: t("23:00"), end: t("23:10") },
      ];
      const [a, b] = night([...earlier, { start: t("23:50"), end: day2.start + 30 * 60 }]);
      const first = segmentTotals(buildSegments(a));
      expect(first.byType.pause).toBe(60 * 60);
      expect(first.byType.pause_over_cap).toBe(5 * 60);
      expect(show(buildSegments(a)).slice(-2)).toEqual([
        "23:50-23:55 pause",
        "23:55-00:00 pause_over_cap",
      ]);
      expect(show(buildSegments(b)).slice(0, 2)).toEqual([
        "00:00-00:05 pause",
        "00:05-00:30 pause_over_cap",
      ]);
    });

    it("a long pause counts nothing on the second day once the first 15 minutes are used", () => {
      const [a, b] = night([{ start: t("23:00"), end: day2.start + H }]);
      expect(show(buildSegments(a))).toContain("23:00-23:15 pause");
      expect(show(buildSegments(a))).toContain("23:15-00:00 pause_over_cap");
      expect(show(buildSegments(b))[0]).toBe("00:00-01:00 pause_over_cap");
    });
  });

  it("break wins over everything; offline and locked over a miss", () => {
    const segments = buildSegments(
      input({
        clockSessions: [{ start: t("09:00"), end: t("12:00"), projectId: null }],
        checkins: [{ at: t("09:30"), outcome: "miss" }],
        statusPeriods: [
          { status: "away_locked", start: t("10:00"), end: t("10:30") },
          { status: "offline", start: t("10:15"), end: t("10:45") },
        ],
        breaks: [{ start: t("10:40"), end: t("11:00") }],
      }),
    );
    expect(show(segments)).toEqual([
      "09:00-09:30 verified",
      "09:30-10:00 unverified",
      "10:00-10:15 away",
      "10:15-10:40 offline",
      "10:40-11:00 break",
      "11:00-12:00 unverified",
    ]);
  });

  it("carries the project in force, switches and the employee's edits", () => {
    const segments = buildSegments(
      input({
        clockSessions: [{ start: t("09:00"), end: t("12:00"), projectId: "A" }],
        projectSwitches: [
          { at: t("10:00"), projectId: "B" },
          { at: t("11:00"), projectId: null },
        ],
        projectEdits: [{ start: t("11:30"), end: t("12:00"), projectId: "A" }],
      }),
    );
    expect(show(segments)).toEqual([
      "09:00-10:00 verified A",
      "10:00-11:00 verified B",
      "11:00-11:30 verified",
      "11:30-12:00 verified A",
    ]);
  });

  it("adds approved manual time outside clocked time only", () => {
    const segments = buildSegments(
      input({
        clockSessions: [{ start: t("09:00"), end: t("10:00"), projectId: null }],
        manualEntries: [{ start: t("09:30"), end: t("11:00"), projectId: "M" }],
      }),
    );
    expect(show(segments)).toEqual(["09:00-10:00 verified", "10:00-11:00 manual M"]);
  });

  it("stops open intervals at now", () => {
    const segments = buildSegments(
      input({
        now: t("10:30"),
        clockSessions: [{ start: t("09:00"), end: null, projectId: null }],
        breaks: [{ start: t("10:00"), end: null }],
      }),
    );
    expect(show(segments)).toEqual(["09:00-10:00 verified", "10:00-10:30 break"]);
  });
});

describe("local days (golden: midnight and DST)", () => {
  it("takes only the part of a night shift inside the day", () => {
    // Shift 22:00 Sunday → 06:00 Monday, Chicago (UTC-5 in October).
    const monday = localDayBounds("2026-10-19", "America/Chicago");
    const segments = buildSegments(
      input({
        day: monday,
        now: monday.end,
        clockSessions: [
          { start: at("2026-10-19T03:00:00Z"), end: at("2026-10-19T11:00:00Z"), projectId: null },
        ],
      }),
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.start).toBe(monday.start);
    expect(segmentTotals(segments).worked).toBe(6 * 3600);
  });

  it("a fall-back day is 25 hours and its night shift is counted to the second", () => {
    // US DST ends Sunday 1 Nov 2026: 00:00 PDT → 06:00 PST is 7 real hours.
    const sunday = localDayBounds("2026-11-01", "America/Los_Angeles");
    expect(sunday.end - sunday.start).toBe(25 * 3600);
    const segments = buildSegments(
      input({
        day: sunday,
        now: sunday.end,
        clockSessions: [
          { start: at("2026-11-01T05:00:00Z"), end: at("2026-11-01T14:00:00Z"), projectId: null },
        ],
      }),
    );
    expect(segmentTotals(segments).worked).toBe(7 * 3600);
  });

  it("a spring-forward day is 23 hours", () => {
    const sunday = localDayBounds("2027-03-14", "America/Los_Angeles");
    expect(sunday.end - sunday.start).toBe(23 * 3600);
  });
});

// --- properties (fast-check) ----------------------------------------------------

const H = 3600;
const base = t("06:00");
const time = fc.integer({ min: 0, max: 14 * H }).map((s) => base + s);
const span = fc
  .tuple(time, fc.integer({ min: 1, max: 3 * H }))
  .map(([s, d]) => ({ start: s, end: s + d }));
const project = fc.constantFrom(null, "A", "B");

const arbitraryDay: fc.Arbitrary<DayInput> = fc.record({
  day: fc.constant(day),
  now: fc.oneof(fc.constant(day.end), time),
  clockSessions: fc.array(
    fc.tuple(span, project, fc.boolean()).map(([s, p, open]) => ({
      start: s.start,
      end: open ? null : s.end,
      projectId: p,
    })),
    { maxLength: 3 },
  ),
  manualEntries: fc.array(
    fc.tuple(span, project).map(([s, p]) => ({ ...s, projectId: p })),
    {
      maxLength: 2,
    },
  ),
  breaks: fc.array(
    span.map((s) => ({ ...s })),
    { maxLength: 3 },
  ),
  pauses: fc.array(
    span.map((s) => ({ ...s })),
    { maxLength: 4 },
  ),
  statusPeriods: fc.array(
    fc
      .tuple(
        span,
        fc.constantFrom("offline", "away_locked", "in_meeting", "idle", "tamper", "active"),
      )
      .map(([s, status]) => ({ ...s, status: status as "idle" })),
    { maxLength: 6 },
  ),
  checkins: fc.array(
    fc.tuple(time, fc.constantFrom("pass", "miss", "failed")).map(([a, o]) => ({
      at: a,
      outcome: o as "pass",
    })),
    { maxLength: 6 },
  ),
  projectSwitches: fc.array(
    fc.tuple(time, project).map(([a, p]) => ({ at: a, projectId: p })),
    {
      maxLength: 4,
    },
  ),
  policy: fc.record({
    breaksPaid: fc.boolean(),
    pauseMaxS: fc.integer({ min: 60, max: 30 * 60 }),
    pauseDailyMaxS: fc.integer({ min: 60, max: 2 * H }),
  }),
});

/** Expected covered seconds, computed independently: clocked ∪ manual, clipped. */
function expectedSeconds(d: DayInput): number {
  const limitEnd = Math.min(d.day.end, d.now);
  const seconds = new Set<number>();
  const add = (start: number, end: number) => {
    for (let s = Math.max(start, d.day.start); s < Math.min(end, limitEnd); s += 60) seconds.add(s);
  };
  // Every generated time is a multiple of 60 s away from `base`, so minutes suffice.
  for (const c of d.clockSessions) add(c.start, c.end ?? d.now);
  for (const m of d.manualEntries) add(m.start, m.end);
  return seconds.size * 60;
}

const shuffled = <T>(xs: T[]) => [...xs].reverse();

describe("properties", () => {
  const minuteAligned = arbitraryDay.map((d) => {
    const m = (x: number) => base + Math.round((x - base) / 60) * 60;
    return {
      ...d,
      now: m(d.now),
      clockSessions: d.clockSessions.map((c) => ({
        ...c,
        start: m(c.start),
        end: c.end === null ? null : m(c.end),
      })),
      manualEntries: d.manualEntries.map((x) => ({ ...x, start: m(x.start), end: m(x.end) })),
    };
  });

  it("segments never overlap and are in order", () => {
    fc.assert(
      fc.property(arbitraryDay, (d) => {
        const segments = buildSegments(d);
        for (let i = 1; i < segments.length; i++) {
          const prev = segments[i - 1] as Segment;
          expect(prev.end).toBeLessThanOrEqual((segments[i] as Segment).start);
        }
        for (const s of segments) expect(s.end).toBeGreaterThan(s.start);
      }),
    );
  });

  it("together they cover exactly clocked-in plus manual time (no gaps)", () => {
    fc.assert(
      fc.property(minuteAligned, (d) => {
        const segments = buildSegments(d);
        const covered = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
        expect(covered).toBe(expectedSeconds(d));
      }),
    );
  });

  it("totals are sums of raw seconds", () => {
    fc.assert(
      fc.property(arbitraryDay, (d) => {
        const segments = buildSegments(d);
        const totals = segmentTotals(segments);
        const byType = Object.values(totals.byType).reduce((a, b) => a + (b ?? 0), 0);
        expect(byType).toBe(segments.reduce((sum, s) => sum + s.end - s.start, 0));
        expect(totals.worked).toBeLessThanOrEqual(byType);
        expect(totals.flagged).toBeLessThanOrEqual(totals.worked);
      }),
    );
  });

  it("is idempotent and doesn't depend on input order", () => {
    fc.assert(
      fc.property(arbitraryDay, (d) => {
        const once = buildSegments(d);
        expect(buildSegments(d)).toEqual(once);
        const reordered: DayInput = {
          ...d,
          breaks: shuffled(d.breaks),
          pauses: shuffled(d.pauses),
          statusPeriods: shuffled(d.statusPeriods),
          checkins: shuffled(d.checkins),
          projectSwitches: shuffled(d.projectSwitches),
          manualEntries: shuffled(d.manualEntries),
        };
        expect(buildSegments(reordered)).toEqual(once);
      }),
    );
  });

  it("neighbours never share type and project (fully merged)", () => {
    fc.assert(
      fc.property(arbitraryDay, (d) => {
        const segments = buildSegments(d);
        for (let i = 1; i < segments.length; i++) {
          const a = segments[i - 1] as Segment;
          const b = segments[i] as Segment;
          if (a.end === b.start)
            expect(a.type !== b.type || a.projectId !== b.projectId).toBe(true);
        }
      }),
    );
  });
});

describe("pause caps across midnight (properties)", () => {
  const day1 = day;
  const day2 = { start: day.end, end: day.end + 24 * H };
  // Non-overlapping pauses around the midnight between the two days, built from a
  // gap and a length each (the server never has two open at once).
  const pauseList = fc
    .array(fc.tuple(fc.integer({ min: 0, max: 4 * H }), fc.integer({ min: 1, max: 2 * H })), {
      minLength: 1,
      maxLength: 5,
    })
    .map((steps) => {
      const out: { start: number; end: number }[] = [];
      let cursor = day2.start - 8 * H;
      for (const [gap, length] of steps) {
        const start = cursor + gap;
        out.push({ start, end: start + length });
        cursor = start + length;
      }
      return out;
    });
  const caps = fc.record({
    breaksPaid: fc.boolean(),
    pauseMaxS: fc.integer({ min: 60, max: 30 * 60 }),
    pauseDailyMaxS: fc.integer({ min: 60, max: 2 * H }),
  });
  const forDay = (
    d: { start: number; end: number },
    pauses: { start: number; end: number }[],
    p: DayInput["policy"],
  ) =>
    buildSegments(
      input({
        day: d,
        now: day2.end,
        // Clocked in the whole time, so every pause second shows up in a segment.
        clockSessions: [{ start: day1.start, end: day2.end, projectId: null }],
        pauses,
        policy: p,
      }),
    );
  const seconds = (segments: Segment[], type: SegmentType) =>
    segments.filter((s) => s.type === type).reduce((n, s) => n + s.end - s.start, 0);
  const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

  it("each day shows exactly its own part of the pauses, counted or not", () => {
    fc.assert(
      fc.property(pauseList, caps, (pauses, p) => {
        for (const d of [day1, day2]) {
          const segments = forDay(d, pauses, p);
          const own = pauses.reduce((n, x) => n + overlap(x, d), 0);
          expect(seconds(segments, "pause") + seconds(segments, "pause_over_cap")).toBe(own);
        }
      }),
    );
  });

  it("a day never counts more than its daily cap", () => {
    fc.assert(
      fc.property(pauseList, caps, (pauses, p) => {
        for (const d of [day1, day2]) {
          expect(seconds(forDay(d, pauses, p), "pause")).toBeLessThanOrEqual(p.pauseDailyMaxS);
        }
      }),
    );
  });

  it("a day counts min(daily cap, the eligible time it holds), the rule close_pause uses", () => {
    fc.assert(
      fc.property(pauseList, caps, (pauses, p) => {
        for (const d of [day1, day2]) {
          const eligible = pauses.reduce(
            (n, x) =>
              n +
              overlap({ start: x.start, end: x.start + Math.min(x.end - x.start, p.pauseMaxS) }, d),
            0,
          );
          expect(seconds(forDay(d, pauses, p), "pause")).toBe(Math.min(p.pauseDailyMaxS, eligible));
        }
      }),
    );
  });

  it("one pause counts at most the per-pause cap in total, over both days", () => {
    fc.assert(
      fc.property(pauseList, caps, (pauses, p) => {
        const [only] = pauses as [{ start: number; end: number }];
        const counted = [day1, day2].reduce(
          (n, d) => n + seconds(forDay(d, [only], p), "pause"),
          0,
        );
        expect(counted).toBeLessThanOrEqual(Math.min(only.end - only.start, p.pauseMaxS));
      }),
    );
  });

  it("without a daily cap in the way, a single pause counts min(length, per-pause cap) in total", () => {
    fc.assert(
      fc.property(pauseList, caps, (pauses, p) => {
        const [only] = pauses as [{ start: number; end: number }];
        const wide = { ...p, pauseDailyMaxS: 24 * H };
        const counted = [day1, day2].reduce(
          (n, d) => n + seconds(forDay(d, [only], wide), "pause"),
          0,
        );
        expect(counted).toBe(Math.min(only.end - only.start, p.pauseMaxS));
      }),
    );
  });
});
