// The managers' daily digest (PRD 4.12 ALR-03, #67): what internal.digest_eval puts in
// an email's payload, and the lines the send-emails function writes from it. Pure, so
// the email and the tests share it.
//
// Seconds stay raw whole seconds; the totals are added up from them and only the
// display rounds (to the minute, like the dashboard: clockHours).

import { clockHours } from "./exportRows.ts";

/** One direct report's yesterday, as the digest payload carries it. */
export interface DigestReport {
  user_id: string;
  full_name: string;
  worked_s: number;
  flagged_s: number;
  misses: number;
  late_clock_ins: number;
}

/** One line of the digest, ready to show. */
export interface DigestLine {
  userId: string;
  name: string;
  /** "7:26" (hours:minutes). */
  worked: string;
  flagged: string;
  misses: number;
  lateClockIns: number;
}

export interface DigestSummary {
  lines: DigestLine[];
  total: Omit<DigestLine, "userId" | "name">;
}

const whole = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};

/** The digest's lines by name, and the team's totals added up from the raw seconds. */
export function digestSummary(reports: readonly DigestReport[]): DigestSummary {
  const sorted = [...reports].sort(
    (a, b) => a.full_name.localeCompare(b.full_name, "en") || a.user_id.localeCompare(b.user_id),
  );
  let worked = 0;
  let flagged = 0;
  let misses = 0;
  let late = 0;
  const lines = sorted.map((r) => {
    const line = {
      userId: r.user_id,
      name: r.full_name,
      worked: clockHours(whole(r.worked_s)),
      flagged: clockHours(whole(r.flagged_s)),
      misses: whole(r.misses),
      lateClockIns: whole(r.late_clock_ins),
    };
    worked += whole(r.worked_s);
    flagged += whole(r.flagged_s);
    misses += line.misses;
    late += line.lateClockIns;
    return line;
  });
  return {
    lines,
    total: {
      worked: clockHours(worked),
      flagged: clockHours(flagged),
      misses,
      lateClockIns: late,
    },
  };
}

/** "1 missed check-in", "2 missed check-ins". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One report's line as plain text: "Erin Employee: 7:26 worked, 0:30 flagged, 1 missed check-in, 1 late clock-in". */
export function digestLineText(l: Omit<DigestLine, "userId">): string {
  return [
    `${l.name}: ${l.worked} worked`,
    `${l.flagged} flagged`,
    plural(l.misses, "missed check-in", "missed check-ins"),
    plural(l.lateClockIns, "late clock-in", "late clock-ins"),
  ].join(", ");
}

// The weekly insights email (PRD 4.18 INS-06, #305) ------------------------------------------
// internal.weekly_insights_eval puts the manager's direct reports' totals for last week and
// the week before in the payload (insights_totals: raw seconds and counts). These are the
// lines the email shows: one metric per line, last week next to the week before, plain
// totals with no score, ranking or verdict (INS-03).

/** One metric of the weekly email, ready to show. */
export interface WeeklyLine {
  label: string;
  /** Last week. */
  value: string;
  /** The week before. */
  previous: string;
}

type Totals = Record<string, unknown>;

const n = (t: Totals, key: string): number => whole(t[key]);
const rate = (v: unknown): string => {
  const x = Number(v);
  return v === null || v === undefined || !Number.isFinite(x) ? "—" : `${Math.round(x * 100)}%`;
};
const seconds = (v: unknown): string => {
  const x = Number(v);
  return v === null || v === undefined || !Number.isFinite(x) ? "—" : `${(x / 1000).toFixed(1)} s`;
};
const ratio = (part: number, all: number): string =>
  all > 0 ? `${Math.round((part / all) * 100)}%` : "—";

const WEEKLY: { label: string; show: (t: Totals) => string }[] = [
  { label: "Worked", show: (t) => clockHours(n(t, "worked_s")) },
  { label: "Scheduled", show: (t) => clockHours(n(t, "scheduled_s")) },
  { label: "Shift days on time", show: (t) => `${n(t, "on_time")} of ${n(t, "shift_days")}` },
  { label: "Late clock-ins", show: (t) => String(n(t, "late_clock_ins")) },
  { label: "Shift days without a clock-in", show: (t) => String(n(t, "no_clock_in")) },
  { label: "Check-in response rate", show: (t) => rate(t.response_rate) },
  { label: "Median response", show: (t) => seconds(t.median_response_ms) },
  { label: "Missed check-ins", show: (t) => String(n(t, "checkins_missed")) },
  { label: "Flagged", show: (t) => clockHours(n(t, "flagged_s")) },
  { label: "Billable share", show: (t) => ratio(n(t, "billable_s"), n(t, "worked_s")) },
  { label: "Anti-cheat flags to review", show: (t) => String(n(t, "needs_review")) },
  { label: "Tamper", show: (t) => String(n(t, "tamper")) },
];

/** The weekly email's lines, from the payload's `current` and `previous` totals. */
export function weeklyInsightsLines(current: Totals, previous: Totals): WeeklyLine[] {
  return WEEKLY.map((w) => ({
    label: w.label,
    value: w.show(current ?? {}),
    previous: w.show(previous ?? {}),
  }));
}

/** "Worked: 9:30 (week before 2:00)". */
export function weeklyLineText(l: WeeklyLine): string {
  return `${l.label}: ${l.value} (week before ${l.previous})`;
}
