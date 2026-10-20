// The date ranges a report offers (DSH-07): this week, last week and this month, in
// the viewer's own calendar. A week is the org's week (policy.week_start) so a report
// for a week covers the same seven days as the timesheet for it (TS-05/06); ranges
// run to the end of the period, not just to today.
import { DateTime } from "luxon";
import { weekDays, weekStartOf } from "../timesheets/weeks";

export type RangePreset = "this-week" | "last-week" | "this-month";

export const presetLabel: Record<RangePreset, string> = {
  "this-week": "This week",
  "last-week": "Last week",
  "this-month": "This month",
};

export const presets: RangePreset[] = ["this-week", "last-week", "this-month"];

export interface DateRange {
  from: string;
  to: string;
}

/** The range of a preset, given today's date (YYYY-MM-DD) and the org's week-start day. */
export function presetRange(preset: RangePreset, today: string, startDay: number): DateRange {
  const day = DateTime.fromISO(today, { zone: "utc" });
  switch (preset) {
    case "this-week":
    case "last-week": {
      const thisWeek = weekStartOf(today, startDay);
      const first =
        preset === "this-week" ? thisWeek : weekStartOf(addDays(thisWeek, -1), startDay);
      return { from: first, to: weekDays(first)[6] ?? first };
    }
    case "this-month":
      return {
        from: day.startOf("month").toISODate() ?? today,
        to: day.endOf("month").toISODate() ?? today,
      };
  }
}

function addDays(isoDate: string, days: number): string {
  return DateTime.fromISO(isoDate, { zone: "utc" }).plus({ days }).toISODate() ?? isoDate;
}

/** The preset a range is exactly, if any (so the buttons can show which one is on). */
export function presetOf(range: DateRange, today: string, startDay: number): RangePreset | null {
  return (
    presets.find((p) => {
      const r = presetRange(p, today, startDay);
      return r.from === range.from && r.to === range.to;
    }) ?? null
  );
}

/** Why a range can't be reported on, or null; the same limits as `report_rows`. */
export function rangeProblem({ from, to }: DateRange): string | null {
  const a = DateTime.fromISO(from, { zone: "utc" });
  const b = DateTime.fromISO(to, { zone: "utc" });
  if (!a.isValid || !b.isValid || b < a) {
    return "Choose a start date and an end date that is the same or later.";
  }
  if (b.diff(a, "days").days > 365) return "The range can be up to a year.";
  return null;
}
