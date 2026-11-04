// Words for time off (#304, LV-01..03): when a request is, its state, a holiday's place,
// and what the database's error codes mean. Pure, so it is unit-tested and shared by the
// Time off page, notifications and the audit log.
import { DateTime } from "luxon";

export type LeaveKind = "days" | "part_day";
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface LeaveSpan {
  kind: string;
  firstDay: string;
  lastDay: string;
  startAt: string;
  endAt: string;
  /** The person's zone when they asked; a part day's times are read in it. */
  timezone: string;
}

function day(iso: string): string {
  const d = DateTime.fromISO(iso);
  return d.isValid ? d.toFormat("ccc d LLL yyyy") : iso;
}

function shortDay(iso: string): string {
  const d = DateTime.fromISO(iso);
  return d.isValid ? d.toFormat("ccc d LLL") : iso;
}

/**
 * "Mon 16 Nov 2026", "Mon 16 Nov – Fri 20 Nov 2026" or "Fri 4 Dec 2026, 13:00–15:30 PST".
 * Dates are the person's own local days; a part day's times are in their zone, named.
 */
export function leaveWhen(s: LeaveSpan): string {
  if (s.kind === "part_day") {
    const from = DateTime.fromISO(s.startAt, { zone: s.timezone });
    const to = DateTime.fromISO(s.endAt, { zone: s.timezone });
    if (!from.isValid || !to.isValid) return day(s.firstDay);
    return `${day(s.firstDay)}, ${from.toFormat("HH:mm")}–${to.toFormat("HH:mm")} ${to.toFormat("ZZZZ")}`;
  }
  if (s.firstDay === s.lastDay) return day(s.firstDay);
  return `${shortDay(s.firstDay)} – ${day(s.lastDay)}`;
}

/** Whole days asked for (a part day counts as none), both ends included. */
export function leaveDays(s: Pick<LeaveSpan, "kind" | "firstDay" | "lastDay">): number {
  if (s.kind === "part_day") return 0;
  const n = DateTime.fromISO(s.lastDay).diff(DateTime.fromISO(s.firstDay), "days").days;
  return Number.isFinite(n) ? Math.round(n) + 1 : 0;
}

/** "3 days", "1 day", or "2 h 30 min" for a part day. */
export function leaveLength(s: LeaveSpan): string {
  if (s.kind === "part_day") {
    const minutes = Math.round(
      DateTime.fromISO(s.endAt).diff(DateTime.fromISO(s.startAt), "minutes").minutes,
    );
    if (!Number.isFinite(minutes) || minutes <= 0) return "";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return [h ? `${h} h` : null, m ? `${m} min` : null].filter(Boolean).join(" ");
  }
  const n = leaveDays(s);
  return `${n} ${n === 1 ? "day" : "days"}`;
}

export const leaveStatusLabel: Record<LeaveStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Declined",
  cancelled: "Cancelled",
};

export function statusLabel(status: string): string {
  return leaveStatusLabel[status as LeaveStatus] ?? status;
}

/** "Everyone", "US", "US · CA". */
export function holidayPlace(country: string | null, state: string | null): string {
  if (!country) return "Everyone";
  return state ? `${country} · ${state}` : country;
}

const errors: Record<string, string> = {
  admin_only: "Only owners and admins can do this.",
  name_taken: "There is already a leave type with that name.",
  invalid_leave_type: "Give the leave type a name.",
  leave_type_not_found: "That leave type isn't available.",
  invalid_holiday: "Check the holiday's date, name and place.",
  holiday_exists: "There is already a holiday on that date for that place.",
  holiday_not_found: "That holiday is gone.",
  invalid_dates:
    "Choose dates from 31 days ago up to a year ahead, with the last day on or after the first.",
  invalid_times: "A part day ends after it starts, on the same day.",
  invalid_note: "Keep the note under 500 characters.",
  leave_overlaps: "You already have time off asked for or approved then.",
  leave_not_found: "That request is gone.",
  not_allowed: "Only their manager or the manager's delegate can decide this.",
  not_pending: "This request was already decided or cancelled.",
  cannot_cancel:
    "Only a pending request, or an approved one that hasn't started, can be cancelled.",
};

/** A message for a database error code, else the code itself. */
export function explain(code: string): string {
  return errors[code] ?? code;
}

export function requestProblem(f: {
  typeId: string;
  partDay: boolean;
  firstDay: string;
  lastDay: string;
  start: string;
  end: string;
}): string | null {
  if (!f.typeId) return "Choose a type of leave.";
  if (!f.firstDay) return "Choose a date.";
  if (f.partDay) {
    if (!f.start || !f.end) return "Choose a start and an end time.";
    if (f.end <= f.start) return "The end time is after the start time.";
    return null;
  }
  if (!f.lastDay) return "Choose the last day.";
  if (f.lastDay < f.firstDay) return "The last day is on or after the first day.";
  return null;
}
