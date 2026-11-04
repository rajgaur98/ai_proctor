// Leave on the timesheet (#319, LV-05): per local day, the seconds the database counts for
// approved leave and holidays (timesheet_leave: paid leave and holidays the shift's hours or
// the part-day span, unpaid leave 0) and what the leave is. It is shown on its own Leave row
// and in its own totals, never added to worked time or to overtime (TS-19). Pure, so it is
// unit-tested without the Supabase client.
import { type LeaveItem, leaveWhat } from "@ai-proctor/core";

export interface DayLeave {
  day: string;
  seconds: number;
  items: LeaveItem[];
}

/** One person's leave by day. */
export function leaveByDay(rows: readonly DayLeave[]): Map<string, DayLeave> {
  return new Map(rows.map((r) => [r.day, r]));
}

/** The leave seconds of `days` (the week's), from raw seconds (TS-06). */
export function leaveTotal(byDay: ReadonlyMap<string, DayLeave>, days: readonly string[]): number {
  return days.reduce((sum, d) => sum + (byDay.get(d)?.seconds ?? 0), 0);
}

/** Leave seconds per person, added up from their days. */
export function leaveByUser(
  rows: readonly { userId: string; seconds: number }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.userId, (out.get(r.userId) ?? 0) + r.seconds);
  return out;
}

/** What a day's leave is ("Vacation", "Thanksgiving (holiday)"); "Leave" when unnamed. */
export function leaveLabel(l: DayLeave): string {
  return leaveWhat(l.items) || "Leave";
}

/** Whether `items` is only unpaid leave: shown with 0 hours. */
export function onlyUnpaid(l: DayLeave): boolean {
  return l.items.length > 0 && l.items.every((i) => !i.paid);
}

/** The items as the database sends them (jsonb), kept to the fields we read. */
export function toLeaveItems(json: unknown): LeaveItem[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((i) =>
    i && typeof i === "object" && typeof (i as { name?: unknown }).name === "string"
      ? [
          {
            name: (i as { name: string }).name,
            paid: (i as { paid?: unknown }).paid !== false,
            holiday: (i as { holiday?: unknown }).holiday === true,
            part_day: (i as { part_day?: unknown }).part_day === true,
          },
        ]
      : [],
  );
}
