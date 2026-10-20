// Pure helpers for the My data page (#49, EMP-02/03, ACT-05): the day bar from time
// segments, who viewed which check-in, and wording. Tested without a browser.
import type { SegmentType } from "@ai-proctor/core";
import { DateTime } from "luxon";
import type { Span, DaySegment as TimelineSegment } from "../day/timeline";

export interface DaySegment {
  type: SegmentType;
  start: string;
  end: string;
  counted: boolean;
  excluded: boolean;
}

export interface PlacedSegment extends DaySegment {
  /** Position on the bar, 0–100. */
  left: number;
  width: number;
}

const hatch = (c: string) =>
  `repeating-linear-gradient(135deg, ${c} 0 4px, color-mix(in oklch, ${c} 35%, var(--panel)) 4px 8px)`;

/**
 * How each segment type looks (NFR-UX-01: colour plus a label, and a hatch on the
 * flagged kinds). Flagged time is only highlighted, never deducted (TS-02).
 */
export const segmentStyle: Record<SegmentType, { label: string; background: string }> = {
  verified: { label: "Verified", background: "var(--sactive)" },
  meeting: { label: "Meeting", background: "var(--smeeting)" },
  idle: { label: "Idle (flagged)", background: hatch("var(--sidle)") },
  unverified: { label: "Unverified (flagged)", background: hatch("var(--saway)") },
  away: { label: "Away (flagged)", background: hatch("var(--slocked)") },
  offline: { label: "Offline (flagged)", background: hatch("var(--soffline)") },
  pause: { label: "Pause", background: "var(--spaused)" },
  pause_over_cap: { label: "Pause over the limit (flagged)", background: hatch("var(--spaused)") },
  break: { label: "Break", background: "var(--sbreak)" },
  manual: { label: "Manual entry", background: "var(--acc)" },
};

/** Legend order: worked kinds first, then the flagged ones, then time off the clock. */
const legendOrder: SegmentType[] = [
  "verified",
  "meeting",
  "manual",
  "idle",
  "unverified",
  "away",
  "offline",
  "pause_over_cap",
  "pause",
  "break",
];

/** Segments clipped to the span, positioned on the bar. */
export function placeSegments(span: Span, segs: DaySegment[]): PlacedSegment[] {
  const width = span.end - span.start;
  return segs
    .map((s) => ({
      s,
      start: Math.max(Date.parse(s.start), span.start),
      end: Math.min(Date.parse(s.end), span.end),
    }))
    .filter((c) => c.end > c.start)
    .map((c) => ({
      ...c.s,
      left: ((c.start - span.start) / width) * 100,
      width: ((c.end - c.start) / width) * 100,
    }));
}

/** The time segments as the day page's bar sizes itself from them (barSpan() reads their times). */
export function asTimelineSegments(segs: DaySegment[]): TimelineSegment[] {
  return segs.map((s) => ({
    type: s.type,
    start: Date.parse(s.start),
    end: Date.parse(s.end),
    flagged: false,
    excluded: s.excluded,
    counted: s.counted,
  }));
}

/** Seconds per type within the span, in legend order; types with no time are left out. */
export function typeTotals(
  span: Span,
  segs: DaySegment[],
): { type: SegmentType; seconds: number }[] {
  const by = new Map<SegmentType, number>();
  for (const p of placeSegments(span, segs)) {
    const start = Math.max(Date.parse(p.start), span.start);
    const end = Math.min(Date.parse(p.end), span.end);
    by.set(p.type, (by.get(p.type) ?? 0) + (end - start) / 1000);
  }
  return legendOrder
    .filter((type) => (by.get(type) ?? 0) > 0)
    .map((type) => ({ type, seconds: by.get(type) ?? 0 }));
}

/** Worked seconds: counted and not excluded by a manager (TS-01, TS-02), from raw times. */
export function workedSeconds(segs: DaySegment[]): number {
  return segs
    .filter((s) => s.counted && !s.excluded)
    .reduce((sum, s) => sum + (Date.parse(s.end) - Date.parse(s.start)) / 1000, 0);
}

/** "5 h 03 min", "45 min": rounded to the minute for display only. */
export function minutesText(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`
    : `${minutes} min`;
}

// CHK-23 quick picks; the same set the tray offers (#37).
export const missReasons = [
  { kind: "meeting", label: "Meeting" },
  { kind: "phone_call", label: "Phone call" },
  { kind: "break", label: "Break" },
  { kind: "away", label: "Away from desk" },
  { kind: "other", label: "Other" },
] as const;

export type MissReasonKind = (typeof missReasons)[number]["kind"];

export function missReasonLabel(kind: string | null): string | null {
  return missReasons.find((r) => r.kind === kind)?.label ?? kind;
}

export interface CaptureView {
  viewedAt: string;
  viewerId: string | null;
  viewerName: string | null;
  viewerRole: string | null;
  checkinId: string | null;
  checkinAt: string | null;
}

/** "Sarah Lee (manager)"; a person who has since left the workspace has no name. */
export function viewerLabel(v: Pick<CaptureView, "viewerName" | "viewerRole">): string {
  if (!v.viewerName) return "Someone who has left the workspace";
  const role = v.viewerRole === "owner" ? "admin" : v.viewerRole;
  return role ? `${v.viewerName} (${role})` : v.viewerName;
}

/** The newest views of one check-in, as "Viewed by Sarah Lee · 15:09" (or "Not viewed"). */
export function viewedBy(
  views: CaptureView[],
  checkinId: string,
  zone: string,
  now: number,
): string {
  const mine = views
    .filter((v) => v.checkinId === checkinId)
    .sort((a, b) => Date.parse(b.viewedAt) - Date.parse(a.viewedAt));
  const latest = mine[0];
  if (!latest) return "Not viewed";
  const who = new Set(mine.map((v) => v.viewerId ?? v.viewerName));
  const name = latest.viewerName ?? "Someone who has left";
  const more = who.size > 1 ? ` and ${who.size - 1} other${who.size > 2 ? "s" : ""}` : "";
  return `Viewed by ${name}${more} · ${whenLabel(latest.viewedAt, zone, now)}`;
}

/** "15:10" today, "Fri 3 Oct 17:45" on other days, in `zone`. */
export function whenLabel(iso: string, zone: string, now: number): string {
  const t = DateTime.fromISO(iso, { zone });
  const today = DateTime.fromMillis(now, { zone });
  return t.hasSame(today, "day") ? `today ${t.toFormat("HH:mm")}` : t.toFormat("ccc d LLL HH:mm");
}

/** Views from the last `days` days, newest first. */
export function recentViews(views: CaptureView[], days: number, now: number): CaptureView[] {
  const from = now - days * 86_400_000;
  return views
    .filter((v) => Date.parse(v.viewedAt) >= from)
    .sort((a, b) => Date.parse(b.viewedAt) - Date.parse(a.viewedAt));
}

export interface Files {
  screens: number;
  webcam: boolean;
}

/** What a passed check-in captured, from its recorded file names. */
export function filesOf(objectKeys: string[]): Files {
  return {
    screens: objectKeys.filter((k) => /^screen-\d+\.webp$/.test(k)).length,
    webcam: objectKeys.includes("webcam.webp"),
  };
}

/** Whether a check-in's images are past the org's retention (they are deleted by then). */
export function imagesExpired(scheduledAt: string, retentionDays: number, now: number): boolean {
  return Date.parse(scheduledAt) < now - retentionDays * 86_400_000;
}

export interface AppSample {
  appName: string;
  domain: string | null;
  seconds: number;
}

/** The app that had the most seconds in a minute, as "Chrome · jira.example.com". */
export function appLabel(samples: AppSample[]): string | null {
  const top = [...samples].sort((a, b) => b.seconds - a.seconds)[0];
  if (!top) return null;
  return top.domain ? `${top.appName} · ${top.domain}` : top.appName;
}

/** The start of the minute a check-in was answered in (UTC ISO), as activity samples use. */
export function sampleMinute(respondedAt: string | null, scheduledAt: string): string {
  const t = Date.parse(respondedAt ?? scheduledAt);
  return new Date(Math.floor(t / 60_000) * 60_000).toISOString();
}
