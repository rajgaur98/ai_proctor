// An employee's own Insights in My data (#305, INS-05, EMP-02): the same metrics the
// Insights page shows managers, about the signed-in person only, for a date range against
// the previous one. Anyone can open it (/me?view=insights); the numbers are the
// database's (insights with their own id, which only they and who manages them can read).
import { useQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useState } from "react";
import { ExportButton } from "../../components/ExportButton";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { cn } from "../../lib/cn";
import { InsightsView } from "../insights/InsightsView";
import { insightsQuery } from "../insights/insightsData";
import {
  bucketLabel,
  projectsTable,
  reviewTable,
  summaryTable,
  trendTable,
} from "../insights/model";
import {
  type DateRange,
  presetLabel,
  presetOf,
  presetRange,
  presets,
  rangeProblem,
} from "../reports/range";
import { weekStartQuery } from "../timesheets/timesheetData";

/** The two views of My data, as links so each has its own address. */
export function MyDataTabs({ view }: { view: "day" | "insights" }) {
  const tab = "flex h-9 items-center rounded-lg px-3 text-[13.5px] font-medium";
  return (
    <nav
      aria-label="My data views"
      className="flex gap-1 rounded-xl border border-line bg-panel p-1 self-start"
    >
      <Link
        to="/me"
        aria-current={view === "day" ? "page" : undefined}
        className={cn(tab, view === "day" ? "bg-sunk text-ink" : "text-ink2")}
      >
        My day
      </Link>
      <Link
        to="/me"
        search={{ view: "insights" }}
        aria-current={view === "insights" ? "page" : undefined}
        className={cn(tab, view === "insights" ? "bg-sunk text-ink" : "text-ink2")}
      >
        My insights
      </Link>
    </nav>
  );
}

export function MyInsights() {
  const { profile } = useRouteContext({ from: "/_app" });
  const startDay = useQuery(weekStartQuery);
  const today = DateTime.now().setZone(profile.timezone).toISODate() ?? "";
  const [picked, setPicked] = useState<DateRange | null>(null);
  const range = picked ?? presetRange("this-week", today, startDay.data ?? 1);
  const problem = rangeProblem(range);
  const insights = useQuery({
    ...insightsQuery(range.from, range.to, "", [profile.id]),
    enabled: startDay.isSuccess && problem === null,
    placeholderData: (previous) => previous,
  });
  const data = insights.data;
  const active = presetOf(range, today, startDay.data ?? 1);
  const filters = { from: range.from, to: range.to };
  const need = () => {
    if (!data) throw new Error("Your insights are still loading.");
    return data;
  };

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div className="max-w-[640px]">
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">My data</h1>
          <p className="mt-1 text-[13.5px] leading-normal text-ink2">
            Your own totals and trends: attendance, check-ins and time, against the previous period
            of the same length. The same numbers your manager sees, with no score or ranking.
          </p>
        </div>
        <ExportButton
          title="My insights"
          className="ml-auto"
          ready={!!data && !insights.isPlaceholderData && problem === null}
          choices={[
            {
              label: "Summary",
              spec: { page: "my-insights-summary", filters, table: () => summaryTable(need()) },
            },
            {
              label: "Trend",
              spec: { page: "my-insights-trend", filters, table: () => trendTable(need()) },
            },
            {
              label: "Projects",
              spec: { page: "my-insights-projects", filters, table: () => projectsTable(need()) },
            },
            {
              label: "Days to review",
              spec: {
                page: "my-insights-review",
                filters,
                table: () => reviewTable(need().reviewDays),
              },
            },
          ]}
        />
      </div>
      <MyDataTabs view="insights" />

      <div className="flex flex-wrap items-end gap-3">
        <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
          <legend className="sr-only">Date range presets</legend>
          {presets.map((p) => (
            <Button
              key={p}
              variant="secondary"
              className={cn("h-10", active === p && "border-acc bg-accsoft text-acctext")}
              aria-pressed={active === p}
              onClick={() => setPicked(presetRange(p, today, startDay.data ?? 1))}
            >
              {presetLabel[p]}
            </Button>
          ))}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="my-insights-from">From</Label>
          <Input
            id="my-insights-from"
            type="date"
            className="h-10 w-auto text-[13.5px]"
            value={range.from}
            onChange={(e) => setPicked({ ...range, from: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="my-insights-to">To</Label>
          <Input
            id="my-insights-to"
            type="date"
            className="h-10 w-auto text-[13.5px]"
            value={range.to}
            onChange={(e) => setPicked({ ...range, to: e.target.value })}
          />
        </div>
      </div>

      {problem ? (
        <p role="alert" className="text-sm text-warnink">
          {problem}
        </p>
      ) : insights.error ? (
        <p role="alert" className="text-sm text-warnink">
          Couldn't load your insights: {insights.error.message}
        </p>
      ) : !data ? (
        <p className="text-sm text-ink2">Loading…</p>
      ) : (
        <>
          <p aria-live="polite" className="text-[13px] text-ink2">
            {bucketLabel(data.from, "day", data.to)} to {bucketLabel(data.to, "day", data.to)},
            compared with {bucketLabel(data.previousFrom, "day", data.previousTo)} to{" "}
            {bucketLabel(data.previousTo, "day", data.previousTo)}.
            {insights.isFetching ? " Updating…" : ""}
          </p>
          <InsightsView data={data} self />
        </>
      )}
    </section>
  );
}
