// The missed check-ins of a week next to its flagged time (#252, CHK-23): the manager sees
// the employee's quick pick and remark where they decide on the unverified time a miss
// started. Pure, so the matching is tested without a browser.
import type { FlaggedSegment } from "./timesheetData";

export interface WeekMiss {
  id: string;
  /** When the card was shown (or was due): where the unverified time starts. */
  at: string;
  kind: string | null;
  remark: string | null;
}

/**
 * Each miss goes to the flagged segment holding its time ([start, end)); a miss that
 * starts no flagged segment of the list (none rebuilt yet, or clocked out at once) is
 * returned in `other`, so every miss still shows.
 */
export function missesBySegment(
  segments: FlaggedSegment[],
  misses: WeekMiss[],
): { bySegment: Map<string, WeekMiss[]>; other: WeekMiss[] } {
  const bySegment = new Map<string, WeekMiss[]>();
  const other: WeekMiss[] = [];
  for (const m of [...misses].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const t = Date.parse(m.at);
    const s = segments.find((x) => Date.parse(x.startAt) <= t && t < Date.parse(x.endAt));
    if (s) bySegment.set(s.id, [...(bySegment.get(s.id) ?? []), m]);
    else other.push(m);
  }
  return { bySegment, other };
}
