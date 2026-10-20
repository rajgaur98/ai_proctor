// The report's two charts (DSH-07, Recharts): worked and flagged time per person, and
// check-in outcomes per person. Both are a picture of numbers the table below lists in
// full, so each is one labelled image with a sentence for screen readers; the chart's
// own focusable layer is off so it doesn't trap the keyboard.
import type { ReportRow } from "@ai-proctor/core";
import type { ReactElement } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDuration } from "../timesheets/summary";

/** Charts stay readable up to this many people; the table lists everyone. */
export const CHART_PEOPLE = 25;

const axis = { fill: "var(--ink3)", fontSize: 12 };
const tooltipStyle = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 9,
  color: "var(--ink)",
  fontSize: 13,
};

function ChartCard({
  title,
  summary,
  note,
  height,
  children,
}: {
  title: string;
  summary: string;
  note: string | null;
  height: number;
  children: ReactElement;
}) {
  return (
    <figure className="m-0 flex flex-col gap-2 rounded-xl border border-line bg-panel p-4 md:p-5">
      <figcaption>
        <span className="text-[13.5px] font-semibold">{title}</span>
        {note && <span className="ml-2 text-[12.5px] text-ink3">{note}</span>}
      </figcaption>
      <div role="img" aria-label={`${title}. ${summary}`} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function sentence(rows: ReportRow[], part: (r: ReportRow) => string): string {
  return `${rows.map((r) => `${r.fullName}: ${part(r)}`).join("; ")}. The table below lists every number.`;
}

export function ReportCharts({ rows }: { rows: ReportRow[] }) {
  // The most time first, so a long team keeps its busiest people in view.
  const people = [...rows].sort((a, b) => b.workedS - a.workedS).slice(0, CHART_PEOPLE);
  const note =
    rows.length > people.length ? `Top ${people.length} of ${rows.length} by worked time` : null;
  const height = Math.max(180, people.length * 44 + 70);

  const time = people.map((r) => ({
    name: r.fullName,
    worked: r.workedS / 3600,
    flagged: r.flaggedS / 3600,
  }));
  const outcomes = people.map((r) => ({
    name: r.fullName,
    passed: r.checkinsPassed,
    missed: r.checkinsMissed,
    failed: r.checkinsFailed,
  }));

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard
        title="Worked and flagged time"
        summary={sentence(
          people,
          (r) => `${formatDuration(r.workedS)} worked, ${formatDuration(r.flaggedS)} flagged`,
        )}
        note={note}
        height={height}
      >
        <BarChart
          data={time}
          layout="vertical"
          accessibilityLayer={false}
          margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
        >
          <CartesianGrid horizontal={false} stroke="var(--line)" />
          <XAxis
            type="number"
            tick={axis}
            tickFormatter={(h: number) => `${Math.round(h * 10) / 10} h`}
            stroke="var(--line2)"
          />
          <YAxis type="category" dataKey="name" width={120} tick={axis} stroke="var(--line2)" />
          <Tooltip
            cursor={{ fill: "var(--sunk)" }}
            contentStyle={tooltipStyle}
            formatter={(h) => formatDuration(Math.round(Number(h) * 3600))}
          />
          <Legend wrapperStyle={{ fontSize: 13, color: "var(--ink2)" }} />
          <Bar dataKey="worked" name="Worked" fill="var(--acc)" radius={[0, 3, 3, 0]} />
          <Bar dataKey="flagged" name="Flagged" fill="var(--saway)" radius={[0, 3, 3, 0]} />
        </BarChart>
      </ChartCard>
      <ChartCard
        title="Check-in outcomes"
        summary={sentence(
          people,
          (r) =>
            `${r.checkinsPassed} passed, ${r.checkinsMissed} missed, ${r.checkinsFailed} failed`,
        )}
        note={note}
        height={height}
      >
        <BarChart
          data={outcomes}
          layout="vertical"
          accessibilityLayer={false}
          margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
        >
          <CartesianGrid horizontal={false} stroke="var(--line)" />
          <XAxis type="number" allowDecimals={false} tick={axis} stroke="var(--line2)" />
          <YAxis type="category" dataKey="name" width={120} tick={axis} stroke="var(--line2)" />
          <Tooltip cursor={{ fill: "var(--sunk)" }} contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 13, color: "var(--ink2)" }} />
          <Bar dataKey="passed" name="Passed" stackId="outcome" fill="var(--sactive)" />
          <Bar dataKey="missed" name="Missed" stackId="outcome" fill="var(--saway)" />
          <Bar dataKey="failed" name="Failed" stackId="outcome" fill="var(--stamper)" />
        </BarChart>
      </ChartCard>
    </div>
  );
}
