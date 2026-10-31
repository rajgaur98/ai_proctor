// The day view's exports (#255 part 2, TS-27/28): its check-ins, its time segments and
// its top apps, one table each, as the page shows them. Captures go out as metadata only
// (which parts were taken, which the employee removed, #253), never images or links.
// Pure, so the columns are unit-tested.
import type { CellValue } from "@ai-proctor/core";
import { type ExportTable, exportHours, exportTime, yesNo } from "../../lib/exportFile";
import type { TopApp } from "./appsData";
import { deferralText, missReason, noFace, outcomeWord } from "./checkinText";
import type { CheckinRow } from "./dayData";
import { type PART_ORDER, type RemovedParts, removedParts } from "./removedText";
import type { Outcome } from "./timeline";

const partWord: Record<(typeof PART_ORDER)[number], string> = {
  webcam: "Webcam",
  screen: "Screen",
  apps: "Apps",
  domains: "Browser domains",
};

/** Seconds, to a tenth, from milliseconds (as the Reports export). */
const tenthsOfSecond = (ms: number | null): number | null =>
  ms === null ? null : Math.round(ms / 100) / 10;

export const CAPTURE_HEADER = ["Screenshots", "Webcam frame", "Removed parts", "Removed at"];

/**
 * A check-in's captures as metadata: the screenshots still kept, the webcam frame
 * ("Yes", "No", or "Removed"), which parts the employee removed and when they last did.
 * Only a passed check-in has captures.
 */
export function captureCells(
  c: { outcome: Outcome; objectKeys: string[]; removed: RemovedParts },
  zone: string,
): CellValue[] {
  const screens = c.objectKeys.filter((k) => /^screen-\d+\.webp$/.test(k)).length;
  const webcam = c.objectKeys.includes("webcam.webp");
  const parts = removedParts(c.removed);
  const latest = parts
    .map((p) => c.removed[p] as string)
    .sort()
    .at(-1);
  return [
    c.outcome === "pass" && c.removed.screen === null ? screens : 0,
    !webcam || c.outcome !== "pass" ? "No" : c.removed.webcam !== null ? "Removed" : "Yes",
    parts.map((p) => partWord[p]).join(", "),
    exportTime(latest ?? null, zone),
  ];
}

/** Why a check-in wasn't answered: a deferral's reason, a miss's reason (the quick pick). */
function reasonOf(c: CheckinRow): string {
  if (c.outcome === "deferred") return deferralText(c.deferralReason);
  if (c.outcome === "miss") return missReason(c.missedReasonKind, c.missedReason).kind ?? "";
  return "";
}

export const CHECKIN_HEADER = [
  "Time",
  "Outcome",
  "Response (s)",
  "Reason",
  "Remark",
  "Project",
  ...CAPTURE_HEADER,
  "No face detected",
  "Needs review",
];

/**
 * The day's check-ins in time order: when it was shown (or due, for a deferral), the
 * result, the answer time, the employee's reason and remark for a miss, the project and
 * the captures as metadata. `needsReview` is the page's unreviewed anti-cheat flags.
 */
export function checkinsTable(
  checkins: readonly CheckinRow[],
  projectName: (id: string | null) => string,
  needsReview: (id: string) => boolean,
  zone: string,
): ExportTable {
  return {
    sheet: "Check-ins",
    header: CHECKIN_HEADER,
    rows: checkins.map((c) => [
      exportTime(c.shownAt ?? c.scheduledAt, zone),
      outcomeWord[c.outcome],
      c.outcome === "pass" || c.outcome === "failed" ? tenthsOfSecond(c.responseMs) : null,
      reasonOf(c),
      c.outcome === "miss" ? (missReason(c.missedReasonKind, c.missedReason).note ?? "") : "",
      projectName(c.projectId),
      ...captureCells(c, zone),
      yesNo(noFace(c)),
      yesNo(needsReview(c.id)),
    ]),
  };
}

/** A stored segment as the day view's export reads it (UTC milliseconds). */
export interface SegmentRow {
  type: string;
  start: number;
  end: number;
  projectId: string | null;
  taskId: string | null;
  counted: boolean;
  flagged: boolean;
  excluded: boolean;
}

export const SEGMENT_HEADER = [
  "Start",
  "End",
  "Type",
  "Project",
  "Task",
  "Hours",
  "Seconds",
  "Counted",
  "Flagged",
  "Excluded",
];

/** The day's time segments in order; seconds are raw, hours are decimals from them. */
export function segmentsTable(
  segments: readonly SegmentRow[],
  typeLabel: (type: string) => string,
  projectName: (id: string | null) => string,
  taskName: (id: string | null) => string,
  zone: string,
): ExportTable {
  return {
    sheet: "Segments",
    header: SEGMENT_HEADER,
    rows: segments.map((s) => {
      const seconds = Math.round((s.end - s.start) / 1000);
      return [
        exportTime(new Date(s.start).toISOString(), zone),
        exportTime(new Date(s.end).toISOString(), zone),
        typeLabel(s.type),
        projectName(s.projectId),
        s.taskId ? taskName(s.taskId) : "",
        exportHours(seconds),
        seconds,
        yesNo(s.counted),
        yesNo(s.flagged),
        yesNo(s.excluded),
      ];
    }),
  };
}

export const APPS_HEADER = ["App", "Hours", "Seconds"];

/** The top apps as the page lists them, longest first: time only, no score. */
export function appsTable(apps: readonly TopApp[]): ExportTable {
  return {
    sheet: "Apps",
    header: APPS_HEADER,
    rows: apps.map((a) => [a.appName, exportHours(a.seconds), a.seconds]),
  };
}
