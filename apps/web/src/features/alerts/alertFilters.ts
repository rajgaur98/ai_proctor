// The alerts page's filters and keyset paging (ALR-01), kept pure so they can be tested.
import { DateTime } from "luxon";
import { viewerZone } from "../../lib/time";
import type { AlertKind } from "./alertText";

export type ReadFilter = "all" | "unread" | "read";

export interface AlertFilters {
  /** "" = every kind. */
  kind: AlertKind | "";
  /** "" = everyone. */
  userId: string;
  /** Dates (yyyy-mm-dd) in the viewer's zone, both ends included; "" = open. */
  from: string;
  to: string;
  read: ReadFilter;
}

export const NO_FILTERS: AlertFilters = { kind: "", userId: "", from: "", to: "", read: "all" };

export function filtersActive(f: AlertFilters): boolean {
  return f.kind !== "" || f.userId !== "" || f.from !== "" || f.to !== "" || f.read !== "all";
}

/** The instants the date range covers: [from, to), local days in `zone`. */
export function dateBounds(
  f: Pick<AlertFilters, "from" | "to">,
  zone: string = viewerZone(),
): { from: string | null; to: string | null } {
  const start = f.from ? DateTime.fromISO(f.from, { zone }) : null;
  const end = f.to ? DateTime.fromISO(f.to, { zone }) : null;
  return {
    from: start?.isValid ? (start.startOf("day").toUTC().toISO() ?? null) : null,
    to: end?.isValid ? (end.plus({ days: 1 }).startOf("day").toUTC().toISO() ?? null) : null,
  };
}

/** Where the next page starts: the last row of the one before. */
export interface AlertCursor {
  triggeredAt: string;
  id: string;
}

/** PostgREST `or` filter for rows after the cursor in (triggered_at, id) descending order. */
export function cursorFilter(c: AlertCursor): string {
  return `triggered_at.lt."${c.triggeredAt}",and(triggered_at.eq."${c.triggeredAt}",id.lt.${c.id})`;
}

/** A query asks for one row more than a page: the extra one says there is a next page. */
export function splitPage<T extends { id: string; triggeredAt: string }>(
  rows: T[],
  size: number,
): { rows: T[]; next: AlertCursor | null } {
  if (rows.length <= size) return { rows, next: null };
  const shown = rows.slice(0, size);
  const last = shown[shown.length - 1];
  return { rows: shown, next: last ? { triggeredAt: last.triggeredAt, id: last.id } : null };
}
