// The Insights charts (#305, INS-01/02; Recharts, the report charts' look and tokens).
// Each is one labelled image with a sentence for screen readers that gives the range's
// totals; the export's Trend table lists every bucket. The charts' own focusable layer
// is off so they don't trap the keyboard. Colours are the status tokens, no new ones.
import type { ReactElement } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDuration } from "../timesheets/summary";
import { bucketLabel } from "./model";

const axis = { fill: "var(--ink3)", fontSize: 12 };
const tooltipStyle = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 9,
  color: "var(--ink)",
  fontSize: 13,
};

/** The palette for series without a meaning of their own (projects), in order. */
export const SERIES_COLOURS = [
  "var(--acc)",
  "var(--sactive)",
  "var(--sidle)",
  "var(--smeeting)",
  "var(--sbreak)",
  "var(--slocked)",
  "var(--spaused)",
  "var(--soffline)",
];

export function ChartCard({
  title,
  summary,
  height = 220,
  children,
}: {
  title: string;
  summary: string;
  height?: number;
  children: ReactElement;
}) {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-panel p-4">
      <figcaption className="text-[13.5px] font-semibold">{title}</figcaption>
      <div role="img" aria-label={`${title}. ${summary}`} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export interface SeriesSpec {
  key: string;
  name: string;
  colour: string;
}

/** One bucket's values; the chart reads the series' keys from it. */
type Row = { bucket: string };

/** Hours, counts or percentages per bucket, stacked or side by side. */
export function BucketBars({
  title,
  summary,
  rows,
  series,
  bucket,
  to,
  unit,
  stacked = true,
}: {
  title: string;
  summary: string;
  rows: Row[];
  series: SeriesSpec[];
  bucket: "day" | "week";
  to: string;
  unit: "hours" | "count";
  stacked?: boolean;
}) {
  const label = (b: string) => bucketLabel(b, bucket, to);
  return (
    <ChartCard title={title} summary={summary}>
      <BarChart
        data={rows}
        accessibilityLayer={false}
        margin={{ left: 0, right: 8, top: 4, bottom: 0 }}
      >
        <CartesianGrid vertical={false} stroke="var(--line)" />
        <XAxis
          dataKey="bucket"
          tick={axis}
          stroke="var(--line2)"
          tickFormatter={(b: string) => bucketLabel(b, "day", to)}
          minTickGap={12}
        />
        <YAxis
          tick={axis}
          stroke="var(--line2)"
          width={44}
          allowDecimals={unit === "hours"}
          tickFormatter={(v: number) =>
            unit === "hours" ? `${Math.round(v * 10) / 10} h` : String(v)
          }
        />
        <Tooltip
          cursor={{ fill: "var(--sunk)" }}
          contentStyle={tooltipStyle}
          labelFormatter={(b) => label(String(b))}
          formatter={(v) =>
            unit === "hours" ? formatDuration(Math.round(Number(v) * 3600)) : String(v)
          }
        />
        <Legend wrapperStyle={{ fontSize: 13, color: "var(--ink2)" }} />
        {series.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.name}
            fill={s.colour}
            {...(stacked ? { stackId: "one" } : {})}
          />
        ))}
      </BarChart>
    </ChartCard>
  );
}

/** A rate (0..1, shown in percent) or a response time (ms, shown in seconds) per bucket. */
export function BucketLine({
  title,
  summary,
  rows,
  dataKey,
  name,
  colour,
  bucket,
  to,
  unit,
  target,
}: {
  title: string;
  summary: string;
  rows: Row[];
  dataKey: string;
  name: string;
  colour: string;
  bucket: "day" | "week";
  to: string;
  unit: "percent" | "seconds";
  /** A reference line (in the chart's unit), e.g. a team's billable target. */
  target?: { value: number; label: string } | null;
}) {
  const show = (v: number) =>
    unit === "percent" ? `${Math.round(v * 100)}%` : `${Math.round(v / 100) / 10} s`;
  return (
    <ChartCard title={title} summary={summary}>
      <LineChart
        data={rows}
        accessibilityLayer={false}
        margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
      >
        <CartesianGrid vertical={false} stroke="var(--line)" />
        <XAxis
          dataKey="bucket"
          tick={axis}
          stroke="var(--line2)"
          tickFormatter={(b: string) => bucketLabel(b, "day", to)}
          minTickGap={12}
        />
        <YAxis
          tick={axis}
          stroke="var(--line2)"
          width={44}
          domain={unit === "percent" ? [0, 1] : [0, "auto"]}
          tickFormatter={show}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(b) => bucketLabel(String(b), bucket, to)}
          formatter={(v) => (v === null || v === undefined ? "—" : show(Number(v)))}
        />
        {target && (
          <ReferenceLine
            y={target.value}
            stroke="var(--ink3)"
            strokeDasharray="4 4"
            label={{
              value: target.label,
              fill: "var(--ink3)",
              fontSize: 12,
              position: "insideTopRight",
            }}
          />
        )}
        <Line
          type="monotone"
          dataKey={dataKey}
          name={name}
          stroke={colour}
          strokeWidth={2}
          dot={rows.length <= 31}
          connectNulls
          isAnimationActive={false}
        />
      </LineChart>
    </ChartCard>
  );
}
