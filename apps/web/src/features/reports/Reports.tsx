// The Reports tab (#47, DSH-07): hours, flagged time, check-in outcomes, response rate
// and time, break and pause totals and late clock-ins per person and for the team, for a
// date range. The numbers come from `report_rows` (the same seconds as the timesheets);
// charts and a sortable, paged table show them (#156: the whole report is sorted and added
// up here, and only the table's rows are paged).
import { type ReportRow, teamTotals } from "@ai-proctor/core";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { cn } from "../../lib/cn";
import { teamsQuery } from "../teams/teamData";
import { formatDuration } from "../timesheets/summary";
import { weekStartQuery } from "../timesheets/timesheetData";
import { formatRate, formatResponse } from "./format";
import { chartNote } from "./paging";
import { CHART_PEOPLE, ReportCharts } from "./ReportCharts";
import { columnTitle, ReportTable, useReportTable } from "./ReportTable";
import { type DateRange, presetLabel, presetOf, presetRange, presets, rangeProblem } from "./range";
import { reportQuery } from "./reportData";
import { TaskReport } from "./TaskReport";

const NO_ROWS: ReportRow[] = [];
const fieldClass = "h-10 rounded-[9px] border border-line2 bg-panel px-3 text-[13.5px] text-ink";

export function Reports() {
  const { profile } = useRouteContext({ from: "/_app" });
  const startDay = useQuery(weekStartQuery);
  const today = DateTime.now().setZone(profile.timezone).toISODate() ?? "";
  const [picked, setPicked] = useState<DateRange | null>(null);
  const range = picked ?? presetRange("this-week", today, startDay.data ?? 1);
  // The team filter (DSH-07, #202): the teams the viewer can read.
  const [teamId, setTeamId] = useState("");
  const teams = useQuery(teamsQuery);
  // By person (the default) or by project and task (#269).
  const [groupBy, setGroupBy] = useState<"person" | "task">("person");

  const problem = rangeProblem(range);
  const report = useQuery({
    ...reportQuery(range.from, range.to, teamId),
    enabled: startDay.isSuccess && problem === null && groupBy === "person",
  });
  const rows = report.data?.rows;
  const totals = useMemo(
    () => (rows ? teamTotals(rows, report.data?.teamMedianResponseMs ?? null) : null),
    [rows, report.data?.teamMedianResponseMs],
  );
  const table = useReportTable(rows ?? NO_ROWS);
  // Everyone in the table's order (sorting runs before the page is cut), for the charts.
  const sortedRows = table.getPrePaginatedRowModel().rows.map((r) => r.original);
  const sort = table.state.sorting[0];
  const active = presetOf(range, today, startDay.data ?? 1);

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.025em]">Reports</h1>
        <p className="mt-1 text-[13.5px] text-ink2">{profile.orgName}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <fieldset className="m-0 flex gap-2 border-0 p-0">
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
          <Label htmlFor="report-from">From</Label>
          <Input
            id="report-from"
            type="date"
            className="h-10 w-auto text-[13.5px]"
            value={range.from}
            onChange={(e) => setPicked({ ...range, from: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="report-to">To</Label>
          <Input
            id="report-to"
            type="date"
            className="h-10 w-auto text-[13.5px]"
            value={range.to}
            onChange={(e) => setPicked({ ...range, to: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="report-team">Team</Label>
          <select
            id="report-team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className={fieldClass}
          >
            <option value="">Everyone I can see</option>
            {(teams.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="report-group">Group by</Label>
          <select
            id="report-group"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value === "task" ? "task" : "person")}
            className={fieldClass}
          >
            <option value="person">Person</option>
            <option value="task">Project and task</option>
          </select>
        </div>
      </div>

      {problem ? (
        <p role="alert" className="text-sm text-warnink">
          {problem}
        </p>
      ) : groupBy === "task" ? (
        <TaskReport from={range.from} to={range.to} teamId={teamId} />
      ) : report.error ? (
        <p role="alert" className="text-sm text-warnink">
          Couldn't load the report: {report.error.message}
        </p>
      ) : !rows || !totals ? (
        <p className="text-sm text-ink2">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-line bg-panel px-6 py-16 text-center">
          <p className="text-base font-semibold">No one to report on</p>
          <p className="max-w-[380px] text-[13.5px] text-ink2">
            There are no people in this team for these dates. Try another team or range.
          </p>
        </div>
      ) : (
        <>
          <dl
            aria-label="Team totals"
            className="grid grid-cols-2 gap-3 rounded-xl border border-line bg-panel p-4 md:grid-cols-4 md:p-5"
          >
            <Tile label="Worked" value={formatDuration(totals.workedS)} />
            <Tile label="Flagged" value={formatDuration(totals.flaggedS)} />
            <Tile
              label="Response rate"
              value={formatRate(totals.responseRate)}
              note={`${totals.checkinsPassed} of ${totals.checkinsShown} shown check-ins passed`}
            />
            <Tile label="Median response" value={formatResponse(totals.medianResponseMs)} />
            <Tile
              label="Check-ins"
              value={String(totals.checkinsShown)}
              note={`${totals.checkinsPassed} passed, ${totals.checkinsMissed} missed, ${totals.checkinsFailed} failed`}
            />
            <Tile label="Breaks" value={formatDuration(totals.breakS)} />
            <Tile label="Pauses" value={formatDuration(totals.pauseS)} />
            <Tile label="Late clock-ins" value={String(totals.lateClockIns)} />
          </dl>

          <ReportCharts
            rows={sortedRows}
            note={chartNote(
              Math.min(CHART_PEOPLE, sortedRows.length),
              sortedRows.length,
              sort,
              columnTitle(sort?.id ?? ""),
            )}
          />

          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            <ReportTable
              table={table}
              totals={totals}
              caption={`Hours and check-ins per person, ${range.from} to ${range.to}`}
            />
          </div>
          <p className="text-[12.5px] text-ink3">
            Worked and flagged time match the timesheets for the same days; time a manager excluded
            is in neither. Response rate is passed over shown check-ins, so deferred ones don't
            count. A clock-in is late when it comes more than {report.data?.lateGraceMin} minutes
            after a shift starts.
          </p>
        </>
      )}
    </section>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-ink3">{label}</dt>
      <dd className="m-0 font-mono text-xl font-semibold">{value}</dd>
      {note && <dd className="m-0 text-[12.5px] text-ink3">{note}</dd>}
    </div>
  );
}
