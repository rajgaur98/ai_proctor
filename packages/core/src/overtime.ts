// Overtime thresholds (PRD 4.10 TS-19): org settings overtime_daily_hours and
// overtime_weekly_hours (null when off). Time above a threshold is only highlighted, in
// the dashboard's timesheet pages and in the XLSX export; nothing is paid, deducted or
// recalculated. Worked seconds stay raw; a threshold is compared in whole seconds.

export interface OvertimeThresholds {
  /** Worked hours in a day above which the day is highlighted; null is off. */
  dailyHours: number | null;
  /** Worked hours in a week above which the week is highlighted; null is off. */
  weeklyHours: number | null;
}

export const NO_OVERTIME: OvertimeThresholds = { dailyHours: null, weeklyHours: null };

function hours(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** The thresholds from an org policy object (orgs.policy); a missing or bad key is off. */
export function overtimeFromPolicy(policy: unknown): OvertimeThresholds {
  const p = (policy && typeof policy === "object" ? policy : {}) as Record<string, unknown>;
  return { dailyHours: hours(p.overtime_daily_hours), weeklyHours: hours(p.overtime_weekly_hours) };
}

/** Whether `seconds` of worked time is above a threshold of `thresholdHours` (off: never). */
export function isOver(seconds: number, thresholdHours: number | null): boolean {
  if (thresholdHours === null || !(thresholdHours > 0)) return false;
  return seconds > Math.round(thresholdHours * 3600);
}

/** "8 h", "37.5 h": a threshold as people read it. */
export function thresholdLabel(thresholdHours: number): string {
  return `${Number(thresholdHours.toFixed(2))} h`;
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * The first day of the week containing `day` (YYYY-MM-DD), for the org's week_start
 * (monday..sunday; anything else is Monday), as internal.week_start computes it.
 */
export function weekOf(day: string, weekStart: string | null | undefined): string {
  const start = WEEKDAYS.indexOf((weekStart ?? "").toLowerCase());
  const startIso = start === -1 ? 1 : start + 1;
  const date = new Date(`${day}T00:00:00Z`);
  const iso = ((date.getUTCDay() + 6) % 7) + 1; // Monday 1 .. Sunday 7
  date.setUTCDate(date.getUTCDate() - ((iso - startIso + 7) % 7));
  return date.toISOString().slice(0, 10);
}
