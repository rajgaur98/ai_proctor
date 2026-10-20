// Weekly periods (#43, TS-10): a week is seven employee-local days starting on the
// org's week-start day (policy.week_start, default Monday). Dates are ISO
// "YYYY-MM-DD" strings in the employee's zone, like the rest of the timesheet.
import { DateTime } from "luxon";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** The org's week-start day as a Luxon weekday (1 = Monday ... 7 = Sunday). */
export function weekStartDay(policyValue: unknown): number {
  const index = typeof policyValue === "string" ? WEEKDAYS.indexOf(policyValue.toLowerCase()) : -1;
  return index === -1 ? 1 : index + 1;
}

/** The week start on or before `isoDate`. */
export function weekStartOf(isoDate: string, startDay: number): string {
  const day = DateTime.fromISO(isoDate, { zone: "utc" });
  const back = (day.weekday - startDay + 7) % 7;
  return day.minus({ days: back }).toISODate() ?? isoDate;
}

export function addWeeks(weekStart: string, weeks: number): string {
  return DateTime.fromISO(weekStart, { zone: "utc" }).plus({ weeks }).toISODate() ?? weekStart;
}

/** The seven days of the week, in order. */
export function weekDays(weekStart: string): string[] {
  const first = DateTime.fromISO(weekStart, { zone: "utc" });
  return Array.from({ length: 7 }, (_, i) => first.plus({ days: i }).toISODate() ?? weekStart);
}

/** "Week of 6 Oct". */
export function weekLabel(weekStart: string): string {
  return `Week of ${DateTime.fromISO(weekStart, { zone: "utc" }).toFormat("d LLL")}`;
}

/** "Mon 6 Oct". */
export function dayLabel(isoDate: string): string {
  return DateTime.fromISO(isoDate, { zone: "utc" }).toFormat("ccc d LLL");
}

/** The newest `count` week starts up to and including the week of `today`, newest first. */
export function recentWeeks(today: string, startDay: number, count: number): string[] {
  const current = weekStartOf(today, startDay);
  return Array.from({ length: count }, (_, i) => addWeeks(current, -i));
}
