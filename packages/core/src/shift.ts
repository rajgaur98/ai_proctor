// Shift windows (SHF-01), the dashboard twin of the agent's shift.rs: days of the
// week and wall-clock times in the shift's IANA time zone. A shift whose end is at
// or before its start crosses midnight and belongs to the day it starts on. On a
// DST gap the wall time moves forward (Luxon); on an overlap the earlier instant.
import { DateTime } from "luxon";

export interface ShiftRule {
  /** ISO weekdays the shift starts on: 1 = Monday … 7 = Sunday. */
  days: number[];
  /** "HH:MM" local wall time. */
  start: string;
  end: string;
  timezone: string;
}

export interface Window {
  start: Date;
  end: Date;
}

function at(date: DateTime, hhmm: string): DateTime {
  const [hour = 0, minute = 0] = hhmm.split(":").map(Number);
  return DateTime.fromObject(
    { year: date.year, month: date.month, day: date.day, hour, minute },
    { zone: date.zone },
  );
}

/** The occurrence of `shift` that starts on the local calendar day `isoDate`. */
export function occurrence(shift: ShiftRule, isoDate: string): Window | null {
  const day = DateTime.fromISO(isoDate, { zone: shift.timezone });
  if (!day.isValid || !shift.days.includes(day.weekday)) return null;
  const crosses = shift.end <= shift.start;
  const start = at(day, shift.start);
  const end = at(crosses ? day.plus({ days: 1 }) : day, shift.end);
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/** Every shift occurrence overlapping [from, to), earliest first. */
export function windowsBetween(shifts: ShiftRule[], from: Date, to: Date): Window[] {
  const out: Window[] = [];
  for (const shift of shifts) {
    let day = DateTime.fromJSDate(from, { zone: shift.timezone }).startOf("day").minus({ days: 1 });
    const last = DateTime.fromJSDate(to, { zone: shift.timezone }).startOf("day");
    while (day <= last) {
      const w = occurrence(shift, day.toISODate() ?? "");
      if (w && w.start < to && w.end > from) out.push(w);
      day = day.plus({ days: 1 });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Hours, for display ("8.5 h"). */
export function hours(w: Window): number {
  return (w.end.getTime() - w.start.getTime()) / 3_600_000;
}
