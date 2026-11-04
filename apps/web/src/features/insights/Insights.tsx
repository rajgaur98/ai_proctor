// The Insights page (#305, INS-01..04): attendance, presence, time, projects and what
// needs review for a date range, each against the previous range of the same length.
// Managers see their reports (and those they stand in for as a delegate), owners and
// admins the org: the database decides (can_view_user). Filters: date range, team
// (ORG-08) and person. One call to `insights` per filter change; the numbers are the
// Reports tab's for the same filters (INS-04). Export (TS-27/28) offers the summary, the
// people, the trend, the projects and the days to review, each audit-logged.
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useState } from "react";
import { ExportButton } from "../../components/ExportButton";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { cn } from "../../lib/cn";
import {
  type DateRange,
  presetLabel,
  presetOf,
  presetRange,
  presets,
  rangeProblem,
} from "../reports/range";
import { teamsQuery } from "../teams/teamData";
import { weekStartQuery } from "../timesheets/timesheetData";
import { InsightsView } from "./InsightsView";
import { insightsQuery } from "./insightsData";
import {
  bucketLabel,
  peopleTable,
  projectsTable,
  reviewTable,
  summaryTable,
  trendTable,
} from "./model";

const fieldClass = "h-10 rounded-[9px] border border-line2 bg-panel px-3 text-[13.5px] text-ink";

export function Insights() {
  const { profile } = useRouteContext({ from: "/_app" });
  const startDay = useQuery(weekStartQuery);
  const today = DateTime.now().setZone(profile.timezone).toISODate() ?? "";
  const [picked, setPicked] = useState<DateRange | null>(null);
  const range = picked ?? presetRange("this-week", today, startDay.data ?? 1);
  const [teamId, setTeamId] = useState("");
  const [personId, setPersonId] = useState("");
  const teams = useQuery(teamsQuery);
  const problem = rangeProblem(range);
  const insights = useQuery({
    ...insightsQuery(range.from, range.to, teamId, personId ? [personId] : []),
    enabled: startDay.isSuccess && problem === null,
    placeholderData: (previous) => previous,
  });
  const data = insights.data;
  const active = presetOf(range, today, startDay.data ?? 1);
  const teamName = teamId ? (teams.data?.find((t) => t.id === teamId)?.name ?? teamId) : "";
  const personName = personId
    ? (data?.options.find((o) => o.userId === personId)?.fullName ?? personId)
    : "";
  const filters = { from: range.from, to: range.to, team: teamName, person: personName };
  const ready = !!data && !insights.isPlaceholderData && problem === null;
  // The tables the export offers, from what the page shows (TS-28).
  const need = () => {
    if (!data) throw new Error("Insights are still loading.");
    return data;
  };

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div className="max-w-[640px]">
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">Insights</h1>
          <p className="mt-1 text-[13.5px] text-ink2">
            {profile.orgName} · totals and trends of attendance, check-ins and time. No scores or
            rankings.
          </p>
        </div>
        <ExportButton
          title="Insights"
          className="ml-auto"
          ready={ready}
          choices={[
            {
              label: "Summary",
              spec: { page: "insights-summary", filters, table: () => summaryTable(need()) },
            },
            {
              label: "People",
              spec: { page: "insights-people", filters, table: () => peopleTable(need().people) },
            },
            {
              label: "Trend",
              spec: { page: "insights-trend", filters, table: () => trendTable(need()) },
            },
            {
              label: "Projects",
              spec: { page: "insights-projects", filters, table: () => projectsTable(need()) },
            },
            {
              label: "Days to review",
              spec: {
                page: "insights-review",
                filters,
                table: () => reviewTable(need().reviewDays),
              },
            },
          ]}
        />
      </div>

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
          <Label htmlFor="insights-from">From</Label>
          <Input
            id="insights-from"
            type="date"
            className="h-10 w-auto text-[13.5px]"
            value={range.from}
            onChange={(e) => setPicked({ ...range, from: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="insights-to">To</Label>
          <Input
            id="insights-to"
            type="date"
            className="h-10 w-auto text-[13.5px]"
            value={range.to}
            onChange={(e) => setPicked({ ...range, to: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="insights-team">Team</Label>
          <select
            id="insights-team"
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
              setPersonId("");
            }}
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
          <Label htmlFor="insights-person">Person</Label>
          <select
            id="insights-person"
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
            className={fieldClass}
          >
            <option value="">Everyone</option>
            {(data?.options ?? []).map((o) => (
              <option key={o.userId} value={o.userId}>
                {o.fullName}
                {o.active ? "" : " (deactivated)"}
              </option>
            ))}
          </select>
        </div>
      </div>

      {problem ? (
        <p role="alert" className="text-sm text-warnink">
          {problem}
        </p>
      ) : insights.error ? (
        <p role="alert" className="text-sm text-warnink">
          Couldn't load insights: {insights.error.message}
        </p>
      ) : !data ? (
        <p className="text-sm text-ink2">Loading…</p>
      ) : data.people.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-line bg-panel px-6 py-16 text-center">
          <p className="text-base font-semibold">No one to show</p>
          <p className="max-w-[380px] text-[13.5px] text-ink2">
            There are no people in this view for these dates. Try another team, person or range.
          </p>
        </div>
      ) : (
        <>
          <p aria-live="polite" className="text-[13px] text-ink2">
            {data.people.length === 1 ? "1 person" : `${data.people.length} people`},{" "}
            {bucketLabel(data.from, "day", data.to)} to {bucketLabel(data.to, "day", data.to)},
            compared with {bucketLabel(data.previousFrom, "day", data.previousTo)} to{" "}
            {bucketLabel(data.previousTo, "day", data.previousTo)}.
            {insights.isFetching ? " Updating…" : ""}
          </p>
          <InsightsView data={data} />
        </>
      )}
    </section>
  );
}
