import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ExportSegment, sumSegments } from "./exportRows.ts";
import {
  type DbReportRow,
  fromDbReportRow,
  median,
  type ReportRow,
  responseRate,
  secondsFromSegments,
  teamTotals,
} from "./reportRows.ts";

const seg = (over: Partial<ExportSegment> = {}): ExportSegment => ({
  userId: "u1",
  employee: "Erin Employee",
  email: "erin@acme.test",
  timezone: "America/Los_Angeles",
  day: "2026-03-16",
  startLocal: "2026-03-16 09:00:00",
  endLocal: "2026-03-16 10:00:00",
  type: "verified",
  projectId: null,
  project: null,
  client: null,
  billable: false,
  counted: true,
  flagged: false,
  excluded: false,
  seconds: 3600,
  status: "draft",
  approver: null,
  ...over,
});

const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  userId: "u1",
  fullName: "Erin Employee",
  managerId: null,
  workedS: 0,
  flaggedS: 0,
  excludedS: 0,
  breakS: 0,
  pauseS: 0,
  manualS: 0,
  checkinsShown: 0,
  checkinsPassed: 0,
  checkinsMissed: 0,
  checkinsFailed: 0,
  responseRate: null,
  medianResponseMs: null,
  lateClockIns: 0,
  anomalyFlags: 0,
  needsReview: 0,
  ...over,
});

describe("responseRate", () => {
  it("is passed over shown, null when nothing was shown", () => {
    expect(responseRate(5, 8)).toBe(0.625);
    expect(responseRate(0, 3)).toBe(0);
    expect(responseRate(3, 3)).toBe(1);
    expect(responseRate(0, 0)).toBeNull();
  });

  it("stays within 0 and 1 for any passed <= shown", () => {
    fc.assert(
      fc.property(fc.nat(500), fc.nat(500), (a, b) => {
        const [passed, shown] = a <= b ? [a, b] : [b, a];
        const rate = responseRate(passed, shown);
        if (shown === 0) expect(rate).toBeNull();
        else expect(rate).toBeGreaterThanOrEqual(0);
        if (rate !== null) expect(rate).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe("median", () => {
  it("takes the middle, or the mean of the two middle values", () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([9000, 1000, 4000, 2000])).toBe(3000);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([100, 200])).toBe(150);
  });

  it("does not reorder its input", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("lies between the smallest and the largest, with half the values on each side", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 120_000 }), { minLength: 1 }), (xs) => {
        const m = median(xs) as number;
        expect(m).toBeGreaterThanOrEqual(Math.min(...xs));
        expect(m).toBeLessThanOrEqual(Math.max(...xs));
        expect(xs.filter((x) => x <= m).length).toBeGreaterThanOrEqual(xs.length / 2);
        expect(xs.filter((x) => x >= m).length).toBeGreaterThanOrEqual(xs.length / 2);
      }),
    );
  });
});

describe("secondsFromSegments", () => {
  it("counts like the export, and pause is all pause time", () => {
    const s = secondsFromSegments([
      seg({ seconds: 7200 }),
      seg({ type: "idle", flagged: true, seconds: 1200 }),
      seg({ type: "unverified", flagged: true, excluded: true, seconds: 1500 }),
      seg({ type: "break", counted: false, seconds: 900 }),
      seg({ type: "manual", seconds: 3600 }),
      seg({ type: "pause", seconds: 600 }),
      seg({ type: "pause_over_cap", counted: false, flagged: true, seconds: 300 }),
    ]);
    expect(s).toEqual({
      workedS: 7200 + 1200 + 3600 + 600,
      flaggedS: 1200 + 300,
      excludedS: 1500,
      breakS: 900,
      pauseS: 900,
      manualS: 3600,
    });
  });
});

describe("teamTotals", () => {
  it("adds the counts up and recomputes the rate from them", () => {
    const t = teamTotals(
      [
        row({
          workedS: 3600,
          checkinsShown: 10,
          checkinsPassed: 9,
          checkinsMissed: 1,
          lateClockIns: 1,
          anomalyFlags: 3,
          needsReview: 2,
        }),
        row({
          userId: "u2",
          workedS: 1800,
          flaggedS: 600,
          breakS: 300,
          pauseS: 120,
          checkinsShown: 2,
          checkinsPassed: 0,
          checkinsMissed: 1,
          checkinsFailed: 1,
        }),
        row({ userId: "u3" }),
      ],
      3000,
    );
    expect(t).toMatchObject({
      people: 3,
      workedS: 5400,
      flaggedS: 600,
      breakS: 300,
      pauseS: 120,
      checkinsShown: 12,
      checkinsPassed: 9,
      checkinsMissed: 2,
      checkinsFailed: 1,
      lateClockIns: 1,
      anomalyFlags: 3,
      needsReview: 2,
      medianResponseMs: 3000,
    });
    // 9 of 12, not the mean of 90% and 0% and nothing.
    expect(t.responseRate).toBe(0.75);
  });

  it("has no rate and no median for an empty team", () => {
    const t = teamTotals([], null);
    expect(t.people).toBe(0);
    expect(t.responseRate).toBeNull();
    expect(t.medianResponseMs).toBeNull();
  });

  it("equals the sums over all the segments, however they are split between people", () => {
    const types = ["verified", "idle", "unverified", "break", "manual", "pause", "pause_over_cap"];
    const segment = fc
      .record({
        user: fc.constantFrom("u1", "u2", "u3"),
        type: fc.constantFrom(...types),
        counted: fc.boolean(),
        flagged: fc.boolean(),
        excluded: fc.boolean(),
        seconds: fc.integer({ min: 1, max: 5 * 3600 }),
      })
      .map(({ user, ...rest }) =>
        seg({ userId: user, ...rest, excluded: rest.flagged && rest.excluded }),
      );
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 80 }), (segs) => {
        const users = [...new Set(segs.map((s) => s.userId))];
        const rows = users.map((u) =>
          row({ userId: u, ...secondsFromSegments(segs.filter((s) => s.userId === u)) }),
        );
        const t = teamTotals(rows, null);
        const all = secondsFromSegments(segs);
        expect(t.workedS).toBe(all.workedS);
        expect(t.flaggedS).toBe(all.flaggedS);
        expect(t.excludedS).toBe(all.excludedS);
        expect(t.breakS).toBe(all.breakS);
        expect(t.pauseS).toBe(all.pauseS);
        expect(t.manualS).toBe(all.manualS);
        // And the worked and flagged time is what the export and the timesheet add up to.
        expect(t.workedS).toBe(sumSegments(segs).worked);
        expect(t.flaggedS).toBe(sumSegments(segs).flagged);
      }),
    );
  });
});

describe("fromDbReportRow", () => {
  it("maps the database row, keeping nulls", () => {
    const db: DbReportRow = {
      user_id: "u1",
      full_name: "Erin Employee",
      manager_id: "m1",
      worked_s: 19800,
      flagged_s: 1500,
      excluded_s: 1500,
      break_s: 900,
      pause_s: 900,
      manual_s: 3600,
      checkins_shown: 8,
      checkins_passed: 5,
      checkins_missed: 2,
      checkins_failed: 1,
      response_rate: 0.625,
      median_response_ms: 3000,
      late_clock_ins: 1,
      anomaly_flags: 4,
      needs_review: 1,
    };
    expect(fromDbReportRow(db)).toEqual({
      userId: "u1",
      fullName: "Erin Employee",
      managerId: "m1",
      workedS: 19800,
      flaggedS: 1500,
      excludedS: 1500,
      breakS: 900,
      pauseS: 900,
      manualS: 3600,
      checkinsShown: 8,
      checkinsPassed: 5,
      checkinsMissed: 2,
      checkinsFailed: 1,
      responseRate: 0.625,
      medianResponseMs: 3000,
      lateClockIns: 1,
      anomalyFlags: 4,
      needsReview: 1,
    });
    expect(
      fromDbReportRow({ ...db, manager_id: null, response_rate: null, median_response_ms: null }),
    ).toMatchObject({ managerId: null, responseRate: null, medianResponseMs: null });
  });

  it("reads a row without the flag counts (a database before #63) as none", () => {
    const {
      anomaly_flags: _a,
      needs_review: _n,
      ...old
    } = {
      user_id: "u1",
      full_name: "Erin Employee",
      manager_id: null,
      worked_s: 0,
      flagged_s: 0,
      excluded_s: 0,
      break_s: 0,
      pause_s: 0,
      manual_s: 0,
      checkins_shown: 0,
      checkins_passed: 0,
      checkins_missed: 0,
      checkins_failed: 0,
      response_rate: null,
      median_response_ms: null,
      late_clock_ins: 0,
      anomaly_flags: 9,
      needs_review: 9,
    } satisfies DbReportRow;
    expect(fromDbReportRow(old)).toMatchObject({ anomalyFlags: 0, needsReview: 0 });
  });
});
