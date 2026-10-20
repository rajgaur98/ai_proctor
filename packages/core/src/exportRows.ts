// Timesheet export (PRD 4.10 TS-20..23): raw segment rows in, one of three CSV views
// out. Pure, so the export-timesheet Edge Function and the tests run the same code.
//
// Everything is added up from raw seconds with the arithmetic the dashboard uses
// (apps/web summary.ts: worked is counted and not excluded, flagged is flagged and not
// excluded, excluded is excluded, break is any break), and only the finished sums are
// formatted, so row sums and totals always agree (TS-05/06). Billable plus non-billable
// is worked; time without a project (Unassigned, PRJ-03) is non-billable.

import { toCsv } from "./csv.ts";

export type ExportView = "daily" | "project" | "segments";
export const EXPORT_VIEWS: readonly ExportView[] = ["daily", "project", "segments"];

/** One stored segment with who, when, which project and the week's status. */
export interface ExportSegment {
  userId: string;
  employee: string;
  email: string;
  timezone: string;
  /** The employee's local day, YYYY-MM-DD. */
  day: string;
  /** Local to the employee: YYYY-MM-DD HH:MM:SS. */
  startLocal: string;
  endLocal: string;
  type: string;
  projectId: string | null;
  project: string | null;
  client: string | null;
  billable: boolean;
  counted: boolean;
  flagged: boolean;
  excluded: boolean;
  seconds: number;
  /** Status of the timesheet for the segment's week; draft when it hasn't been opened. */
  status: string;
  approver: string | null;
}

/** A row as `timesheet_export_rows` returns it. */
export interface DbExportRow {
  user_id: string;
  employee: string;
  email: string;
  timezone: string;
  day: string;
  start_local: string;
  end_local: string;
  type: string;
  project_id: string | null;
  project: string | null;
  client: string | null;
  billable: boolean;
  counted: boolean;
  flagged: boolean;
  excluded: boolean;
  seconds: number;
  status: string;
  approver: string | null;
}

export function fromDbRow(r: DbExportRow): ExportSegment {
  return {
    userId: r.user_id,
    employee: r.employee,
    email: r.email,
    timezone: r.timezone,
    day: r.day,
    startLocal: r.start_local,
    endLocal: r.end_local,
    type: r.type,
    projectId: r.project_id,
    project: r.project,
    client: r.client,
    billable: r.billable,
    counted: r.counted,
    flagged: r.flagged,
    excluded: r.excluded,
    seconds: Number(r.seconds),
    status: r.status,
    approver: r.approver,
  };
}

/** Seconds per column. */
export interface Durations {
  worked: number;
  flagged: number;
  excluded: number;
  breakTime: number;
  manual: number;
  billable: number;
  nonBillable: number;
}

export function emptyDurations(): Durations {
  return {
    worked: 0,
    flagged: 0,
    excluded: 0,
    breakTime: 0,
    manual: 0,
    billable: 0,
    nonBillable: 0,
  };
}

export function addSegment(into: Durations, s: ExportSegment): void {
  if (s.counted && !s.excluded) {
    into.worked += s.seconds;
    if (s.type === "manual") into.manual += s.seconds;
    if (s.projectId !== null && s.billable) into.billable += s.seconds;
    else into.nonBillable += s.seconds;
  }
  if (s.flagged && !s.excluded) into.flagged += s.seconds;
  if (s.excluded) into.excluded += s.seconds;
  if (s.type === "break") into.breakTime += s.seconds;
}

export function sumSegments(segments: ExportSegment[]): Durations {
  const total = emptyDurations();
  for (const s of segments) addSegment(total, s);
  return total;
}

/** Hours to 2 decimal places, from whole seconds: 26760 -> "7.43" (half up, no floats). */
export function decimalHours(seconds: number): string {
  const hundredths = Math.round(seconds / 36);
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
}

/** Hours and minutes, rounded to the minute like the dashboard: 26760 -> "7:26". */
export function clockHours(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

const DURATION_COLUMNS: [keyof Durations, string][] = [
  ["worked", "Worked"],
  ["flagged", "Flagged"],
  ["excluded", "Excluded"],
  ["breakTime", "Break"],
  ["manual", "Manual"],
  ["billable", "Billable"],
  ["nonBillable", "Non-billable"],
];

const LEADING: Record<ExportView, string[]> = {
  daily: ["Employee", "Email", "Date"],
  project: ["Employee", "Email", "Client", "Project", "Billable"],
  segments: [
    "Employee",
    "Email",
    "Date",
    "Start",
    "End",
    "Time zone",
    "Type",
    "Client",
    "Project",
    "Billable",
  ],
};

export interface ExportRow {
  /** The identifying cells, matching the view's leading columns. */
  labels: string[];
  seconds: Durations;
  status: string;
  approver: string;
}

export interface ExportTable {
  view: ExportView;
  rows: ExportRow[];
  /** Summed from the raw segments, not from the rows. */
  total: Durations;
}

const UNASSIGNED = "Unassigned";

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function yesNo(v: boolean): string {
  return v ? "Yes" : "No";
}

function labelsFor(view: ExportView, s: ExportSegment): string[] {
  const person = [s.employee, s.email];
  const assigned = s.projectId !== null;
  const client = assigned ? (s.client ?? "") : "";
  const project = assigned ? (s.project ?? "") : UNASSIGNED;
  const billable = yesNo(assigned && s.billable);
  switch (view) {
    case "daily":
      return [...person, s.day];
    case "project":
      return [...person, client, project, billable];
    case "segments":
      return [
        ...person,
        s.day,
        s.startLocal,
        s.endLocal,
        s.timezone,
        s.type,
        client,
        project,
        billable,
      ];
  }
}

/** The group a segment belongs to in a view; one row per group (segments: per segment). */
function groupKey(view: ExportView, s: ExportSegment, index: number): string {
  switch (view) {
    case "daily":
      return `${s.userId}\u0000${s.day}`;
    case "project":
      return `${s.userId}\u0000${s.projectId ?? ""}`;
    case "segments":
      return String(index);
  }
}

function sortKey(view: ExportView, s: ExportSegment): string[] {
  switch (view) {
    case "daily":
      return [s.employee, s.userId, s.day];
    case "project":
      // Unassigned last within the person.
      return [
        s.employee,
        s.userId,
        s.projectId === null ? "1" : "0",
        s.projectId === null ? "" : (s.client ?? ""),
        s.project ?? "",
        s.projectId ?? "",
      ];
    case "segments":
      return [s.employee, s.userId, s.day, s.startLocal, s.endLocal, s.type];
  }
}

function compareKeys(a: string[], b: string[]): number {
  for (let i = 0; i < a.length; i++) {
    const c = cmp(a[i] ?? "", b[i] ?? "");
    if (c !== 0) return c;
  }
  return 0;
}

export function buildExport(view: ExportView, segments: ExportSegment[]): ExportTable {
  const sorted = [...segments].sort((a, b) => compareKeys(sortKey(view, a), sortKey(view, b)));
  const groups = new Map<
    string,
    { first: ExportSegment; seconds: Durations; statuses: Set<string>; approvers: Set<string> }
  >();
  sorted.forEach((s, i) => {
    const key = groupKey(view, s, i);
    let g = groups.get(key);
    if (!g) {
      g = { first: s, seconds: emptyDurations(), statuses: new Set(), approvers: new Set() };
      groups.set(key, g);
    }
    addSegment(g.seconds, s);
    g.statuses.add(s.status);
    if (s.approver) g.approvers.add(s.approver);
  });
  const rows = [...groups.values()].map(
    (g): ExportRow => ({
      labels: labelsFor(view, g.first),
      seconds: g.seconds,
      // A project row can span weeks in different states.
      status: g.statuses.size === 1 ? ([...g.statuses][0] ?? "") : "Mixed",
      approver: [...g.approvers].sort(cmp).join("; "),
    }),
  );
  return { view, rows, total: sumSegments(segments) };
}

function durationCells(d: Durations): string[] {
  return DURATION_COLUMNS.flatMap(([key]) => [decimalHours(d[key]), clockHours(d[key])]);
}

/** Header, one line per row, then the Total row: every cell formatted from raw seconds. */
export function formatTable(table: ExportTable): string[][] {
  const leading = LEADING[table.view];
  const header = [
    ...leading,
    ...DURATION_COLUMNS.flatMap(([, label]) => [`${label} (h)`, `${label} (H:MM)`]),
    "Status",
    "Approver",
  ];
  const lines = table.rows.map((r) => [
    ...r.labels,
    ...durationCells(r.seconds),
    r.status,
    r.approver,
  ]);
  const total = ["Total", ...leading.slice(1).map(() => ""), ...durationCells(table.total), "", ""];
  return [header, ...lines, total];
}

export function exportCsv(view: ExportView, segments: ExportSegment[]): string {
  return toCsv(formatTable(buildExport(view, segments)));
}

/** The download's name: timesheet-daily-2026-03-16_2026-03-22.csv. */
export function exportFilename(view: ExportView, from: string, to: string): string {
  return `timesheet-${view}-${from}_${to}.csv`;
}
