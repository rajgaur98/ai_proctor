// The top panel of a day (#124, DSH-03, from the Claude Design DayView screen): the
// five totals, the bar of time_segments by type (flagged ones hatched) with hour ticks,
// check-in markers under it and the selected check-in's line, and the legend. Tamper
// time says why (#160): needs review, never a penalty (ANT-08).
import type { SegmentType } from "@ai-proctor/core";
import { DateTime } from "luxon";
import type { CSSProperties } from "react";
import { tamperLabel } from "../../components/StatusChip";
import { formatDuration } from "../timesheets/summary";
import { markerLabel } from "./checkinText";
import type { StatCard } from "./dayStats";
import {
  type BarSegment,
  type Checkin,
  markerLeft,
  type Outcome,
  type Span,
  tamperTotals,
  typeTotals,
} from "./timeline";

interface SegmentStyle {
  label: string;
  color: string;
}

export const segmentStyle: Record<SegmentType, SegmentStyle> = {
  verified: { label: "Verified", color: "var(--sactive)" },
  meeting: { label: "Meeting", color: "var(--smeeting)" },
  idle: { label: "Idle (flagged)", color: "var(--sidle)" },
  unverified: { label: "Unverified (flagged)", color: "var(--saway)" },
  away: { label: "Away, locked (flagged)", color: "var(--slocked)" },
  offline: { label: "Offline (flagged)", color: "var(--soffline)" },
  pause: { label: "Pause", color: "var(--spaused)" },
  pause_over_cap: { label: "Pause over the cap (flagged)", color: "var(--spaused)" },
  break: { label: "Break", color: "var(--sbreak)" },
  manual: { label: "Manual entry", color: "var(--acc)" },
};

/** The legend always lists the design's six; the rest only when the day has them. */
const legendTypes: SegmentType[] = ["verified", "meeting", "idle", "unverified", "pause", "break"];
const extraTypes: SegmentType[] = ["away", "offline", "pause_over_cap", "manual"];

const markerLegend: [Outcome, string][] = [
  ["pass", "Check-in passed"],
  ["miss", "Missed"],
  ["failed", "Failed"],
  ["deferred", "Deferred"],
];

const hatch = (c: string) =>
  `repeating-linear-gradient(135deg, ${c} 0 4px, color-mix(in oklch, ${c} 35%, var(--panel)) 4px 8px)`;

/** Flagged time is hatched, so it doesn't rely on colour alone (NFR-UX-01). */
function background(type: SegmentType, flagged: boolean): string {
  const { color } = segmentStyle[type];
  return flagged ? hatch(color) : color;
}

const flaggedByDefault = new Set<SegmentType>([
  "idle",
  "unverified",
  "away",
  "offline",
  "pause_over_cap",
]);

export function Marker({ outcome, size = 10 }: { outcome: Outcome; size?: number }) {
  const base: CSSProperties = { flex: "none", display: "block" };
  if (outcome === "pass") {
    return (
      <span
        aria-hidden
        style={{
          ...base,
          width: size,
          height: size,
          borderRadius: "50%",
          background: "var(--sactive)",
          boxShadow: "0 0 0 2px var(--panel)",
        }}
      />
    );
  }
  if (outcome === "miss") {
    return (
      <span
        aria-hidden
        style={{
          ...base,
          width: size,
          height: size,
          boxSizing: "border-box",
          borderRadius: "50%",
          border: "2px solid var(--ink)",
          background: "var(--panel)",
        }}
      />
    );
  }
  if (outcome === "deferred") {
    // A hollow diamond: not a result, only a check-in that waited for a call or share.
    return (
      <span
        aria-hidden
        style={{
          ...base,
          width: size - 1,
          height: size - 1,
          boxSizing: "border-box",
          borderRadius: 1,
          border: "2px solid var(--smeeting)",
          background: "var(--panel)",
          transform: "rotate(45deg)",
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        ...base,
        width: size - 1,
        height: size - 1,
        borderRadius: 1,
        background: "var(--stamper)",
        transform: "rotate(45deg)",
        boxShadow: "0 0 0 2px var(--panel)",
      }}
    />
  );
}

export function StatsRow({ cards }: { cards: StatCard[] }) {
  return (
    <section aria-label="Totals for the day">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((c) => (
          <div key={c.key} className="flex flex-col gap-[3px] border-l border-line pl-3.5">
            <dt className="text-[12.5px] text-ink2">{c.label}</dt>
            <dd className="font-mono text-xl font-medium tracking-[-0.03em]">{c.value}</dd>
            <dd className="text-xs text-ink3">{c.note}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function DayTimeline({
  segs,
  span,
  ticks,
  checkins,
  selectedId,
  onSelect,
  viewer,
}: {
  segs: BarSegment[];
  span: Span;
  ticks: { left: number; label: string }[];
  checkins: Checkin[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  viewer: string;
}) {
  const selected = checkins.find((c) => c.id === selectedId);
  const selectedLeft = selected ? markerLeft(span, selected) : null;
  const present = new Set(segs.map((s) => s.type));
  const summary = segs.length
    ? `Time over the day: ${typeTotals(segs)
        .map((t) => `${segmentStyle[t.type].label} ${formatDuration(t.seconds)}`)
        .join(", ")}`
    : "No activity recorded on this day";
  const swatch = (type: SegmentType) => (
    <span
      aria-hidden
      className="block h-2.5 w-[18px] rounded-[2px]"
      style={{ background: background(type, flaggedByDefault.has(type)) }}
    />
  );

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div aria-hidden className="relative h-4 font-mono text-[11px] text-ink3">
          {ticks.map((t) => (
            <span
              key={t.left}
              className="absolute"
              style={{
                left: `${t.left}%`,
                transform:
                  t.left <= 0 ? "none" : t.left >= 100 ? "translateX(-100%)" : "translateX(-50%)",
              }}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div className="relative">
          <div
            role="img"
            aria-label={summary}
            className="relative h-10 overflow-hidden rounded-[7px] bg-line"
          >
            {segs.map((s) => (
              <span
                key={`${s.type}-${s.start}`}
                title={`${s.tamper ? tamperLabel[s.tamper] : segmentStyle[s.type].label}${s.excluded ? ", excluded by a manager" : ""}, ${DateTime.fromMillis(s.start, { zone: viewer }).toFormat("HH:mm")}–${DateTime.fromMillis(s.end, { zone: viewer }).toFormat("HH:mm")}`}
                className="absolute inset-y-0 block"
                style={{
                  left: `${s.left}%`,
                  width: `${s.width}%`,
                  background: background(s.type, s.flagged),
                  boxShadow: "inset -1px 0 0 var(--panel)",
                }}
              />
            ))}
          </div>
          {selectedLeft !== null && (
            <span
              aria-hidden
              data-testid="selected-line"
              className="pointer-events-none absolute -top-[3px] -bottom-[3px] -ml-px w-0.5 rounded-[1px] bg-ink"
              style={{ left: `${selectedLeft}%` }}
            />
          )}
        </div>
        <div className="relative h-[30px]">
          {checkins.map((c) => {
            const left = markerLeft(span, c);
            if (left === null) return null;
            const label = markerLabel(c, viewer);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={selectedId === c.id}
                aria-label={label}
                title={label}
                onClick={() => onSelect(c.id)}
                className="absolute top-0 flex h-[30px] w-7 -translate-x-1/2 items-center justify-center rounded-md"
                style={{
                  left: `${left}%`,
                  outline: selectedId === c.id ? "1.5px solid var(--ink)" : "none",
                  outlineOffset: -4,
                }}
              >
                <Marker outcome={c.outcome} />
              </button>
            );
          })}
        </div>
      </div>

      <ul className="flex flex-wrap gap-x-[18px] gap-y-2 text-[12.5px] text-ink2">
        {[...legendTypes, ...extraTypes.filter((t) => present.has(t))].map((t) => (
          <li key={t} className="flex items-center gap-[7px]">
            {swatch(t)}
            {segmentStyle[t].label}
          </li>
        ))}
        {tamperTotals(segs).map((t) => (
          <li key={t.reason} className="flex items-center gap-[7px]">
            {swatch("unverified")}
            {tamperLabel[t.reason]} · {formatDuration(t.seconds)}
          </li>
        ))}
        {markerLegend.map(([o, label]) => (
          <li key={o} className="flex items-center gap-[7px]">
            <Marker outcome={o} size={9} />
            {label}
          </li>
        ))}
      </ul>
    </>
  );
}
