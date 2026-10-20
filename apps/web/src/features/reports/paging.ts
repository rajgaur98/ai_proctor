// Paging the report table (#156, DSH-07, NFR-PERF-03: up to ~500 people per org). The
// whole report is fetched and sorted in the browser, so sorting runs over everyone before
// a page is cut and the team row is added up from every row; these are the numbers the
// pager and the chart note show.

/** Rows per page the viewer can choose; the first is also the size under which there is no pager. */
export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;

/** Pages needed for `total` rows; at least one, so an empty table still reads "Page 1 of 1". */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

/** The page index (from 0) kept inside what exists, e.g. after the page size grows. */
export function clampPageIndex(pageIndex: number, total: number, size: number): number {
  return Math.min(Math.max(0, pageIndex), pageCount(total, size) - 1);
}

/** The 1-based first and last row on a page ("Showing 51 to 100"); both 0 when there are no rows. */
export function pageWindow(
  pageIndex: number,
  total: number,
  size: number,
): { first: number; last: number } {
  if (total <= 0) return { first: 0, last: 0 };
  const index = clampPageIndex(pageIndex, total, size);
  return { first: index * size + 1, last: Math.min(total, (index + 1) * size) };
}

/** Whether a report is long enough to need a pager. */
export function needsPager(total: number): boolean {
  return total > PAGE_SIZES[0];
}

/** What the table is ordered by, as TanStack Table reports it. */
export interface ActiveSort {
  id: string;
  desc: boolean;
}

/**
 * The note on a chart that shows only the first rows of the table's order, or null when
 * it shows everyone. `header` is the sorted column's title ("Worked", "Person").
 */
export function chartNote(
  shown: number,
  total: number,
  sort: ActiveSort | undefined,
  header: string,
): string | null {
  if (shown >= total) return null;
  if (!sort) return `Showing ${shown} of ${total}`;
  const direction =
    sort.id === "person"
      ? sort.desc
        ? "Z to A"
        : "A to Z"
      : sort.desc
        ? "highest first"
        : "lowest first";
  return `Showing ${shown} of ${total} by ${header.toLowerCase()}, ${direction}`;
}
