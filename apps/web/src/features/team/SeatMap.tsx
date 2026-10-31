// DSH-09 (#251): the team as seats around oval tables. Green is Active, red anything
// else; the exact status is always text too (tooltip and accessible name), and the
// chairs are a real list of links, so screen readers get the same thing as a list.
import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { type PresenceStatus, StatusChip } from "../../components/StatusChip";
import { cn } from "../../lib/cn";
import { initials } from "../../lib/nav";
import { formatTime } from "../../lib/time";
import { since, type TeamRow } from "./grid";
import {
  CHAIR_SIZE,
  nextSeat,
  type SeatTable,
  type SeatTone,
  seatName,
  seatTables,
  seatTone,
  spreadSeats,
  TABLE_RADIUS,
  TABLE_STRAIGHT,
  TABLE_VIEW,
  tableSeats,
} from "./seats";

/** Existing status tokens: Active's green and Tamper's red (no new colours). */
const toneClass: Record<SeatTone, string> = {
  active: "text-[var(--sactive)]",
  inactive: "text-[var(--stamper)]",
};

const seats = tableSeats();
const pct = (n: number, of: number) => `${(n / of) * 100}%`;

export function SeatMap({
  rows,
  teams,
  teamId,
  zone,
  now,
  projectName,
}: {
  rows: TeamRow[];
  teams: { id: string; name: string }[];
  teamId: string;
  zone: string;
  now: Date;
  projectName: Map<string, string>;
}) {
  const tables = useMemo(() => seatTables(rows, teams, teamId), [rows, teams, teamId]);
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-ink2">
        <span className="flex items-center gap-2">
          <span aria-hidden className="h-3 w-3 rounded-full bg-[var(--sactive)]" />
          Active
        </span>
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-3 w-3 rounded-full border-2 border-dashed border-[var(--stamper)]"
          />
          Not active: idle, away, on break, paused, in a meeting, offline or off shift
        </span>
        <span className="text-ink3 lg:ml-auto">
          Arrow keys move round a table. Enter opens the person's day.
        </span>
      </div>
      <div className="grid gap-4 2xl:grid-cols-2">
        {tables.map((t) => (
          <Table key={t.key} table={t} zone={zone} now={now} projectName={projectName} />
        ))}
      </div>
    </div>
  );
}

function Table({
  table,
  zone,
  now,
  projectName,
}: {
  table: SeatTable;
  zone: string;
  now: Date;
  projectName: Map<string, string>;
}) {
  const id = useId();
  const { width: W, height: H } = TABLE_VIEW;
  const taken = spreadSeats(table.people.length);
  const free = seats.filter((_, i) => !taken.includes(i));
  const [focused, setFocused] = useState(0);
  const [tip, setTip] = useState<number | null>(null);
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  // The roving tab stop stays on a seat that still exists when people leave.
  const stop = Math.min(focused, table.people.length - 1);
  const active = table.people.filter((r) => seatTone(r.status) === "active").length;

  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === "Escape") {
      setTip(null);
      return;
    }
    const next = nextSeat(e.key, i, table.people.length);
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
  };

  return (
    <div className="relative w-full" style={{ aspectRatio: `${W} / ${H}` }}>
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden className="absolute inset-0 h-full w-full">
        <rect
          x={W / 2 - TABLE_STRAIGHT / 2 - TABLE_RADIUS}
          y={H / 2 - TABLE_RADIUS}
          width={TABLE_STRAIGHT + 2 * TABLE_RADIUS}
          height={TABLE_RADIUS * 2}
          rx={TABLE_RADIUS}
          fill="var(--sunk)"
          stroke="var(--line2)"
          strokeWidth="1.5"
        />
        <rect
          x={W / 2 - TABLE_STRAIGHT / 2}
          y={H / 2 - 14}
          width={TABLE_STRAIGHT}
          height={28}
          rx={14}
          fill="none"
          stroke="var(--line2)"
          strokeDasharray="5 5"
        />
      </svg>
      <div
        className="pointer-events-none absolute inset-x-0 flex flex-col items-center"
        style={{ top: pct(H / 2 - TABLE_RADIUS + 18, H) }}
      >
        <h2 id={`${id}-name`} className="max-w-[60%] truncate text-[13.5px] font-semibold">
          {table.label}
        </h2>
      </div>
      <p
        className="pointer-events-none absolute inset-x-0 text-center text-xs text-ink3"
        style={{ bottom: pct(H / 2 - TABLE_RADIUS + 18, H) }}
      >
        {table.people.length} {table.people.length === 1 ? "person" : "people"} · {active} active
      </p>

      {free.map((s) => (
        <span
          key={`${s.x}-${s.y}`}
          aria-hidden
          className="absolute -translate-x-1/2 -translate-y-1/2 text-line2 opacity-60"
          style={{
            left: pct(s.x, W),
            top: pct(s.y, H),
            width: pct(CHAIR_SIZE, W),
            aspectRatio: "1",
          }}
        >
          <Chair rotate={s.rotate} />
        </span>
      ))}

      <ul aria-labelledby={`${id}-name`} className="m-0 list-none p-0">
        {table.people.map((r, i) => {
          const s = seats[taken[i] ?? 0] ?? { x: 0, y: 0, rotate: 0 };
          const tone = seatTone(r.status);
          const project = (r.project_id && projectName.get(r.project_id)) || null;
          const tipId = `${id}-tip-${i}`;
          return (
            <li
              key={r.user_id}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{
                left: pct(s.x, W),
                top: pct(s.y, H),
                width: pct(CHAIR_SIZE, W),
                aspectRatio: "1",
                zIndex: tip === i ? 10 : undefined,
              }}
              onMouseEnter={() => setTip(i)}
              onMouseLeave={() => setTip(null)}
            >
              <Link
                ref={(el) => {
                  refs.current[i] = el;
                }}
                to="/team/$userId"
                params={{ userId: r.user_id ?? "" }}
                tabIndex={i === stop ? 0 : -1}
                aria-label={seatName(r, zone)}
                aria-describedby={tipId}
                className={cn("absolute inset-0 block rounded-full", toneClass[tone])}
                onFocus={() => {
                  setFocused(i);
                  setTip(i);
                }}
                onBlur={() => setTip(null)}
                onKeyDown={(e) => onKey(e, i)}
              >
                <Chair rotate={s.rotate} dashed={tone === "inactive"} />
                <span
                  aria-hidden
                  className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-ink"
                >
                  {initials(r.full_name ?? "")}
                </span>
              </Link>
              <div
                id={tipId}
                role="tooltip"
                className={cn(
                  "absolute z-10 w-max max-w-[260px] rounded-lg border border-line bg-panel px-3 py-2.5 text-[12.5px] shadow-md",
                  tip === i ? "block" : "hidden",
                  s.y < H / 2 ? "top-full mt-1.5" : "bottom-full mb-1.5",
                  s.x < W * 0.3
                    ? "left-0"
                    : s.x > W * 0.7
                      ? "right-0"
                      : "left-1/2 -translate-x-1/2",
                )}
              >
                <div className="font-medium">{r.full_name}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <StatusChip
                    status={(r.status ?? "off_shift") as PresenceStatus}
                    reason={r.tamper_reason}
                  />
                  {r.since && (
                    <span className="text-ink3">
                      since {formatTime(r.since, zone, zone)} · {since(r.since, now)}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 text-ink2">Project: {project ?? "none"}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A chair from above, drawn facing down (the table below it), turned by `rotate`. */
function Chair({ rotate, dashed = false }: { rotate: number; dashed?: boolean }) {
  return (
    <svg
      viewBox="0 0 46 46"
      aria-hidden
      className="absolute inset-0 h-full w-full overflow-visible"
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <rect x="9" y="2" width="28" height="10" rx="5" fill="currentColor" />
      <rect x="2" y="13" width="7" height="23" rx="3.5" fill="currentColor" />
      <rect x="37" y="13" width="7" height="23" rx="3.5" fill="currentColor" />
      <rect
        x="10.5"
        y="9.5"
        width="25"
        height="30"
        rx="9"
        fill="var(--panel)"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeDasharray={dashed ? "5 3" : undefined}
      />
    </svg>
  );
}
