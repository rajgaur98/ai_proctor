// The team calendar (#304, LV-06): who is off on each day of this week and next, from the
// approved requests the viewer may see and the holiday calendar. Request dates are each
// person's own local days, as they asked.
import { DateTime } from "luxon";
import type { Holiday, LeaveRequest } from "./timeOffData";

export interface DayOff {
  day: string;
  people: { name: string; typeName: string; partDay: boolean }[];
  holidays: Holiday[];
}

/** The 14 ISO dates from the Monday of `today`'s week. */
export function twoWeeks(today: string): string[] {
  const monday = DateTime.fromISO(today).startOf("week");
  return Array.from({ length: 14 }, (_, i) => monday.plus({ days: i }).toISODate() ?? "");
}

export function offByDay(days: string[], requests: LeaveRequest[], holidays: Holiday[]): DayOff[] {
  const approved = requests.filter((r) => r.status === "approved");
  return days.map((day) => ({
    day,
    people: approved
      .filter((r) => r.firstDay <= day && day <= r.lastDay)
      .map((r) => ({ name: r.employeeName, typeName: r.typeName, partDay: r.kind === "part_day" }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    holidays: holidays.filter((h) => h.day === day),
  }));
}
