// Reports (PRD 4.11 DSH-07): the per-employee aggregates `report_rows` returns, and the
// team's numbers added up from them. Pure, so the dashboard and the tests share it.
//
// Time is raw whole seconds, added up with the arithmetic the timesheet export and
// the dashboard's week summary use (exportRows.ts), so a report and a timesheet for
// the same range agree to the second (TS-05/06). Only the display rounds.
// A team's response rate is its passed check-ins over its shown ones (not the mean of
// the people's rates), so a person with three check-ins doesn't weigh like one with
// thirty; its median is the median of all the passes together, which only the database
// can see, so it comes in as an argument.

import { type ExportSegment, sumSegments } from "./exportRows.ts";

/** One employee's numbers for a span of days. */
export interface ReportRow {
  userId: string;
  fullName: string;
  managerId: string | null;
  workedS: number;
  flaggedS: number;
  excludedS: number;
  breakS: number;
  pauseS: number;
  manualS: number;
  checkinsShown: number;
  checkinsPassed: number;
  checkinsMissed: number;
  checkinsFailed: number;
  /** Passed / shown; null when nothing was shown. */
  responseRate: number | null;
  /** Median response time of the passed check-ins, in ms; null when there are none. */
  medianResponseMs: number | null;
  lateClockIns: number;
}

/** A row as `report_rows` returns it. */
export interface DbReportRow {
  user_id: string;
  full_name: string;
  manager_id: string | null;
  worked_s: number;
  flagged_s: number;
  excluded_s: number;
  break_s: number;
  pause_s: number;
  manual_s: number;
  checkins_shown: number;
  checkins_passed: number;
  checkins_missed: number;
  checkins_failed: number;
  response_rate: number | null;
  median_response_ms: number | null;
  late_clock_ins: number;
}

/** What `report_rows` returns: the rows and what applied to them. */
export interface DbReport {
  row_count: number;
  /** Minutes after shift start a clock-in may be before it is late. */
  late_grace_min: number;
  team_median_response_ms: number | null;
  rows: DbReportRow[];
}

export function fromDbReportRow(r: DbReportRow): ReportRow {
  return {
    userId: r.user_id,
    fullName: r.full_name,
    managerId: r.manager_id,
    workedS: Number(r.worked_s),
    flaggedS: Number(r.flagged_s),
    excludedS: Number(r.excluded_s),
    breakS: Number(r.break_s),
    pauseS: Number(r.pause_s),
    manualS: Number(r.manual_s),
    checkinsShown: Number(r.checkins_shown),
    checkinsPassed: Number(r.checkins_passed),
    checkinsMissed: Number(r.checkins_missed),
    checkinsFailed: Number(r.checkins_failed),
    responseRate: r.response_rate === null ? null : Number(r.response_rate),
    medianResponseMs: r.median_response_ms === null ? null : Number(r.median_response_ms),
    lateClockIns: Number(r.late_clock_ins),
  };
}

/**
 * Passed over shown, as a fraction (0 to 1); null when nothing was shown. Deferred
 * check-ins (CHK-03) are not shown, so they are not in `shown` (PRD section 10).
 */
export function responseRate(passed: number, shown: number): number | null {
  return shown > 0 ? passed / shown : null;
}

/** The middle value, or the mean of the two middle ones; null for an empty list. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] as number;
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] as number) + hi) / 2;
}

/** The seconds columns of a report, from stored segments (what `report_rows` sums). */
export interface ReportSeconds {
  workedS: number;
  flaggedS: number;
  excludedS: number;
  breakS: number;
  pauseS: number;
  manualS: number;
}

/**
 * The same sums `report_rows` makes in SQL, from the raw segments: worked, flagged,
 * excluded, break and manual are exportRows' (so a report equals an export and a
 * timesheet), pause is all pause time, within the cap or over it.
 */
export function secondsFromSegments(segments: ExportSegment[]): ReportSeconds {
  const d = sumSegments(segments);
  return {
    workedS: d.worked,
    flaggedS: d.flagged,
    excludedS: d.excluded,
    breakS: d.breakTime,
    pauseS: segments
      .filter((s) => s.type === "pause" || s.type === "pause_over_cap")
      .reduce((sum, s) => sum + s.seconds, 0),
    manualS: d.manual,
  };
}

/** The team: every count added up, the rate recomputed from the counts. */
export interface ReportTotals extends ReportSeconds {
  people: number;
  checkinsShown: number;
  checkinsPassed: number;
  checkinsMissed: number;
  checkinsFailed: number;
  responseRate: number | null;
  medianResponseMs: number | null;
  lateClockIns: number;
}

export function teamTotals(
  rows: readonly ReportRow[],
  teamMedianResponseMs: number | null,
): ReportTotals {
  const total: ReportTotals = {
    people: rows.length,
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
    medianResponseMs: teamMedianResponseMs,
    lateClockIns: 0,
  };
  for (const r of rows) {
    total.workedS += r.workedS;
    total.flaggedS += r.flaggedS;
    total.excludedS += r.excludedS;
    total.breakS += r.breakS;
    total.pauseS += r.pauseS;
    total.manualS += r.manualS;
    total.checkinsShown += r.checkinsShown;
    total.checkinsPassed += r.checkinsPassed;
    total.checkinsMissed += r.checkinsMissed;
    total.checkinsFailed += r.checkinsFailed;
    total.lateClockIns += r.lateClockIns;
  }
  total.responseRate = responseRate(total.checkinsPassed, total.checkinsShown);
  return total;
}
