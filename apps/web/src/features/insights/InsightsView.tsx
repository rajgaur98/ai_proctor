// What the Insights page shows for a range (#305, INS-01..05): attendance, presence, time,
// projects and what needs review, each number with its change from the previous range of
// the same length, then the people by name. The same view is an employee's own Insights
// in My data (`self`), without the people and team tables. Plain totals and trends: no
// score, no ranking, no top or bottom list, and changes are neutral (INS-03).
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { formatRate, formatResponse } from "../reports/format";
import { DEFAULT_PAGE_SIZE, needsPager, pageCount, pageWindow } from "../reports/paging";
import { formatDuration } from "../timesheets/summary";
import { BucketBars, BucketLine, SERIES_COLOURS } from "./InsightsCharts";
import {
  bucketLabel,
  type Insights,
  type Kind,
  type ProjectLevel,
  projectChart,
  projectNames,
  share,
  type Totals,
  type Trend,
  trend,
} from "./model";

const fieldClass = "h-10 rounded-[9px] border border-line2 bg-panel px-3 text-[13.5px] text-ink";
const card = "rounded-xl border border-line bg-panel";
const tiles = `${card} grid grid-cols-2 gap-3 p-4 md:grid-cols-4 md:p-5`;
const charts = "grid gap-4 xl:grid-cols-2";

function Tile({
  label,
  value,
  note,
  change,
}: {
  label: string;
  value: string;
  note?: string;
  change?: Trend;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-ink3">{label}</dt>
      <dd className="m-0 font-mono text-xl font-semibold">{value}</dd>
      {change && (
        <dd className="m-0 text-[12.5px] text-ink2">
          {change.direction === "none"
            ? "No change to show"
            : change.direction === "same"
              ? "Same as the previous period"
              : `${change.text} on the previous period`}
        </dd>
      )}
      {note && <dd className="m-0 text-[12.5px] text-ink3">{note}</dd>}
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-[15px] font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function InsightsView({ data, self = false }: { data: Insights; self?: boolean }) {
  const t = data.totals;
  const p = data.previous;
  const change = (key: (x: Totals) => number | null, kind: Kind) => trend(key(t), key(p), kind);
  const rows = data.series;
  const range = { bucket: data.bucket, to: data.to };
  const per = data.bucket === "week" ? "Per week" : "Per day";
  const span = `${per}, ${bucketLabel(data.from, "day", data.to)} to ${bucketLabel(data.to, "day", data.to)}`;
  const deferredShare = share(t.checkins_deferred, t.checkins_shown + t.checkins_deferred);
  const prevDeferredShare = share(p.checkins_deferred, p.checkins_shown + p.checkins_deferred);
  const billable = share(t.billable_s, t.worked_s);
  const target = data.billableTargetPct;
  const caps = data.caps;
  const ot = data.overtime;

  return (
    <div className="flex flex-col gap-6">
      <Section id="ins-attendance" title="Attendance">
        <dl aria-label="Attendance totals" className={tiles}>
          <Tile
            label="On time"
            value={`${t.on_time} of ${t.shift_days}`}
            note="Shift days with a clock-in by the late grace"
            change={change((x) => x.on_time, "count")}
          />
          <Tile
            label="Late clock-ins"
            value={String(t.late_clock_ins)}
            note={`More than ${data.lateGraceMin} min after the shift starts`}
            change={change((x) => x.late_clock_ins, "count")}
          />
          <Tile
            label="Shift days without a clock-in"
            value={String(t.no_clock_in)}
            note={`${plural(t.leave_shift_days, "shift day")} on leave or a holiday, not counted`}
            change={change((x) => x.no_clock_in, "count")}
          />
          <Tile
            label="Worked vs scheduled"
            value={formatDuration(t.worked_s)}
            note={`of ${formatDuration(t.scheduled_s)} scheduled (${formatRate(share(t.worked_s, t.scheduled_s))}) · ${formatDuration(t.leave_s)} leave`}
            change={change((x) => x.worked_s, "duration")}
          />
        </dl>
        <div className={charts}>
          <BucketBars
            title="Shift days"
            summary={`${span}. In all: ${t.on_time} on time, ${t.late_clock_ins} late, ${t.no_clock_in} without a clock-in.`}
            rows={rows}
            series={[
              { key: "on_time", name: "On time", colour: "var(--sactive)" },
              { key: "late_clock_ins", name: "Late", colour: "var(--sidle)" },
              { key: "no_clock_in", name: "No clock-in", colour: "var(--soffline)" },
            ]}
            unit="count"
            {...range}
          />
          <BucketBars
            title="Worked, leave and scheduled hours"
            summary={`${span}. In all: ${formatDuration(t.worked_s)} worked and ${formatDuration(t.leave_s)} leave, of ${formatDuration(t.scheduled_s)} scheduled.`}
            rows={rows.map((r) => ({
              bucket: r.bucket,
              worked: r.worked_s / 3600,
              leave: r.leave_s / 3600,
              scheduled: r.scheduled_s / 3600,
            }))}
            series={[
              { key: "worked", name: "Worked", colour: "var(--acc)" },
              { key: "leave", name: "Leave", colour: "var(--sbreak)" },
              { key: "scheduled", name: "Scheduled", colour: "var(--spaused)" },
            ]}
            unit="hours"
            stacked={false}
            {...range}
          />
        </div>
      </Section>

      <Section id="ins-presence" title="Presence">
        <dl aria-label="Presence totals" className={tiles}>
          <Tile
            label="Response rate"
            value={formatRate(t.response_rate)}
            note={`${t.checkins_passed} of ${t.checkins_shown} shown check-ins passed`}
            change={change((x) => x.response_rate, "rate")}
          />
          <Tile
            label="Median response"
            value={formatResponse(t.median_response_ms)}
            change={change((x) => x.median_response_ms, "ms")}
          />
          <Tile
            label="Missed check-ins"
            value={String(t.checkins_missed)}
            note={`${t.checkins_failed} failed`}
            change={change((x) => x.checkins_missed, "count")}
          />
          <Tile
            label="Deferred"
            value={formatRate(deferredShare)}
            note={`${t.deferred_call} for a call, ${t.deferred_presenting} while presenting`}
            change={trend(deferredShare, prevDeferredShare, "rate")}
          />
        </dl>
        <div className={charts}>
          <BucketLine
            title="Response rate"
            summary={`${span}. ${formatRate(t.response_rate)} over the range.`}
            rows={rows}
            dataKey="response_rate"
            name="Response rate"
            colour="var(--acc)"
            unit="percent"
            {...range}
          />
          <BucketLine
            title="Median response time"
            summary={`${span}. ${formatResponse(t.median_response_ms)} over the range.`}
            rows={rows}
            dataKey="median_response_ms"
            name="Median response"
            colour="var(--smeeting)"
            unit="seconds"
            {...range}
          />
          <BucketBars
            title="Check-in outcomes"
            summary={`${span}. In all: ${t.checkins_passed} passed, ${t.checkins_missed} missed, ${t.checkins_failed} failed, ${t.checkins_deferred} deferred.`}
            rows={rows}
            series={[
              { key: "checkins_passed", name: "Passed", colour: "var(--sactive)" },
              { key: "checkins_missed", name: "Missed", colour: "var(--saway)" },
              { key: "checkins_failed", name: "Failed", colour: "var(--stamper)" },
              { key: "checkins_deferred", name: "Deferred", colour: "var(--sbreak)" },
            ]}
            unit="count"
            {...range}
          />
          <div className={`${card} flex flex-col gap-2 p-4`}>
            <h3 className="text-[13.5px] font-semibold">Misses by reason</h3>
            <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[13.5px]">
              {(
                [
                  ["Meeting", t.miss_meeting],
                  ["Phone call", t.miss_phone_call],
                  ["Break", t.miss_break],
                  ["Away from desk", t.miss_away],
                  ["Other", t.miss_other],
                  ["No reason given", t.miss_none],
                ] as const
              ).map(([label, n]) => (
                <div key={label} className="contents">
                  <dt className="text-ink2">{label}</dt>
                  <dd className="m-0 text-right font-mono tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[12.5px] text-ink3">
              The reason the person added to each miss. Deferred check-ins were held back during a
              call or while presenting and are not counted as shown.
            </p>
          </div>
        </div>
      </Section>

      <Section id="ins-time" title="Time">
        <dl aria-label="Time totals" className={tiles}>
          <Tile
            label="Worked"
            value={formatDuration(t.worked_s)}
            change={change((x) => x.worked_s, "duration")}
          />
          <Tile
            label="Flagged"
            value={formatDuration(t.flagged_s)}
            change={change((x) => x.flagged_s, "duration")}
          />
          <Tile
            label="Excluded"
            value={formatDuration(t.excluded_s)}
            note="Time a manager excluded"
            change={change((x) => x.excluded_s, "duration")}
          />
          <Tile
            label="Billable share"
            value={formatRate(billable)}
            note={`${formatDuration(t.billable_s)} of ${formatDuration(t.worked_s)} worked${target ? ` · target ${target}%` : ""}`}
            change={trend(billable, share(p.billable_s, p.worked_s), "rate")}
          />
          <Tile
            label="Breaks"
            value={formatDuration(t.break_s)}
            note={
              caps.breakDailyMaxMin
                ? `${plural(t.break_days_over_cap, "day")} over the ${caps.breakDailyMaxMin} min daily cap`
                : "No daily break cap"
            }
            change={change((x) => x.break_s, "duration")}
          />
          <Tile
            label="Pauses"
            value={formatDuration(t.pause_s)}
            note={`${formatDuration(t.pause_over_cap_s)} over the cap${
              caps.pauseDailyMaxMin
                ? ` · ${plural(t.pause_days_over_cap, "day")} over ${caps.pauseDailyMaxMin} min`
                : ""
            }`}
            change={change((x) => x.pause_s, "duration")}
          />
          {ot.dailyHours === null && ot.weeklyHours === null ? (
            <Tile label="Overtime" value="Off" note="No overtime thresholds are set" />
          ) : (
            <>
              {ot.dailyHours !== null && (
                <Tile
                  label={`Over ${ot.dailyHours} h a day`}
                  value={formatDuration(t.overtime_daily_s)}
                  note={plural(t.overtime_days, "day")}
                  change={change((x) => x.overtime_daily_s, "duration")}
                />
              )}
              {ot.weeklyHours !== null && (
                <Tile
                  label={`Over ${ot.weeklyHours} h a week`}
                  value={formatDuration(t.overtime_weekly_s)}
                  note={plural(t.overtime_weeks, "week")}
                  change={change((x) => x.overtime_weekly_s, "duration")}
                />
              )}
            </>
          )}
        </dl>
        <div className={charts}>
          <BucketBars
            title="Worked, flagged and excluded"
            summary={`${span}. In all: ${formatDuration(t.worked_s)} worked, ${formatDuration(t.flagged_s)} flagged, ${formatDuration(t.excluded_s)} excluded.`}
            rows={rows.map((r) => ({
              bucket: r.bucket,
              worked: r.worked_s / 3600,
              flagged: r.flagged_s / 3600,
              excluded: r.excluded_s / 3600,
            }))}
            series={[
              { key: "worked", name: "Worked", colour: "var(--acc)" },
              { key: "flagged", name: "Flagged", colour: "var(--saway)" },
              { key: "excluded", name: "Excluded", colour: "var(--soffline)" },
            ]}
            unit="hours"
            stacked={false}
            {...range}
          />
          <BucketBars
            title="Breaks and pauses"
            summary={`${span}. In all: ${formatDuration(t.break_s)} of breaks, ${formatDuration(t.pause_s)} of pauses, ${formatDuration(t.pause_over_cap_s)} of it over the cap.`}
            rows={rows.map((r) => ({
              bucket: r.bucket,
              breaks: r.break_s / 3600,
              pauses: (r.pause_s - r.pause_over_cap_s) / 3600,
              over: r.pause_over_cap_s / 3600,
            }))}
            series={[
              { key: "breaks", name: "Breaks", colour: "var(--sbreak)" },
              { key: "pauses", name: "Pauses", colour: "var(--spaused)" },
              { key: "over", name: "Pause over cap", colour: "var(--saway)" },
            ]}
            unit="hours"
            {...range}
          />
          <BucketLine
            title="Billable share of worked time"
            summary={`${span}. ${formatRate(billable)} over the range${target ? `, against a target of ${target}%` : ""}.`}
            rows={rows.map((r) => ({ bucket: r.bucket, share: share(r.billable_s, r.worked_s) }))}
            dataKey="share"
            name="Billable share"
            colour="var(--acc)"
            unit="percent"
            target={target ? { value: target / 100, label: `Target ${target}%` } : null}
            {...range}
          />
          {!self && data.teams.length > 0 && <TeamShares data={data} />}
        </div>
      </Section>

      <ProjectsSection data={data} span={span} />

      <ReviewSection data={data} self={self} span={span} />

      {!self && <PeopleSection data={data} />}
    </div>
  );
}

function TeamShares({ data }: { data: Insights }) {
  return (
    <div className={`${card} overflow-hidden`}>
      <table className="w-full border-collapse text-[13.5px]">
        <caption className="px-4 pt-4 text-left text-[13.5px] font-semibold">
          Billable share by team
        </caption>
        <thead className="text-left text-xs text-ink3">
          <tr className="h-9 border-b border-line">
            <th scope="col" className="px-4 font-medium">
              Team
            </th>
            <th scope="col" className="px-2 text-right font-medium">
              Billable share
            </th>
            <th scope="col" className="px-4 text-right font-medium">
              Target
            </th>
          </tr>
        </thead>
        <tbody>
          {data.teams.map((team) => (
            <tr key={team.team_id} className="h-10 border-b border-line last:border-0">
              <th scope="row" className="px-4 text-left font-medium">
                {team.name}
              </th>
              <td className="px-2 text-right font-mono tabular-nums">
                {formatRate(share(team.billable_s, team.worked_s))}
              </td>
              <td className="px-4 text-right font-mono tabular-nums">
                {team.billable_target_pct ? `${team.billable_target_pct}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-3 text-[12.5px] text-ink3">
        Billable is worked time on a billable task, else on a billable project. A team has a target
        only when an admin sets one.
      </p>
    </div>
  );
}

function ProjectsSection({ data, span }: { data: Insights; span: string }) {
  const [level, setLevel] = useState<ProjectLevel>("project");
  const t = data.totals;
  const chart = projectChart(
    data.series.map((s) => s.bucket),
    data.projectSeries,
    data.projects,
    level,
  );
  const range = { bucket: data.bucket, to: data.to };
  const levelName = { client: "client", project: "project", task: "task" }[level];
  return (
    <Section id="ins-projects" title="Projects">
      <dl aria-label="Project totals" className={tiles}>
        <Tile
          label="Unassigned share"
          value={formatRate(share(t.unassigned_s, t.worked_s))}
          note={`${formatDuration(t.unassigned_s)} worked without a project`}
          change={trend(
            share(t.unassigned_s, t.worked_s),
            share(data.previous.unassigned_s, data.previous.worked_s),
            "rate",
          )}
        />
        <Tile
          label="Projects"
          value={String(
            new Set(data.projects.filter((x) => x.project_id).map((x) => x.project_id)).size,
          )}
          note="With worked time in the range"
        />
      </dl>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ins-project-level">Hours by</Label>
          <select
            id="ins-project-level"
            value={level}
            onChange={(e) => setLevel(e.target.value as ProjectLevel)}
            className={fieldClass}
          >
            <option value="client">Client</option>
            <option value="project">Project</option>
            <option value="task">Task</option>
          </select>
        </div>
      </div>
      <div className={charts}>
        <BucketBars
          title={`Hours by ${levelName}`}
          summary={`${span}. ${chart.groups.length === 0 ? "No worked time." : `${chart.groups.map((g) => g.label).join(", ")}. The table lists the hours.`}`}
          rows={chart.rows}
          series={chart.groups.map((g, i) => ({
            key: g.key,
            name: g.label,
            colour:
              g.key === "unassigned"
                ? "var(--soff)"
                : g.key === "other"
                  ? "var(--line2)"
                  : (SERIES_COLOURS[i % SERIES_COLOURS.length] ?? "var(--acc)"),
          }))}
          unit="hours"
          {...range}
        />
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full border-collapse text-[13.5px]">
            <caption className="px-4 pt-4 text-left text-[13.5px] font-semibold">
              Hours by client, project and task
            </caption>
            <thead className="text-left text-xs text-ink3">
              <tr className="h-9 border-b border-line">
                <th scope="col" className="px-4 font-medium">
                  Project
                </th>
                <th scope="col" className="px-2 font-medium">
                  Task
                </th>
                <th scope="col" className="px-2 text-right font-medium">
                  Worked
                </th>
                <th scope="col" className="px-4 text-right font-medium">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {data.projects.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-ink2">
                    No worked time in this range.
                  </td>
                </tr>
              ) : (
                data.projects.map((row) => {
                  const n = projectNames(row);
                  return (
                    <tr
                      key={`${row.project_id}/${row.task_id}`}
                      className="h-10 border-b border-line last:border-0"
                    >
                      <th scope="row" className="px-4 text-left font-medium">
                        {n.project}
                        {n.client && <span className="font-normal text-ink3"> · {n.client}</span>}
                        {row.billable && <span className="font-normal text-ink3"> · billable</span>}
                      </th>
                      <td className="px-2 text-ink2">{n.task}</td>
                      <td className="px-2 text-right font-mono tabular-nums">
                        {formatDuration(row.worked_s)}
                      </td>
                      <td className="px-4 text-right font-mono tabular-nums">
                        {formatRate(share(row.worked_s, t.worked_s))}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}

function ReviewSection({ data, self, span }: { data: Insights; self: boolean; span: string }) {
  const t = data.totals;
  const p = data.previous;
  const range = { bucket: data.bucket, to: data.to };
  return (
    <Section id="ins-review" title="Needs review">
      <dl aria-label="Needs review totals" className={tiles}>
        <Tile
          label="Anti-cheat flags"
          value={String(t.anomaly_flags)}
          note={`${t.needs_review} not reviewed yet`}
          change={trend(t.anomaly_flags, p.anomaly_flags, "count")}
        />
        <Tile
          label="Tamper"
          value={String(t.tamper)}
          note="Times the app was stopped or blocked"
          change={trend(t.tamper, p.tamper, "count")}
        />
      </dl>
      <div className={charts}>
        <BucketBars
          title="Flags and Tamper"
          summary={`${span}. In all: ${t.anomaly_flags} anti-cheat flags and ${t.tamper} Tamper.`}
          rows={data.series}
          series={[
            { key: "anomaly_flags", name: "Anti-cheat flags", colour: "var(--saway)" },
            { key: "tamper", name: "Tamper", colour: "var(--stamper)" },
          ]}
          unit="count"
          {...range}
        />
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full border-collapse text-[13.5px]">
            <caption className="px-4 pt-4 text-left text-[13.5px] font-semibold">
              Days to review
            </caption>
            <thead className="text-left text-xs text-ink3">
              <tr className="h-9 border-b border-line">
                <th scope="col" className="px-4 font-medium">
                  Day
                </th>
                {!self && (
                  <th scope="col" className="px-2 font-medium">
                    Person
                  </th>
                )}
                <th scope="col" className="px-2 text-right font-medium">
                  Flags
                </th>
                <th scope="col" className="px-4 text-right font-medium">
                  Tamper
                </th>
              </tr>
            </thead>
            <tbody>
              {data.reviewDays.length === 0 ? (
                <tr>
                  <td colSpan={self ? 3 : 4} className="px-4 py-4 text-ink2">
                    Nothing to review in this range.
                  </td>
                </tr>
              ) : (
                data.reviewDays.map((d) => {
                  const label = `${bucketLabel(d.day, "day", d.day)}${self ? "" : `, ${d.full_name}`}`;
                  return (
                    <tr
                      key={`${d.user_id}/${d.day}`}
                      className="h-10 border-b border-line last:border-0"
                    >
                      <th scope="row" className="px-4 text-left font-medium">
                        {self ? (
                          <Link
                            to="/me"
                            search={{ date: d.day }}
                            className="text-acctext underline"
                          >
                            <span className="sr-only">Open the day </span>
                            {bucketLabel(d.day, "day", d.day)}
                          </Link>
                        ) : (
                          <Link
                            to="/team/$userId"
                            params={{ userId: d.user_id }}
                            search={{ date: d.day }}
                            className="text-acctext underline"
                            aria-label={`Open the day: ${label}`}
                          >
                            {bucketLabel(d.day, "day", d.day)}
                          </Link>
                        )}
                      </th>
                      {!self && <td className="px-2">{d.full_name}</td>}
                      <td className="px-2 text-right font-mono tabular-nums">
                        {d.anomaly_flags}
                        {d.needs_review > 0 && (
                          <span className="text-ink3"> ({d.needs_review} to review)</span>
                        )}
                      </td>
                      <td className="px-4 text-right font-mono tabular-nums">{d.tamper}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {data.reviewDaysTotal > data.reviewDays.length && (
            <p className="px-4 py-3 text-[12.5px] text-ink3">
              Showing the newest {data.reviewDays.length} of {data.reviewDaysTotal} days. Narrow the
              range to see the rest.
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}

function PeopleSection({ data }: { data: Insights }) {
  const [page, setPage] = useState(0);
  const total = data.people.length;
  const size = DEFAULT_PAGE_SIZE;
  const pages = pageCount(total, size);
  const index = Math.min(page, pages - 1);
  const shown = data.people.slice(index * size, (index + 1) * size);
  const win = pageWindow(index, total, size);
  const headers = [
    "Worked",
    "Leave",
    "Scheduled",
    "On time",
    "Late",
    "No clock-in",
    "Response rate",
    "Median response",
    "Missed",
    "Flagged",
    "Billable share",
    "Needs review",
  ];
  return (
    <Section id="ins-people" title="People">
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full border-collapse text-[13.5px]">
          <caption className="sr-only">
            Each person's numbers for {data.from} to {data.to}, by name
          </caption>
          <thead className="bg-sunk text-left text-xs text-ink3">
            <tr className="h-10 border-b border-line">
              <th scope="col" className="px-4 font-medium">
                Person
              </th>
              {headers.map((h) => (
                <th key={h} scope="col" className="whitespace-nowrap px-2 text-right font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={headers.length + 1} className="px-4 py-4 text-ink2">
                  No one in this view.
                </td>
              </tr>
            ) : (
              shown.map((r) => (
                <tr key={r.user_id} className="h-11 border-b border-line last:border-0">
                  <th scope="row" className="whitespace-nowrap px-4 text-left font-medium">
                    {r.full_name}
                    {!r.active && <span className="font-normal text-ink3"> · deactivated</span>}
                  </th>
                  {[
                    formatDuration(r.worked_s),
                    formatDuration(r.leave_s),
                    formatDuration(r.scheduled_s),
                    `${r.on_time} of ${r.shift_days}`,
                    String(r.late_clock_ins),
                    String(r.no_clock_in),
                    formatRate(r.response_rate),
                    formatResponse(r.median_response_ms),
                    String(r.checkins_missed),
                    formatDuration(r.flagged_s),
                    formatRate(share(r.billable_s, r.worked_s)),
                    String(r.needs_review),
                  ].map((v, i) => (
                    <td
                      key={headers[i]}
                      className="whitespace-nowrap px-2 text-right font-mono tabular-nums"
                    >
                      {v}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {needsPager(total) && (
        <nav aria-label="People pages" className="flex flex-wrap items-center gap-3 text-[13px]">
          <span className="text-ink2">
            Showing {win.first} to {win.last} of {total}
          </span>
          <Button
            variant="secondary"
            className="ml-auto h-9"
            disabled={index === 0}
            onClick={() => setPage(index - 1)}
          >
            Previous
          </Button>
          <span>
            Page {index + 1} of {pages}
          </span>
          <Button
            variant="secondary"
            className="h-9"
            disabled={index >= pages - 1}
            onClick={() => setPage(index + 1)}
          >
            Next
          </Button>
        </nav>
      )}
      <p className="text-[12.5px] text-ink3">
        Listed by name. There is no score or ranking: each number is a plain total for the range,
        the same as Reports and the timesheets for the same days.
      </p>
    </Section>
  );
}
