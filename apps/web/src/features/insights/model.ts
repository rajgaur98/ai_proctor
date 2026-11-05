// Insights (#305, INS-01..05): what `public.insights` returns, read into typed objects,
// and the pure arithmetic the page does on it: the trend against the previous range,
// shares, the project chart's groups and the export tables. Every number is the
// database's, in raw whole seconds (INS-04, TS-06); only these strings round. Pure (no
// Supabase import), so the unit tests run without an environment.
import type { ExportTable } from "../../lib/exportFile";
import { exportHours } from "../../lib/exportFile";
import { formatRate, formatResponse } from "../reports/format";
import { formatDuration } from "../timesheets/summary";

/** The counted numbers of a group (the team's totals) or of one person, by their database names. */
export const COUNT_KEYS = [
  "worked_s",
  "flagged_s",
  "excluded_s",
  "break_s",
  "pause_s",
  "pause_over_cap_s",
  "manual_s",
  "billable_s",
  "unassigned_s",
  "scheduled_s",
  "leave_s",
  "shift_days",
  "on_time",
  "late_clock_ins",
  "no_clock_in",
  "leave_shift_days",
  "checkins_shown",
  "checkins_passed",
  "checkins_missed",
  "checkins_failed",
  "checkins_deferred",
  "deferred_call",
  "deferred_presenting",
  "miss_meeting",
  "miss_phone_call",
  "miss_break",
  "miss_away",
  "miss_other",
  "miss_none",
  "pause_days_over_cap",
  "break_days_over_cap",
  "overtime_daily_s",
  "overtime_days",
  "overtime_weekly_s",
  "overtime_weeks",
  "anomaly_flags",
  "needs_review",
  "tamper",
] as const;

export type CountKey = (typeof COUNT_KEYS)[number];

export type Numbers = Record<CountKey, number> & {
  /** Passed over shown; null when nothing was shown. */
  response_rate: number | null;
  /** The median response of the passes, in ms; null when there are none. */
  median_response_ms: number | null;
};

export type Totals = Numbers & { people: number };

export type Person = Numbers & {
  user_id: string;
  full_name: string;
  team_id: string | null;
  active: boolean;
};

/** One bucket of the series (a day, or 7 days from its start when the range is long). */
export interface Point {
  bucket: string;
  worked_s: number;
  flagged_s: number;
  excluded_s: number;
  scheduled_s: number;
  /** Paid leave and holidays (leave_days, as the timesheet's Leave row), apart from worked time. */
  leave_s: number;
  break_s: number;
  pause_s: number;
  pause_over_cap_s: number;
  billable_s: number;
  unassigned_s: number;
  overtime_daily_s: number;
  shift_days: number;
  on_time: number;
  late_clock_ins: number;
  no_clock_in: number;
  checkins_shown: number;
  checkins_passed: number;
  checkins_missed: number;
  checkins_failed: number;
  checkins_deferred: number;
  response_rate: number | null;
  median_response_ms: number | null;
  anomaly_flags: number;
  needs_review: number;
  tamper: number;
}

/** Worked time on one project and task (both null: Unassigned), as Reports by task adds it up. */
export interface ProjectRow {
  project_id: string | null;
  project_name: string | null;
  client_id: string | null;
  client_name: string | null;
  task_id: string | null;
  task_name: string | null;
  billable: boolean;
  worked_s: number;
  people: number;
}

export interface ProjectPoint {
  bucket: string;
  project_id: string | null;
  task_id: string | null;
  worked_s: number;
}

export interface TeamShare {
  team_id: string;
  name: string;
  /** The team's billable target in percent; null when it has none (the default). */
  billable_target_pct: number | null;
  people: number;
  worked_s: number;
  billable_s: number;
}

/** A person-day with anti-cheat flags or Tamper, for a link to the day view. */
export interface ReviewDay {
  user_id: string;
  full_name: string;
  day: string;
  anomaly_flags: number;
  needs_review: number;
  tamper: number;
}

export interface PersonOption {
  userId: string;
  fullName: string;
  active: boolean;
}

export interface Insights {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  bucket: "day" | "week";
  lateGraceMin: number;
  caps: {
    pauseMaxMin: number | null;
    pauseDailyMaxMin: number | null;
    breakDailyMaxMin: number | null;
  };
  overtime: { dailyHours: number | null; weeklyHours: number | null };
  billableTargetPct: number | null;
  totals: Totals;
  previous: Totals;
  people: Person[];
  series: Point[];
  projects: ProjectRow[];
  projectSeries: ProjectPoint[];
  teams: TeamShare[];
  reviewDays: ReviewDay[];
  reviewDaysTotal: number;
  options: PersonOption[];
}

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(obj) : []);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

function numbers(r: Raw): Numbers {
  const out = {} as Record<CountKey, number>;
  for (const k of COUNT_KEYS) out[k] = num(r[k]);
  return {
    ...out,
    response_rate: numOrNull(r.response_rate),
    median_response_ms: numOrNull(r.median_response_ms),
  };
}

const totals = (r: Raw): Totals => ({ ...numbers(r), people: num(r.people) });

/** The RPC's reply, read defensively: a missing number is 0, a missing list empty. */
export function parseInsights(raw: unknown): Insights {
  const r = obj(raw);
  const caps = obj(r.caps);
  const overtime = obj(r.overtime);
  return {
    from: str(r.from),
    to: str(r.to),
    previousFrom: str(r.previous_from),
    previousTo: str(r.previous_to),
    bucket: r.bucket === "week" ? "week" : "day",
    lateGraceMin: num(r.late_grace_min),
    caps: {
      pauseMaxMin: numOrNull(caps.pause_max_min),
      pauseDailyMaxMin: numOrNull(caps.pause_daily_max_min),
      breakDailyMaxMin: numOrNull(caps.break_daily_max_min),
    },
    overtime: {
      dailyHours: numOrNull(overtime.daily_hours),
      weeklyHours: numOrNull(overtime.weekly_hours),
    },
    billableTargetPct: numOrNull(r.billable_target_pct),
    totals: totals(obj(r.totals)),
    previous: totals(obj(r.previous_totals)),
    people: list(r.people).map((p) => ({
      ...numbers(p),
      user_id: str(p.user_id),
      full_name: str(p.full_name),
      team_id: strOrNull(p.team_id),
      active: p.active !== false,
    })),
    series: list(r.series).map((p) => ({
      bucket: str(p.bucket),
      worked_s: num(p.worked_s),
      flagged_s: num(p.flagged_s),
      excluded_s: num(p.excluded_s),
      scheduled_s: num(p.scheduled_s),
      leave_s: num(p.leave_s),
      break_s: num(p.break_s),
      pause_s: num(p.pause_s),
      pause_over_cap_s: num(p.pause_over_cap_s),
      billable_s: num(p.billable_s),
      unassigned_s: num(p.unassigned_s),
      overtime_daily_s: num(p.overtime_daily_s),
      shift_days: num(p.shift_days),
      on_time: num(p.on_time),
      late_clock_ins: num(p.late_clock_ins),
      no_clock_in: num(p.no_clock_in),
      checkins_shown: num(p.checkins_shown),
      checkins_passed: num(p.checkins_passed),
      checkins_missed: num(p.checkins_missed),
      checkins_failed: num(p.checkins_failed),
      checkins_deferred: num(p.checkins_deferred),
      response_rate: numOrNull(p.response_rate),
      median_response_ms: numOrNull(p.median_response_ms),
      anomaly_flags: num(p.anomaly_flags),
      needs_review: num(p.needs_review),
      tamper: num(p.tamper),
    })),
    projects: list(r.projects).map((p) => ({
      project_id: strOrNull(p.project_id),
      project_name: strOrNull(p.project_name),
      client_id: strOrNull(p.client_id),
      client_name: strOrNull(p.client_name),
      task_id: strOrNull(p.task_id),
      task_name: strOrNull(p.task_name),
      billable: p.billable === true,
      worked_s: num(p.worked_s),
      people: num(p.people),
    })),
    projectSeries: list(r.project_series).map((p) => ({
      bucket: str(p.bucket),
      project_id: strOrNull(p.project_id),
      task_id: strOrNull(p.task_id),
      worked_s: num(p.worked_s),
    })),
    teams: list(r.teams).map((t) => ({
      team_id: str(t.team_id),
      name: str(t.name),
      billable_target_pct: numOrNull(t.billable_target_pct),
      people: num(t.people),
      worked_s: num(t.worked_s),
      billable_s: num(t.billable_s),
    })),
    reviewDays: list(r.review_days).map((d) => ({
      user_id: str(d.user_id),
      full_name: str(d.full_name),
      day: str(d.day),
      anomaly_flags: num(d.anomaly_flags),
      needs_review: num(d.needs_review),
      tamper: num(d.tamper),
    })),
    reviewDaysTotal: num(r.review_days_total),
    options: list(r.people_options).map((o) => ({
      userId: str(o.user_id),
      fullName: str(o.full_name),
      active: o.active !== false,
    })),
  };
}

// Shares and trends --------------------------------------------------------------------------

/** part / whole, or null when there is nothing to divide. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** How a metric reads, for its trend text. */
export type Kind = "duration" | "count" | "rate" | "ms";

export function formatValue(value: number | null, kind: Kind): string {
  switch (kind) {
    case "duration":
      return formatDuration(value ?? 0);
    case "count":
      return String(value ?? 0);
    case "rate":
      return formatRate(value);
    case "ms":
      return formatResponse(value);
  }
}

export interface Trend {
  /** "+1 h 30 min", "−2", "+5 pts", "Same", or "—" when either side has nothing. */
  text: string;
  direction: "up" | "down" | "same" | "none";
}

/**
 * The change from the previous range to this one. Neutral: up is not "good" and down is
 * not "bad" (INS-03, no scores). Rates change in percentage points; durations and
 * response times compare what is shown (rounded to the minute, or to the displayed
 * precision), so "Same" never hides a change the two values show.
 */
export function trend(current: number | null, previous: number | null, kind: Kind): Trend {
  if (current === null || previous === null) return { text: "—", direction: "none" };
  let delta: number;
  let text: string;
  switch (kind) {
    case "duration": {
      delta = Math.round(current / 60) - Math.round(previous / 60);
      text = formatDuration(Math.abs(delta) * 60);
      break;
    }
    case "count":
      delta = current - previous;
      text = String(Math.abs(delta));
      break;
    case "rate":
      delta = Math.round(current * 100) - Math.round(previous * 100);
      text = `${Math.abs(delta)} pts`;
      break;
    case "ms": {
      // To the tenth of a second, as formatResponse shows it from a second up.
      delta = Math.round(current / 100) - Math.round(previous / 100);
      text = formatResponse(Math.abs(delta) * 100);
      break;
    }
  }
  if (delta === 0) return { text: "Same", direction: "same" };
  return { text: `${delta > 0 ? "+" : "−"}${text}`, direction: delta > 0 ? "up" : "down" };
}

/** "16 Mar" for a day; the range a 7-day bucket covers, cut at the range's end. */
export function bucketLabel(bucket: string, kind: "day" | "week", rangeTo: string): string {
  const day = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  };
  if (kind === "day") return day(bucket);
  const end = new Date(`${bucket}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  const last = end.toISOString().slice(0, 10);
  return `${day(bucket)} – ${day(last < rangeTo ? last : rangeTo)}`;
}

// Projects -----------------------------------------------------------------------------------

export type ProjectLevel = "client" | "project" | "task";

export const UNASSIGNED = "Unassigned";
const NO_CLIENT = "No client";
const NO_TASK = "No task";
const OTHER = "Other";

interface Group {
  key: string;
  label: string;
}

/** The group a project row belongs to at a level; Unassigned (no project) is its own. */
export function groupOf(
  row: { project_id: string | null; task_id: string | null },
  names: Map<string, ProjectRow>,
  level: ProjectLevel,
): Group {
  if (row.project_id === null) return { key: "unassigned", label: UNASSIGNED };
  const p = names.get(`${row.project_id}/${row.task_id ?? ""}`) ?? names.get(`${row.project_id}/`);
  const project = p?.project_name ?? "Project";
  switch (level) {
    case "client":
      return p?.client_id
        ? { key: `c:${p.client_id}`, label: p.client_name ?? "Client" }
        : { key: "c:none", label: NO_CLIENT };
    case "project":
      return { key: `p:${row.project_id}`, label: project };
    case "task":
      return {
        key: `t:${row.project_id}/${row.task_id ?? ""}`,
        label: `${project} · ${row.task_id ? (p?.task_name ?? "Task") : NO_TASK}`,
      };
  }
}

export interface ProjectChart {
  /** The series, in order: by name, then Other, then Unassigned. */
  groups: Group[];
  /** One row per bucket: hours per group key. */
  rows: Array<{ bucket: string } & Record<string, number | string>>;
}

/**
 * Hours per bucket by client, project or task for a stacked chart. At most `max` named
 * groups (the most hours in the range); the rest are added up as Other. Unassigned is
 * always its own group (PRJ-03).
 */
export function projectChart(
  buckets: string[],
  points: ProjectPoint[],
  projects: ProjectRow[],
  level: ProjectLevel,
  max = 6,
): ProjectChart {
  const names = new Map(projects.map((p) => [`${p.project_id}/${p.task_id ?? ""}`, p]));
  const totals = new Map<string, { group: Group; seconds: number }>();
  for (const p of points) {
    const g = groupOf(p, names, level);
    const t = totals.get(g.key) ?? { group: g, seconds: 0 };
    t.seconds += p.worked_s;
    totals.set(g.key, t);
  }
  const named = [...totals.values()].filter((t) => t.group.key !== "unassigned");
  const kept = new Set(
    [...named]
      .sort((a, b) => b.seconds - a.seconds || a.group.label.localeCompare(b.group.label))
      .slice(0, max)
      .map((t) => t.group.key),
  );
  const groups: Group[] = named
    .filter((t) => kept.has(t.group.key))
    .map((t) => t.group)
    .sort((a, b) => a.label.localeCompare(b.label));
  const hasOther = named.length > kept.size;
  if (hasOther) groups.push({ key: "other", label: OTHER });
  if (totals.has("unassigned")) groups.push({ key: "unassigned", label: UNASSIGNED });

  const byBucket = new Map<string, Record<string, number>>();
  for (const b of buckets) byBucket.set(b, Object.fromEntries(groups.map((g) => [g.key, 0])));
  for (const p of points) {
    const g = groupOf(p, names, level);
    const key = g.key === "unassigned" || kept.has(g.key) ? g.key : "other";
    const row = byBucket.get(p.bucket);
    if (row) row[key] = (row[key] ?? 0) + p.worked_s / 3600;
  }
  return {
    groups,
    rows: buckets.map((bucket) => ({ bucket, ...(byBucket.get(bucket) ?? {}) })),
  };
}

/** A project row's names as the table shows them. */
export function projectNames(p: ProjectRow): { client: string; project: string; task: string } {
  if (p.project_id === null) return { client: "", project: UNASSIGNED, task: "" };
  return {
    client: p.client_name ?? NO_CLIENT,
    project: p.project_name ?? "Project",
    task: p.task_id ? (p.task_name ?? "Task") : NO_TASK,
  };
}

// Export tables (TS-27/28) --------------------------------------------------------------------

const pct = (rate: number | null): number | null =>
  rate === null ? null : Math.round(rate * 1000) / 10;
const seconds1 = (ms: number | null): number | null =>
  ms === null ? null : Math.round(ms / 100) / 10;

/** One line of the summary: a metric for this range and the previous one. */
interface SummaryLine {
  label: string;
  value: (t: Totals) => number | null;
  hours?: boolean;
}

export const summaryLines: SummaryLine[] = [
  { label: "People", value: (t) => t.people },
  { label: "Shift days", value: (t) => t.shift_days },
  { label: "On time", value: (t) => t.on_time },
  { label: "Late clock-ins", value: (t) => t.late_clock_ins },
  { label: "Shift days without a clock-in", value: (t) => t.no_clock_in },
  { label: "Shift days on leave or a holiday", value: (t) => t.leave_shift_days },
  { label: "Worked (h)", value: (t) => t.worked_s, hours: true },
  { label: "Scheduled (h)", value: (t) => t.scheduled_s, hours: true },
  { label: "Leave (h)", value: (t) => t.leave_s, hours: true },
  { label: "Check-ins shown", value: (t) => t.checkins_shown },
  { label: "Passed", value: (t) => t.checkins_passed },
  { label: "Missed", value: (t) => t.checkins_missed },
  { label: "Failed", value: (t) => t.checkins_failed },
  { label: "Deferred", value: (t) => t.checkins_deferred },
  { label: "Deferred for a call", value: (t) => t.deferred_call },
  { label: "Deferred while presenting", value: (t) => t.deferred_presenting },
  { label: "Response rate (%)", value: (t) => pct(t.response_rate) },
  { label: "Median response (s)", value: (t) => seconds1(t.median_response_ms) },
  { label: "Missed: Meeting", value: (t) => t.miss_meeting },
  { label: "Missed: Phone call", value: (t) => t.miss_phone_call },
  { label: "Missed: Break", value: (t) => t.miss_break },
  { label: "Missed: Away from desk", value: (t) => t.miss_away },
  { label: "Missed: Other", value: (t) => t.miss_other },
  { label: "Missed: No reason", value: (t) => t.miss_none },
  { label: "Flagged (h)", value: (t) => t.flagged_s, hours: true },
  { label: "Excluded (h)", value: (t) => t.excluded_s, hours: true },
  { label: "Breaks (h)", value: (t) => t.break_s, hours: true },
  { label: "Pauses (h)", value: (t) => t.pause_s, hours: true },
  { label: "Pause over cap (h)", value: (t) => t.pause_over_cap_s, hours: true },
  { label: "Days over the daily pause cap", value: (t) => t.pause_days_over_cap },
  { label: "Days over the daily break cap", value: (t) => t.break_days_over_cap },
  { label: "Overtime, daily (h)", value: (t) => t.overtime_daily_s, hours: true },
  { label: "Days over the daily threshold", value: (t) => t.overtime_days },
  { label: "Overtime, weekly (h)", value: (t) => t.overtime_weekly_s, hours: true },
  { label: "Weeks over the weekly threshold", value: (t) => t.overtime_weeks },
  { label: "Billable (h)", value: (t) => t.billable_s, hours: true },
  { label: "Billable share (%)", value: (t) => pct(share(t.billable_s, t.worked_s)) },
  { label: "Unassigned (h)", value: (t) => t.unassigned_s, hours: true },
  { label: "Anti-cheat flags", value: (t) => t.anomaly_flags },
  { label: "Needs review", value: (t) => t.needs_review },
  { label: "Tamper", value: (t) => t.tamper },
];

export function summaryTable(i: Insights): ExportTable {
  const cell = (l: SummaryLine, t: Totals) => {
    const v = l.value(t);
    return v !== null && l.hours ? exportHours(v) : v;
  };
  return {
    sheet: "Summary",
    header: ["Metric", `${i.from} to ${i.to}`, `${i.previousFrom} to ${i.previousTo}`],
    rows: summaryLines.map((l) => [l.label, cell(l, i.totals), cell(l, i.previous)]),
  };
}

export function peopleTable(people: Person[]): ExportTable {
  return {
    sheet: "People",
    header: [
      "Person",
      "Worked (h)",
      "Scheduled (h)",
      "Leave (h)",
      "Shift days",
      "On time",
      "Late clock-ins",
      "No clock-in",
      "On leave or holiday",
      "Check-ins shown",
      "Passed",
      "Missed",
      "Failed",
      "Deferred",
      "Response rate (%)",
      "Median response (s)",
      "Flagged (h)",
      "Excluded (h)",
      "Breaks (h)",
      "Pauses (h)",
      "Pause over cap (h)",
      "Overtime, daily (h)",
      "Overtime, weekly (h)",
      "Billable (h)",
      "Billable share (%)",
      "Unassigned (h)",
      "Anti-cheat flags",
      "Needs review",
      "Tamper",
    ],
    rows: people.map((p) => [
      p.full_name,
      exportHours(p.worked_s),
      exportHours(p.scheduled_s),
      exportHours(p.leave_s),
      p.shift_days,
      p.on_time,
      p.late_clock_ins,
      p.no_clock_in,
      p.leave_shift_days,
      p.checkins_shown,
      p.checkins_passed,
      p.checkins_missed,
      p.checkins_failed,
      p.checkins_deferred,
      pct(p.response_rate),
      seconds1(p.median_response_ms),
      exportHours(p.flagged_s),
      exportHours(p.excluded_s),
      exportHours(p.break_s),
      exportHours(p.pause_s),
      exportHours(p.pause_over_cap_s),
      exportHours(p.overtime_daily_s),
      exportHours(p.overtime_weekly_s),
      exportHours(p.billable_s),
      pct(share(p.billable_s, p.worked_s)),
      exportHours(p.unassigned_s),
      p.anomaly_flags,
      p.needs_review,
      p.tamper,
    ]),
  };
}

export function trendTable(i: Insights): ExportTable {
  return {
    sheet: "Trend",
    header: [
      i.bucket === "week" ? "Week from" : "Day",
      "Worked (h)",
      "Scheduled (h)",
      "Leave (h)",
      "Flagged (h)",
      "Excluded (h)",
      "Billable (h)",
      "Unassigned (h)",
      "Breaks (h)",
      "Pauses (h)",
      "Pause over cap (h)",
      "Overtime, daily (h)",
      "Shift days",
      "On time",
      "Late clock-ins",
      "No clock-in",
      "Check-ins shown",
      "Passed",
      "Missed",
      "Failed",
      "Deferred",
      "Response rate (%)",
      "Median response (s)",
      "Anti-cheat flags",
      "Needs review",
      "Tamper",
    ],
    rows: i.series.map((p) => [
      p.bucket,
      exportHours(p.worked_s),
      exportHours(p.scheduled_s),
      exportHours(p.leave_s),
      exportHours(p.flagged_s),
      exportHours(p.excluded_s),
      exportHours(p.billable_s),
      exportHours(p.unassigned_s),
      exportHours(p.break_s),
      exportHours(p.pause_s),
      exportHours(p.pause_over_cap_s),
      exportHours(p.overtime_daily_s),
      p.shift_days,
      p.on_time,
      p.late_clock_ins,
      p.no_clock_in,
      p.checkins_shown,
      p.checkins_passed,
      p.checkins_missed,
      p.checkins_failed,
      p.checkins_deferred,
      pct(p.response_rate),
      seconds1(p.median_response_ms),
      p.anomaly_flags,
      p.needs_review,
      p.tamper,
    ]),
  };
}

export function projectsTable(i: Insights): ExportTable {
  return {
    sheet: "Projects",
    header: [
      "Client",
      "Project",
      "Task",
      "Worked (h)",
      "Share of worked (%)",
      "Billable",
      "People",
    ],
    rows: i.projects.map((p) => {
      const n = projectNames(p);
      return [
        n.client,
        n.project,
        n.task,
        exportHours(p.worked_s),
        pct(share(p.worked_s, i.totals.worked_s)),
        p.billable ? "Yes" : "No",
        p.people,
      ];
    }),
  };
}

export function reviewTable(days: ReviewDay[]): ExportTable {
  return {
    sheet: "Days to review",
    header: ["Day", "Person", "Anti-cheat flags", "Needs review", "Tamper"],
    rows: days.map((d) => [d.day, d.full_name, d.anomaly_flags, d.needs_review, d.tamper]),
  };
}
