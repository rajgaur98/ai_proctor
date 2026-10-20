// Layout for one employee's day (#33, DSH-03/05): which span the bar covers, the
// coloured status segments on it, and where check-in markers sit. Pure, so it's
// tested without a browser.

import type { Enums } from "@ai-proctor/contracts";
import { type ShiftRule, windowsBetween } from "@ai-proctor/core";
import { DateTime } from "luxon";

export type Status = Enums<"presence_status">;
export type Outcome = Enums<"checkin_outcome">;
export type TamperReason = Enums<"tamper_reason">;

/** Why a due check-in was held back (CHK-03); the database stores it as text. */
export const deferralLabel: Record<string, string> = {
  call: "On a call",
  screen_share: "Screen shared",
  presenting: "Presenting",
};

export interface Period {
  status: Status;
  /** Only on a Tamper period. */
  reason?: TamperReason | null;
  start: string;
  end: string | null;
}

export interface Checkin {
  id: string;
  scheduledAt: string;
  shownAt: string | null;
  outcome: Outcome;
  /** Only on a deferred check-in. */
  deferralReason: string | null;
}

export interface Span {
  start: number;
  end: number;
}

export interface Segment {
  status: Status;
  reason: TamperReason | null;
  start: number;
  end: number;
  /** Position on the bar, 0–100. */
  left: number;
  width: number;
}

/** The employee's local day as UTC milliseconds. */
export function localDay(isoDate: string, zone: string): Span {
  const day = DateTime.fromISO(isoDate, { zone }).startOf("day");
  return { start: day.toMillis(), end: day.plus({ days: 1 }).toMillis() };
}

/**
 * The bar's span: the shifts that start or run on this day, widened to cover any
 * activity or check-in; without either, 09:00–17:00 local. Rounded out to the hour.
 */
export function barSpan(
  day: Span,
  zone: string,
  shifts: ShiftRule[],
  periods: Period[],
  checkins: Checkin[],
  now: number,
): Span {
  const times: number[] = [];
  for (const w of windowsBetween(shifts, new Date(day.start), new Date(day.end))) {
    times.push(w.start.getTime(), w.end.getTime());
  }
  for (const p of periods) {
    if (p.status === "off_shift") continue;
    times.push(Date.parse(p.start), p.end ? Date.parse(p.end) : Math.min(now, day.end));
  }
  for (const c of checkins) times.push(Date.parse(c.scheduledAt));
  const inDay = times.map((t) => Math.min(Math.max(t, day.start), day.end));
  if (inDay.length === 0) {
    const d = DateTime.fromMillis(day.start, { zone });
    return { start: d.set({ hour: 9 }).toMillis(), end: d.set({ hour: 17 }).toMillis() };
  }
  const hour = 3_600_000;
  const start = Math.max(day.start, Math.floor(Math.min(...inDay) / hour) * hour);
  const end = Math.min(day.end, Math.ceil(Math.max(...inDay) / hour) * hour);
  return end > start ? { start, end } : { start, end: start + hour };
}

/** Status periods clipped to the span; open periods run to `now`. Off shift is left blank. */
export function segments(span: Span, periods: Period[], now: number): Segment[] {
  const width = span.end - span.start;
  return periods
    .filter((p) => p.status !== "off_shift")
    .map((p) => {
      const start = Math.max(Date.parse(p.start), span.start);
      const end = Math.min(p.end ? Date.parse(p.end) : now, span.end);
      return { status: p.status, reason: p.reason ?? null, start, end };
    })
    .filter((s) => s.end > s.start)
    .map((s) => ({
      ...s,
      left: ((s.start - span.start) / width) * 100,
      width: ((s.end - s.start) / width) * 100,
    }));
}

/** Where a check-in sits on the bar (0–100), or null outside it. A deferred one has
 * no shown time, so it sits at the time it was due. */
export function markerLeft(span: Span, c: Checkin): number | null {
  const t = Date.parse(c.shownAt ?? c.scheduledAt);
  if (t < span.start || t > span.end) return null;
  return ((t - span.start) / (span.end - span.start)) * 100;
}

/** Minutes per status within the span, largest first. Tamper is split by reason. */
export function totals(
  segs: Segment[],
): { status: Status; reason: TamperReason | null; minutes: number }[] {
  const by = new Map<string, { status: Status; reason: TamperReason | null; ms: number }>();
  for (const s of segs) {
    const key = `${s.status}:${s.reason ?? ""}`;
    const t = by.get(key) ?? { status: s.status, reason: s.reason, ms: 0 };
    t.ms += s.end - s.start;
    by.set(key, t);
  }
  return [...by.values()]
    .map(({ status, reason, ms }) => ({ status, reason, minutes: Math.round(ms / 60_000) }))
    .sort((a, b) => b.minutes - a.minutes);
}

/** Hour ticks across the span, in `zone`. */
export function ticks(span: Span, zone: string): { left: number; label: string }[] {
  const out: { left: number; label: string }[] = [];
  const hours = (span.end - span.start) / 3_600_000;
  const step = hours > 12 ? 3 : hours > 6 ? 2 : 1;
  let t = DateTime.fromMillis(span.start, { zone }).startOf("hour");
  while (t.toMillis() <= span.end) {
    if (t.toMillis() >= span.start && t.hour % step === 0) {
      out.push({
        left: ((t.toMillis() - span.start) / (span.end - span.start)) * 100,
        label: t.toFormat("HH:mm"),
      });
    }
    t = t.plus({ hours: 1 });
  }
  return out;
}
