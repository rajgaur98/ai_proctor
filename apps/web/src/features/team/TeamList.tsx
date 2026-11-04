// DSH-01 live list. With more than a couple of hundred people on shift only the rows on screen
// are drawn (#323): spacer rows keep the table its full height, the window follows the page's
// scroll, the row with focus stays drawn, and the keys move the focus row to row so the window
// follows it. Screen readers get the whole table's size from aria-rowcount / aria-rowindex.
import { Link } from "@tanstack/react-router";
import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type PresenceStatus, StatusChip } from "../../components/StatusChip";
import { initials } from "../../lib/nav";
import { formatTime, viewerZone } from "../../lib/time";
import { since, type TeamRow } from "./grid";
import { FULL_RENDER_MAX, keyTarget, type RowRange, rowRange, slots } from "./rowWindow";

/** A desktop row's height before the first one is measured. */
const ROW_ESTIMATE = 61;
/** Rows drawn before the table's position is known (replaced before the first paint). */
const FIRST_DRAW = 40;
const COLUMNS = 6;

export function TeamList({
  rows,
  now,
  projectName,
}: {
  rows: TeamRow[];
  now: Date;
  projectName: Map<string, string>;
}) {
  const count = rows.length;
  const windowed = count > FULL_RENDER_MAX;
  const body = useRef<HTMLTableSectionElement>(null);
  const [rowHeight, setRowHeight] = useState(ROW_ESTIMATE);
  const [range, setRange] = useState<RowRange>({ start: 0, end: FIRST_DRAW });
  // The row whose link has focus, by person, so it stays drawn (and found) when rows re-sort.
  const [focused, setFocused] = useState<string | null>(null);
  const focusNext = useRef<string | null>(null);
  // The screen width the row height was measured at; a new width measures again.
  const [width, setWidth] = useState(() => window.innerWidth);
  const measuredAt = useRef<number | null>(null);

  const place = useCallback(() => {
    const el = body.current;
    if (!el) return;
    const next = rowRange(count, rowHeight, el.getBoundingClientRect().top, window.innerHeight);
    setRange((r) => (r.start === next.start && r.end === next.end ? r : next));
  }, [count, rowHeight]);

  // Before paint: the window for where the table is now (and after rows or height change).
  useLayoutEffect(() => {
    if (windowed) place();
  }, [windowed, place]);

  useEffect(() => {
    if (!windowed) return;
    const onResize = () => {
      setWidth(window.innerWidth);
      place();
    };
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", place);
      window.removeEventListener("resize", onResize);
    };
  }, [windowed, place]);

  // The rows' real height, once per screen width (on a phone a row stacks into a taller card).
  useLayoutEffect(() => {
    if (!windowed || measuredAt.current === width) return;
    const drawn = body.current?.querySelectorAll<HTMLElement>("tr[aria-rowindex]");
    if (!drawn?.length) return;
    let total = 0;
    for (const tr of drawn) total += tr.getBoundingClientRect().height;
    measuredAt.current = width;
    const h = total / drawn.length;
    if (h > 0 && Math.abs(h - rowHeight) > 0.5) setRowHeight(h);
  });

  // A key moved the focus to a row that's now drawn: focus its link, which scrolls it into
  // view (instantly, never animated) and the window follows the scroll.
  useLayoutEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    const link = body.current?.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(id)}"] a`);
    if (!link) return;
    focusNext.current = null;
    link.focus({ preventScroll: true });
    link.closest("tr")?.scrollIntoView({ block: "nearest", behavior: "instant" });
    // The window for where the page is now, drawn before the next paint.
    if (windowed) place();
  });

  const indexOf = (id: string | null) => (id ? rows.findIndex((r) => r.user_id === id) : -1);
  const pinned = windowed ? indexOf(focused) : -1;

  const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tr = (e.target as HTMLElement).closest<HTMLElement>("tr[data-id]");
    if (!tr || !(e.target instanceof HTMLAnchorElement)) return;
    const from = indexOf(tr.dataset.id ?? null);
    if (from < 0) return;
    const page = Math.max(1, Math.floor(window.innerHeight / rowHeight) - 1);
    // A short list is all drawn, so Tab is left to the browser there.
    if (e.key === "Tab" && !windowed) return;
    const to = keyTarget(e.key, e.shiftKey, from, count, page);
    if (to === null) return;
    e.preventDefault();
    const id = rows[to]?.user_id;
    if (!id) return;
    // The target is drawn in its place (it's the focused row now), then focused.
    focusNext.current = id;
    setFocused(id);
  };

  const plan = windowed
    ? slots(count, range, pinned < 0 ? null : pinned)
    : rows.map((_, index) => ({ index }));

  return (
    <table className="w-full border-collapse text-[13.5px]" aria-rowcount={count + 1}>
      <caption className="sr-only">
        On shift, {count} {count === 1 ? "person" : "people"}. Arrow keys, Page Up, Page Down, Home
        and End move between people.
      </caption>
      <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
        <tr className="h-10 border-b border-line" aria-rowindex={1}>
          <th className="px-5 font-medium">Person</th>
          <th className="font-medium">Status</th>
          <th className="font-medium">Last check-in</th>
          <th className="font-medium">Today</th>
          <th className="font-medium">Project</th>
          <th className="pr-5">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody
        ref={body}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          const id = (e.target as HTMLElement).closest<HTMLElement>("tr[data-id]")?.dataset.id;
          if (id) setFocused(id);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null);
        }}
      >
        {plan.map((slot) =>
          "gap" in slot ? (
            // Stands in for rows that aren't drawn; hidden from screen readers, which get the
            // table's size from aria-rowcount instead.
            // biome-ignore lint/a11y/noAriaHiddenOnFocusable: an empty spacer row, nothing in it takes focus
            <tr
              key={`gap-${slot.from}`}
              aria-hidden="true"
              style={{ height: slot.gap * rowHeight }}
            >
              <td colSpan={COLUMNS} className="p-0" />
            </tr>
          ) : (
            <MemoRow
              key={rows[slot.index]?.user_id ?? slot.index}
              row={rows[slot.index] as TeamRow}
              index={slot.index}
              now={now}
              projectName={projectName}
            />
          ),
        )}
      </tbody>
    </table>
  );
}

function Row({
  row,
  index,
  now,
  projectName,
}: {
  row: TeamRow;
  index: number;
  now: Date;
  projectName: Map<string, string>;
}) {
  const zone = viewerZone();
  const project = (row.project_id && projectName.get(row.project_id)) || null;
  const missed = row.last_checkin_outcome === "miss" || row.last_checkin_outcome === "failed";
  return (
    <tr
      aria-rowindex={index + 2}
      data-id={row.user_id ?? ""}
      className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-b border-line px-4 py-3 hover:bg-sunk md:table-row md:p-0"
    >
      <td className="row-span-3 md:py-3 md:pl-5">
        <div className="flex items-center gap-[11px]">
          <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full border border-line bg-sunk text-xs font-semibold text-ink2">
            {initials(row.full_name ?? "")}
          </span>
          <div className="hidden md:block">
            <div className="font-medium">{row.full_name}</div>
            <div className="mt-px text-xs text-ink3 capitalize">{row.role}</div>
          </div>
        </div>
      </td>
      <td className="font-medium md:hidden">{row.full_name}</td>
      <td>
        <span className="inline-flex items-center gap-1.5">
          <StatusChip
            status={(row.status ?? "off_shift") as PresenceStatus}
            reason={row.tamper_reason}
          />
          <span className="text-[12.5px] text-ink3">· {since(row.since, now)}</span>
        </span>
      </td>
      <td>
        {row.last_checkin_at ? (
          <span className="flex items-center gap-2">
            <time
              className="font-mono text-[12.5px]"
              dateTime={row.last_checkin_at}
              title={
                row.timezone
                  ? `${formatTime(row.last_checkin_at, row.timezone, zone)} employee's time`
                  : undefined
              }
            >
              {formatTime(row.last_checkin_at, zone, zone)}
            </time>
            <span
              className={
                missed
                  ? "rounded-full border border-dashed border-ink3 px-[7px] py-px text-xs font-semibold"
                  : "text-[12.5px] text-ink3"
              }
            >
              {row.last_checkin_outcome === "pass"
                ? "passed"
                : row.last_checkin_outcome === "miss"
                  ? "missed"
                  : "failed"}
            </span>
          </span>
        ) : (
          <span className="text-[12.5px] text-ink3">No check-in yet</span>
        )}
      </td>
      <td className="text-ink2 tabular-nums">
        {row.checkins_passed_today} of {row.checkins_shown_today}
      </td>
      <td className="truncate text-ink2">{project ?? "—"}</td>
      <td className="md:pr-5 md:text-right">
        <Link
          to="/team/$userId"
          params={{ userId: row.user_id ?? "" }}
          className="inline-block py-3 text-[13px] font-medium whitespace-nowrap text-acctext"
        >
          View day<span className="sr-only"> for {row.full_name}</span>
        </Link>
      </td>
    </tr>
  );
}

/** Scrolling re-renders the list; a row whose person, place and clock haven't changed doesn't. */
const MemoRow = memo(Row);
