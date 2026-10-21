// Layout for one employee's day (#33, #124, DSH-03/05): which span the bar covers,
// the time_segments on it (by type, flagged ones hatched, Tamper time with its
// reason), and where check-in markers sit. Pure, so it's tested without a browser.

import type { Enums } from "@ai-proctor/contracts";
import { type SegmentType, type ShiftRule, windowsBetween } from "@ai-proctor/core";
import { DateTime } from "luxon";

export type Outcome = Enums<"checkin_outcome">;
export type TamperReason = Enums<"tamper_reason">;

/** Why a due check-in was held back (CHK-03); the database stores it as text. */
export const deferralLabel: Record<string, string> = {
  call: "On a call",
  screen_share: "Screen shared",
  presenting: "Presenting",
};

/** One time_segments row (#41), in UTC milliseconds. */
export interface DaySegment {
  type: SegmentType;
  start: number;
  end: number;
  /** Highlighted for the manager (idle, unverified, away, offline, over the pause cap). */
  flagged: boolean;
  /** A manager excluded this flagged time (TS-10). */
  excluded: boolean;
  /** Counted as worked time (TS-01). */
  counted: boolean;
  /** On unverified time the server had as Tamper: why (#160). Needs review, never a penalty (ANT-08). */
  tamper?: TamperReason;
}

/** A Tamper status period (#160) in UTC milliseconds; `end` is null while it lasts. */
export interface TamperPeriod {
  reason: TamperReason;
  start: number;
  end: number | null;
}

export interface Checkin {
  id: string;
  scheduledAt: string;
  shownAt: string | null;
  outcome: Outcome;
  /** Only on a deferred check-in. */
  deferralReason: string | null;
  /** CAP-07: whether the pass's webcam frame showed a face; null or missing when not checked. */
  facePresent?: boolean | null;
}

export interface Span {
  start: number;
  end: number;
}

export interface BarSegment extends DaySegment {
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
 * segment or check-in; without either, 09:00–17:00 local. Rounded out to the hour.
 */
export function barSpan(
  day: Span,
  zone: string,
  shifts: ShiftRule[],
  segs: DaySegment[],
  checkins: Checkin[],
): Span {
  const times: number[] = [];
  for (const w of windowsBetween(shifts, new Date(day.start), new Date(day.end))) {
    times.push(w.start.getTime(), w.end.getTime());
  }
  for (const s of segs) times.push(s.start, s.end);
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

/** Segments clipped to the span, with their place on the bar. Unclocked time is left blank. */
export function barSegments(span: Span, segs: DaySegment[]): BarSegment[] {
  const width = span.end - span.start;
  return segs
    .map((s) => ({ ...s, start: Math.max(s.start, span.start), end: Math.min(s.end, span.end) }))
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

/**
 * time_segments don't say why time is unverified, so unverified segments are split
 * where the server had the person in Tamper, and those pieces carry the reason (#160).
 * Other types win over Tamper on the timesheet (a break stays a break) and are kept.
 */
export function withTamperReasons(segs: DaySegment[], periods: TamperPeriod[]): DaySegment[] {
  const out: DaySegment[] = [];
  for (const s of segs) {
    if (s.type !== "unverified") {
      out.push(s);
      continue;
    }
    let at = s.start;
    const overlaps = periods
      .map((p) => ({
        ...p,
        start: Math.max(p.start, s.start),
        end: Math.min(p.end ?? s.end, s.end),
      }))
      .filter((p) => p.end > p.start)
      .sort((a, b) => a.start - b.start);
    for (const p of overlaps) {
      const start = Math.max(p.start, at);
      if (p.end <= start) continue;
      if (start > at) out.push({ ...s, start: at, end: start });
      out.push({ ...s, start, end: p.end, tamper: p.reason });
      at = p.end;
    }
    if (at < s.end) out.push({ ...s, start: at });
  }
  return out;
}

/** Seconds of Tamper time per reason, largest first. */
export function tamperTotals(segs: DaySegment[]): { reason: TamperReason; seconds: number }[] {
  const by = new Map<TamperReason, number>();
  for (const s of segs) {
    if (s.tamper) by.set(s.tamper, (by.get(s.tamper) ?? 0) + (s.end - s.start) / 1000);
  }
  return [...by.entries()]
    .map(([reason, seconds]) => ({ reason, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
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
        // The day's end is midnight again; "00:00" twice on a full-day bar would confuse.
        label: t.hour === 0 && t.toMillis() > span.start ? "24:00" : t.toFormat("HH:mm"),
      });
    }
    t = t.plus({ hours: 1 });
  }
  return out;
}

/** "Shift 09:00–18:00 (IST)" for the shifts that start on this day, or "No shift". */
export function shiftText(shifts: ShiftRule[], isoDate: string, zone: string): string {
  const day = DateTime.fromISO(isoDate, { zone });
  const today = shifts.filter((s) => s.days.includes(day.weekday));
  if (today.length === 0) return "No shift";
  const times = today.map((s) => `${s.start}–${s.end}`).join(", ");
  return `${today.length === 1 ? "Shift" : "Shifts"} ${times} (${day.toFormat("ZZZZ")})`;
}

/** Seconds per segment type across the segments, largest first. */
export function typeTotals(segs: DaySegment[]): { type: SegmentType; seconds: number }[] {
  const by = new Map<SegmentType, number>();
  for (const s of segs) by.set(s.type, (by.get(s.type) ?? 0) + (s.end - s.start) / 1000);
  return [...by.entries()]
    .map(([type, seconds]) => ({ type, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}
