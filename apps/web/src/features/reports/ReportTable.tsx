// The sortable, paged report table (DSH-07, #156): one row per person, a column for every
// metric, and the team's totals underneath. TanStack Table owns the sorting and the paging
// (sorting runs over every row before a page is cut); the markup is ours.
import type { ReportRow, ReportTotals } from "@ai-proctor/core";
import {
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { cn } from "../../lib/cn";
import { formatDuration } from "../timesheets/summary";
import { formatRate, formatResponse } from "./format";
import { DEFAULT_PAGE_SIZE, needsPager, PAGE_SIZES, pageCount, pageWindow } from "./paging";

const features = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: { basic: sortFn_basic, text: sortFn_text },
});

const helper = createColumnHelper<typeof features, ReportRow>();

/** One metric: how it sorts, how a person's value reads and how the team's does. */
interface Metric {
  id: string;
  header: string;
  /** Sort value; undefined (no data) always sorts last. */
  sort: (r: ReportRow) => number | undefined;
  show: (r: ReportRow) => string;
  total: (t: ReportTotals) => string;
}

const count = (n: number) => String(n);

export const metrics: Metric[] = [
  {
    id: "worked",
    header: "Worked",
    sort: (r) => r.workedS,
    show: (r) => formatDuration(r.workedS),
    total: (t) => formatDuration(t.workedS),
  },
  {
    id: "flagged",
    header: "Flagged",
    sort: (r) => r.flaggedS,
    show: (r) => formatDuration(r.flaggedS),
    total: (t) => formatDuration(t.flaggedS),
  },
  {
    id: "shown",
    header: "Check-ins shown",
    sort: (r) => r.checkinsShown,
    show: (r) => count(r.checkinsShown),
    total: (t) => count(t.checkinsShown),
  },
  {
    id: "passed",
    header: "Passed",
    sort: (r) => r.checkinsPassed,
    show: (r) => count(r.checkinsPassed),
    total: (t) => count(t.checkinsPassed),
  },
  {
    id: "missed",
    header: "Missed",
    sort: (r) => r.checkinsMissed,
    show: (r) => count(r.checkinsMissed),
    total: (t) => count(t.checkinsMissed),
  },
  {
    id: "failed",
    header: "Failed",
    sort: (r) => r.checkinsFailed,
    show: (r) => count(r.checkinsFailed),
    total: (t) => count(t.checkinsFailed),
  },
  {
    id: "rate",
    header: "Response rate",
    sort: (r) => r.responseRate ?? undefined,
    show: (r) => formatRate(r.responseRate),
    total: (t) => formatRate(t.responseRate),
  },
  {
    id: "median",
    header: "Median response",
    sort: (r) => r.medianResponseMs ?? undefined,
    show: (r) => formatResponse(r.medianResponseMs),
    total: (t) => formatResponse(t.medianResponseMs),
  },
  {
    id: "break",
    header: "Breaks",
    sort: (r) => r.breakS,
    show: (r) => formatDuration(r.breakS),
    total: (t) => formatDuration(t.breakS),
  },
  {
    id: "pause",
    header: "Pauses",
    sort: (r) => r.pauseS,
    show: (r) => formatDuration(r.pauseS),
    total: (t) => formatDuration(t.pauseS),
  },
  {
    id: "late",
    header: "Late clock-ins",
    sort: (r) => r.lateClockIns,
    show: (r) => count(r.lateClockIns),
    total: (t) => count(t.lateClockIns),
  },
  {
    // DSH-08: anti-cheat flags nobody has reviewed yet. A signal to look at the person's
    // days, never a penalty (ANT-08).
    id: "review",
    header: "Needs review",
    sort: (r) => r.needsReview,
    show: (r) => count(r.needsReview),
    total: (t) => count(t.needsReview),
  },
];

const columns = helper.columns([
  helper.accessor("fullName", { id: "person", header: "Person", sortFn: "text" }),
  ...metrics.map((m) =>
    helper.accessor((r) => m.sort(r), {
      id: m.id,
      header: m.header,
      sortFn: "basic",
      // The biggest first, the way a report is read.
      sortDescFirst: true,
      sortUndefined: "last",
      cell: (info) => m.show(info.row.original),
    }),
  ),
]);

const ariaSort = { asc: "ascending", desc: "descending" } as const;

/** The report's table: sorted by name, 50 to a page; sorting covers all the rows. */
export function useReportTable(rows: ReportRow[]) {
  return useTable({
    features,
    columns,
    data: rows,
    getRowId: (r) => r.userId,
    initialState: {
      sorting: [{ id: "person", desc: false }],
      pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE },
    },
    enableSortingRemoval: false,
  });
}

export type ReportTableInstance = ReturnType<typeof useReportTable>;

/** The title of a column, for the chart note ("Worked", "Late clock-ins"). */
export function columnTitle(id: string): string {
  return id === "person" ? "Person" : (metrics.find((m) => m.id === id)?.header ?? id);
}

export function ReportTable({
  table,
  totals,
  caption,
}: {
  table: ReportTableInstance;
  totals: ReportTotals;
  caption: string;
}) {
  const cell = "px-3 text-right font-mono text-[13px] whitespace-nowrap";

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] border-collapse text-[13.5px]">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-sunk text-left text-xs font-medium text-ink3">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="h-11 border-b border-line">
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const isPerson = header.column.id === "person";
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={sorted ? ariaSort[sorted] : "none"}
                      className={cn("font-medium", isPerson ? "px-5" : "px-3 text-right")}
                    >
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          "inline-flex items-center gap-1 whitespace-nowrap rounded py-1 font-medium hover:text-ink",
                          sorted && "text-ink",
                        )}
                      >
                        <table.FlexRender header={header} />
                        <span aria-hidden="true" className="w-3 text-[11px]">
                          {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="h-12 border-b border-line">
                {row.getAllCells().map((c) =>
                  c.column.id === "person" ? (
                    <th key={c.id} scope="row" className="px-5 text-left font-medium">
                      {row.original.fullName}
                    </th>
                  ) : (
                    <td key={c.id} className={cell}>
                      <table.FlexRender cell={c} />
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="h-12 bg-sunk font-semibold">
              <th scope="row" className="px-5 text-left">
                Team ({totals.people})
              </th>
              {metrics.map((m) => (
                <td key={m.id} className={cell}>
                  {m.total(totals)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager table={table} />
    </>
  );
}

/** Page controls under the table; absent while everyone fits the smallest page. */
function Pager({ table }: { table: ReportTableInstance }) {
  const total = table.getRowCount();
  if (!needsPager(total)) return null;
  const { pageIndex, pageSize } = table.state.pagination;
  const { first, last } = pageWindow(pageIndex, total, pageSize);

  return (
    <nav
      aria-label="Report pages"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3"
    >
      <p aria-live="polite" className="m-0 text-[13px] text-ink2">
        Showing {first} to {last} of {total} people
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor="report-page-size">Rows per page</Label>
        <select
          id="report-page-size"
          value={pageSize}
          onChange={(e) => table.setPageSize(Number(e.target.value))}
          className="h-10 rounded-[9px] border border-line2 bg-panel px-3 text-[13.5px] text-ink"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          className="h-10"
          disabled={!table.getCanPreviousPage()}
          onClick={() => table.previousPage()}
        >
          Previous
        </Button>
        <span className="text-[13px] text-ink2">
          Page {pageIndex + 1} of {pageCount(total, pageSize)}
        </span>
        <Button
          variant="secondary"
          className="h-10"
          disabled={!table.getCanNextPage()}
          onClick={() => table.nextPage()}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
