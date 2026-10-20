// The five numbers above a day's timeline (#124, DSH-03): verified, flagged, pause,
// break and check-ins. They come from the same time_segments rows the bar draws, and
// the flagged and break totals go through summary.ts, so they match the timesheet.
// Seconds stay raw; only the text rounds (TS-05/06).
import type { SegmentType } from "@ai-proctor/core";
import { formatDuration, summarizeWeek } from "../timesheets/summary";
import type { DaySegment, Outcome } from "./timeline";

export interface StatCard {
  key: "verified" | "flagged" | "pause" | "break" | "checkins";
  label: string;
  value: string;
  note: string;
}

/** What each flagged type is called in the Flagged note. */
const flaggedName: Partial<Record<SegmentType, string>> = {
  idle: "idle",
  unverified: "unverified",
  away: "away",
  offline: "offline",
  pause_over_cap: "pause over cap",
};
const flaggedOrder: SegmentType[] = ["idle", "unverified", "away", "offline", "pause_over_cap"];

const seconds = (s: DaySegment) => (s.end - s.start) / 1000;

function sum(segs: DaySegment[], pick: (s: DaySegment) => boolean): number {
  return segs.filter(pick).reduce((total, s) => total + seconds(s), 0);
}

/** Separate runs of back-to-back segments of the given types (a split pause is one pause). */
function runs(segs: DaySegment[], types: SegmentType[]): DaySegment[] {
  const out: DaySegment[] = [];
  for (const s of [...segs].sort((a, b) => a.start - b.start)) {
    if (!types.includes(s.type)) continue;
    const last = out[out.length - 1];
    if (last && last.end === s.start) out[out.length - 1] = { ...last, end: s.end };
    else out.push({ ...s });
  }
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `time` formats a UTC millisecond instant as "HH:mm" in the viewer's zone. */
export function statCards(
  segs: DaySegment[],
  checkins: { outcome: Outcome }[],
  time: (ms: number) => string,
): StatCard[] {
  const day = summarizeWeek(
    segs.map((s) => ({
      day: "day",
      type: s.type,
      projectId: null,
      counted: s.counted,
      flagged: s.flagged,
      excluded: s.excluded,
      seconds: seconds(s),
    })),
    ["day"],
  ).days[0];
  const flaggedS = day?.flagged ?? 0;
  const breakS = day?.breakTime ?? 0;
  const excludedS = day?.excluded ?? 0;

  const verified = (s: DaySegment) =>
    (s.type === "verified" || s.type === "meeting") && !s.excluded;
  const verifiedS = sum(segs, verified);
  const meetingS = sum(segs, (s) => s.type === "meeting");

  const flaggedParts = flaggedOrder
    .map((type) => ({
      type,
      s: sum(segs, (x) => x.type === type && x.flagged && !x.excluded),
    }))
    .filter((p) => p.s > 0)
    .map((p) => `${flaggedName[p.type]} ${formatDuration(p.s)}`);
  if (excludedS > 0) flaggedParts.push(`${formatDuration(excludedS)} excluded`);

  const pauses = runs(segs, ["pause", "pause_over_cap"]);
  const pauseS = sum(segs, (s) => s.type === "pause" || s.type === "pause_over_cap");
  const overCapS = sum(segs, (s) => s.type === "pause_over_cap");
  const pauseNote = [
    plural(pauses.length, "pause", "pauses"),
    ...(overCapS > 0 ? [`${formatDuration(overCapS)} over the cap, flagged`] : []),
  ].join(" · ");

  const breaks = runs(segs, ["break"]);

  const count = (o: Outcome) => checkins.filter((c) => c.outcome === o).length;
  const passed = count("pass");
  const missed = count("miss");
  const failed = count("failed");
  const deferred = count("deferred");
  const shown = passed + missed + failed;
  const checkinNote = [
    ...(missed > 0 ? [`${missed} missed`] : []),
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(deferred > 0 ? [`${deferred} deferred`] : []),
  ];

  return [
    {
      key: "verified",
      label: "Verified",
      value: formatDuration(verifiedS),
      note: meetingS > 0 ? `incl. ${formatDuration(meetingS)} in meetings` : "no meetings",
    },
    {
      key: "flagged",
      label: "Flagged",
      value: formatDuration(flaggedS),
      note: flaggedParts.length > 0 ? flaggedParts.join(" · ") : "nothing flagged",
    },
    { key: "pause", label: "Pause", value: formatDuration(pauseS), note: pauseNote },
    {
      key: "break",
      label: "Break",
      value: formatDuration(breakS),
      note:
        breaks.length > 0
          ? breaks.map((b) => `${time(b.start)}–${time(b.end)}`).join(", ")
          : "no break",
    },
    {
      key: "checkins",
      label: "Check-ins",
      value: `${passed} of ${shown}`,
      note:
        checkinNote.length > 0
          ? checkinNote.join(" · ")
          : shown > 0
            ? "all passed"
            : "none shown yet",
    },
  ];
}
