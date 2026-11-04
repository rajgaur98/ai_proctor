// Timesheet export (PRD 4.10 TS-20..23): raw segment rows in, one of three views out,
// as CSV or XLSX (#65). Pure, so the export-timesheet Edge Function and the tests run
// the same code.
//
// Everything is added up from raw seconds with the arithmetic the dashboard uses
// (apps/web summary.ts: worked is counted and not excluded, flagged is flagged and not
// excluded, excluded is excluded, break is any break), and only the finished sums are
// formatted, so row sums and totals always agree (TS-05/06). Billable plus non-billable
// is worked; time without a project (Unassigned, PRJ-03) is non-billable.
//
// #254: time can carry a task of its project (PRJ-05); the per-project and segment views
// get a Task column after Project, and a row per task. The per-day view ends with a "Work
// done" column (TS-25): the person's note for the day, then the notes of the day's manual
// entries.
//
// #319 (LV-05/06): leave comes in next to the segments, per person and day (`LeaveDay`, from
// timesheet_export_rows' `leave`) and gets its own Leave column: paid leave and holidays
// as the timesheet's Leave row counts them, unpaid leave 0. It is never worked, billable or
// overtime time (TS-19). The per-day view adds it to the person's day and names it in a
// "Time off" column; the per-project view has a "Leave" row per person (it is on no
// project); the segment view has a row per leave day with type "leave" and its name.

import { toCsv } from "./csv.ts";
import { isOver, NO_OVERTIME, type OvertimeThresholds, weekOf } from "./overtime.ts";
import { type XlsxCell, type XlsxSheet, xlsxWorkbook } from "./xlsx.ts";

export type ExportView = "daily" | "project" | "segments";
export const EXPORT_VIEWS: readonly ExportView[] = ["daily", "project", "segments"];

export type ExportFormat = "csv" | "xlsx";
export const EXPORT_FORMATS: readonly ExportFormat[] = ["csv", "xlsx"];

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
  /** The project's task (#254); none when left out. */
  taskId?: string | null;
  task?: string | null;
  client: string | null;
  /** The task's billable flag when there is one, else the project's. */
  billable: boolean;
  counted: boolean;
  flagged: boolean;
  excluded: boolean;
  seconds: number;
  /** Status of the timesheet for the segment's week; draft when it hasn't been opened. */
  status: string;
  approver: string | null;
  /** A manual segment: the work note of its entry (TS-24). */
  note?: string | null;
}

/** The person's work note for a day (TS-25). */
export interface DayNote {
  userId: string;
  day: string;
  note: string;
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
  task_id?: string | null;
  task?: string | null;
  client: string | null;
  billable: boolean;
  counted: boolean;
  flagged: boolean;
  excluded: boolean;
  seconds: number;
  status: string;
  approver: string | null;
  note?: string | null;
}

/** A day note as `timesheet_export_rows` returns it (`day_notes`). */
export interface DbDayNote {
  user_id: string;
  day: string;
  note: string;
}

/** What a day's leave is, as `timesheet_export_rows` (and timesheet_leave) return it. */
export interface LeaveItem {
  name: string;
  paid: boolean;
  holiday: boolean;
  part_day: boolean;
}

/** One person's leave on one local day (LV-05): its counted seconds and what it is. */
export interface LeaveDay {
  userId: string;
  employee: string;
  email: string;
  timezone: string;
  day: string;
  seconds: number;
  /** What the leave is, in words ("Vacation", "Thanksgiving (holiday)"). */
  what: string;
  /** Status of the timesheet for the day's week; draft when it hasn't been opened. */
  status: string;
  approver: string | null;
}

/** A leave day as `timesheet_export_rows` returns it (`leave`). */
export interface DbLeaveDay {
  user_id: string;
  employee: string;
  email: string;
  timezone: string;
  day: string;
  seconds: number;
  items: LeaveItem[];
  status: string;
  approver: string | null;
}

/** "Vacation", "Thanksgiving (holiday)", "Unpaid (unpaid)", "Sick (part day)"; "; " between. */
export function leaveWhat(items: readonly LeaveItem[]): string {
  return items
    .map((i) => {
      const notes = [
        i.holiday ? "holiday" : null,
        i.paid ? null : "unpaid",
        i.part_day ? "part day" : null,
      ].filter((n) => n !== null);
      return notes.length > 0 ? `${i.name} (${notes.join(", ")})` : i.name;
    })
    .join("; ");
}

export function fromDbLeaveDay(l: DbLeaveDay): LeaveDay {
  return {
    userId: l.user_id,
    employee: l.employee,
    email: l.email,
    timezone: l.timezone,
    day: l.day,
    seconds: Number(l.seconds),
    what: leaveWhat(l.items ?? []),
    status: l.status,
    approver: l.approver,
  };
}

export function fromDbDayNote(n: DbDayNote): DayNote {
  return { userId: n.user_id, day: n.day, note: n.note };
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
    taskId: r.task_id ?? null,
    task: r.task ?? null,
    client: r.client,
    billable: r.billable,
    counted: r.counted,
    flagged: r.flagged,
    excluded: r.excluded,
    seconds: Number(r.seconds),
    status: r.status,
    approver: r.approver,
    note: r.note ?? null,
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
  /** Paid leave and holidays (LV-05); apart from worked time. */
  leave: number;
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
    leave: 0,
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
  ["leave", "Leave"],
];

const LEADING: Record<ExportView, string[]> = {
  daily: ["Employee", "Email", "Date"],
  project: ["Employee", "Email", "Client", "Project", "Task", "Billable"],
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
    "Task",
    "Billable",
  ],
};

/** Free-text columns after Approver. */
const TRAILING: Record<ExportView, string[]> = {
  daily: ["Time off", "Work done"],
  project: [],
  segments: ["Time off"],
};

export interface ExportRow {
  /** The identifying cells, matching the view's leading columns. */
  labels: string[];
  seconds: Durations;
  status: string;
  approver: string;
  /** The view's trailing cells (TRAILING), e.g. the per-day Work done. */
  trailing: string[];
}

export interface ExportTable {
  view: ExportView;
  rows: ExportRow[];
  /** Summed from the raw segments, not from the rows. */
  total: Durations;
}

const UNASSIGNED = "Unassigned";
/** The per-project view's row for a person's leave (on no project). */
export const LEAVE_ROW = "Leave";

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
  const task = assigned && s.taskId ? (s.task ?? "") : "";
  const billable = yesNo(assigned && s.billable);
  switch (view) {
    case "daily":
      return [...person, s.day];
    case "project":
      return [...person, client, project, task, billable];
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
        task,
        billable,
      ];
  }
}

function dayKey(userId: string, day: string): string {
  return `${userId}\u0000${day}`;
}

/** The group a segment belongs to in a view; one row per group (segments: per segment). */
function groupKey(view: ExportView, s: ExportSegment, index: number): string {
  switch (view) {
    case "daily":
      return dayKey(s.userId, s.day);
    case "project":
      return `${s.userId}\u0000${s.projectId ?? ""}\u0000${s.projectId ? (s.taskId ?? "") : ""}`;
    case "segments":
      return String(index);
  }
}

function sortKey(view: ExportView, s: ExportSegment): string[] {
  switch (view) {
    case "daily":
      return [s.employee, s.userId, s.day];
    case "project":
      // Unassigned last within the person; within a project, time without a task first.
      return [
        s.employee,
        s.userId,
        s.projectId === null ? "1" : "0",
        s.projectId === null ? "" : (s.client ?? ""),
        s.project ?? "",
        s.projectId ?? "",
        s.projectId && s.taskId ? "1" : "0",
        s.projectId && s.taskId ? (s.task ?? "") : "",
        s.projectId && s.taskId ? s.taskId : "",
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

/**
 * TS-24/25: what a person wrote about a day's work: the day's note, then the notes of the
 * day's manual entries in time order, each once, one per line.
 */
export function workDone(dayNote: string | null | undefined, segments: ExportSegment[]): string {
  const notes: string[] = [];
  const add = (n: string | null | undefined) => {
    const text = n?.trim();
    if (text && !notes.includes(text)) notes.push(text);
  };
  add(dayNote);
  const ordered = [...segments].sort((a, b) => cmp(a.startLocal, b.startLocal));
  for (const s of ordered) if (s.type === "manual") add(s.note);
  return notes.join("\n");
}

interface Group {
  labels: string[];
  sort: string[];
  members: ExportSegment[];
  seconds: Durations;
  statuses: Set<string>;
  approvers: Set<string>;
  /** The per-day key, for the day's note. */
  dayKey: string | null;
  leave: string[];
}

function leaveLabels(view: ExportView, l: LeaveDay): string[] {
  const person = [l.employee, l.email];
  switch (view) {
    case "daily":
      return [...person, l.day];
    case "project":
      return [...person, "", LEAVE_ROW, "", "No"];
    case "segments":
      return [...person, l.day, "", "", l.timezone, "leave", "", "", "", "No"];
  }
}

function leaveSortKey(view: ExportView, l: LeaveDay): string[] {
  switch (view) {
    case "daily":
      return [l.employee, l.userId, l.day];
    case "project":
      // After the person's projects and Unassigned.
      return [l.employee, l.userId, "2"];
    case "segments":
      return [l.employee, l.userId, l.day, "", "", "leave"];
  }
}

function leaveGroupKey(view: ExportView, l: LeaveDay, index: number): string {
  switch (view) {
    case "daily":
      return dayKey(l.userId, l.day);
    case "project":
      return `${l.userId}\u0000leave`;
    case "segments":
      return `leave\u0000${index}`;
  }
}

export function buildExport(
  view: ExportView,
  segments: ExportSegment[],
  dayNotes: DayNote[] = [],
  leave: LeaveDay[] = [],
): ExportTable {
  const sorted = [...segments].sort((a, b) => compareKeys(sortKey(view, a), sortKey(view, b)));
  const groups = new Map<string, Group>();
  const blank = (labels: string[], sort: string[], key: string | null): Group => ({
    labels,
    sort,
    members: [],
    seconds: emptyDurations(),
    statuses: new Set(),
    approvers: new Set(),
    dayKey: key,
    leave: [],
  });
  sorted.forEach((s, i) => {
    const key = groupKey(view, s, i);
    let g = groups.get(key);
    if (!g) {
      g = blank(labelsFor(view, s), sortKey(view, s), view === "daily" ? key : null);
      groups.set(key, g);
    }
    g.members.push(s);
    addSegment(g.seconds, s);
    g.statuses.add(s.status);
    if (s.approver) g.approvers.add(s.approver);
  });
  leave.forEach((l, i) => {
    const key = leaveGroupKey(view, l, i);
    let g = groups.get(key);
    if (!g) {
      g = blank(leaveLabels(view, l), leaveSortKey(view, l), view === "daily" ? key : null);
      groups.set(key, g);
    }
    g.seconds.leave += l.seconds;
    if (l.what && !g.leave.includes(l.what)) g.leave.push(l.what);
    g.statuses.add(l.status);
    if (l.approver) g.approvers.add(l.approver);
  });
  const notes = new Map(dayNotes.map((n) => [dayKey(n.userId, n.day), n.note]));
  // Stable: segments keep their order; a leave group goes where its key sorts.
  const ordered = [...groups.values()]
    .map((g, i) => ({ g, i }))
    .sort((a, b) => compareKeys(a.g.sort, b.g.sort) || a.i - b.i)
    .map(({ g }) => g);
  const rows = ordered.map(
    (g): ExportRow => ({
      labels: g.labels,
      seconds: g.seconds,
      // A project row can span weeks in different states.
      status: g.statuses.size === 1 ? ([...g.statuses][0] ?? "") : "Mixed",
      approver: [...g.approvers].sort(cmp).join("; "),
      trailing:
        view === "daily"
          ? [g.leave.join("; "), workDone(notes.get(g.dayKey ?? ""), g.members)]
          : view === "segments"
            ? [g.leave.join("; ")]
            : [],
    }),
  );
  const total = sumSegments(segments);
  for (const l of leave) total.leave += l.seconds;
  return { view, rows, total };
}

function durationCells(d: Durations): string[] {
  return DURATION_COLUMNS.flatMap(([key]) => [decimalHours(d[key]), clockHours(d[key])]);
}

/** The view's column names, the same in CSV and XLSX. */
export function exportHeader(view: ExportView): string[] {
  return [
    ...LEADING[view],
    ...DURATION_COLUMNS.flatMap(([, label]) => [`${label} (h)`, `${label} (H:MM)`]),
    "Status",
    "Approver",
    ...TRAILING[view],
  ];
}

/** Header, one line per row, then the Total row: every cell formatted from raw seconds. */
export function formatTable(table: ExportTable): string[][] {
  const leading = LEADING[table.view];
  const header = exportHeader(table.view);
  const lines = table.rows.map((r) => [
    ...r.labels,
    ...durationCells(r.seconds),
    r.status,
    r.approver,
    ...r.trailing,
  ]);
  const total = [
    "Total",
    ...leading.slice(1).map(() => ""),
    ...durationCells(table.total),
    "",
    "",
    ...TRAILING[table.view].map(() => ""),
  ];
  return [header, ...lines, total];
}

export function exportCsv(
  view: ExportView,
  segments: ExportSegment[],
  dayNotes: DayNote[] = [],
  leave: LeaveDay[] = [],
): string {
  return toCsv(formatTable(buildExport(view, segments, dayNotes, leave)));
}

/** The download's name: timesheet-daily-2026-03-16_2026-03-22.csv (or .xlsx). */
export function exportFilename(
  view: ExportView,
  from: string,
  to: string,
  format: ExportFormat = "csv",
): string {
  return `timesheet-${view}-${from}_${to}.${format}`;
}

// XLSX (#65) ----------------------------------------------------------------------------

/** The first sheet's name per view. */
export const XLSX_SHEET_NAMES: Record<ExportView, string> = {
  daily: "Per day",
  project: "Per project",
  segments: "Segments",
};
export const WEEKLY_SHEET_NAME = "Weekly totals";

export interface XlsxExportOptions {
  /** TS-19: what to highlight; off when left out. */
  overtime?: OvertimeThresholds;
  /** The org's week_start (monday..sunday), for the weekly totals. */
  weekStart?: string | null;
  /** TS-25: the people's day notes, for the per-day Work done column. */
  dayNotes?: DayNote[];
  /** LV-05/06: the people's leave days, for the Leave column. */
  leave?: LeaveDay[];
}

/** Decimal hours as a number cell: the CSV's rounded value ("7.43" -> 7.43). */
function hoursCell(seconds: number, style: { bold?: boolean; highlight?: boolean } = {}): XlsxCell {
  return { value: Number(decimalHours(seconds)), style: { ...style, hours: true } };
}

function durationXlsxCells(
  d: Durations,
  style: { bold?: boolean } = {},
  highlightWorked = false,
): XlsxCell[] {
  return DURATION_COLUMNS.flatMap(([key]): XlsxCell[] => {
    const highlight = highlightWorked && key === "worked";
    return [
      hoursCell(d[key], highlight ? { ...style, highlight } : style),
      { value: clockHours(d[key]), style: highlight ? { ...style, highlight } : style },
    ];
  });
}

/** Widths from the longest text per column (header included), within sensible bounds. */
function widthsOf(rows: XlsxCell[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      const value = cell !== null && typeof cell === "object" ? cell.value : cell;
      const length = value === null || value === undefined ? 0 : String(value).length;
      widths[i] = Math.max(widths[i] ?? 0, length);
    });
  }
  return widths.map((w) => Math.min(48, Math.max(8, w + 2)));
}

/**
 * Per person per week, from the exported segments: worked time, highlighted above the
 * weekly threshold. Only the days in the export count, so a range that cuts a week (or a
 * client, project or status filter) gives that week's exported time, not the whole week.
 */
function weeklySheet(
  segments: ExportSegment[],
  weeklyHours: number,
  weekStart: string | null | undefined,
): XlsxSheet {
  const weeks = new Map<string, { s: ExportSegment; week: string; worked: Durations }>();
  for (const s of segments) {
    const week = weekOf(s.day, weekStart);
    const key = `${s.userId}\u0000${week}`;
    let w = weeks.get(key);
    if (!w) {
      w = { s, week, worked: emptyDurations() };
      weeks.set(key, w);
    }
    addSegment(w.worked, s);
  }
  const sorted = [...weeks.values()].sort((a, b) =>
    compareKeys([a.s.employee, a.s.userId, a.week], [b.s.employee, b.s.userId, b.week]),
  );
  const bold = { bold: true };
  const rows: XlsxCell[][] = [
    ["Employee", "Email", "Week starting", "Worked (h)", "Worked (H:MM)"].map((h) => ({
      value: h,
      style: bold,
    })),
    ...sorted.map((w): XlsxCell[] => {
      const highlight = isOver(w.worked.worked, weeklyHours);
      return [
        w.s.employee,
        w.s.email,
        w.week,
        hoursCell(w.worked.worked, highlight ? { highlight } : {}),
        { value: clockHours(w.worked.worked), style: highlight ? { highlight } : {} },
      ];
    }),
  ];
  return { name: WEEKLY_SHEET_NAME, rows, widths: widthsOf(rows), freezeHeader: true };
}

/**
 * The view as an XLSX workbook: the same header, rows and Total row as the CSV, with
 * decimal hours as numbers (rounded to 2 places, like the CSV) and H:MM as text.
 * TS-19: in the per-day view, a day's Worked cells are highlighted when that row's worked
 * time is above the daily threshold; with a weekly threshold, a "Weekly totals" sheet
 * follows, its Worked cells highlighted above it. A cell is highlighted only when the
 * number in it is above the threshold. The CSV carries no highlighting.
 */
export function exportXlsx(
  view: ExportView,
  segments: ExportSegment[],
  options: XlsxExportOptions = {},
): Uint8Array {
  const overtime = options.overtime ?? NO_OVERTIME;
  const table = buildExport(view, segments, options.dayNotes ?? [], options.leave ?? []);
  const leading = LEADING[view];
  const bold = { bold: true };
  const rows: XlsxCell[][] = [
    exportHeader(view).map((h) => ({ value: h, style: bold })),
    ...table.rows.map((r): XlsxCell[] => [
      ...r.labels,
      ...durationXlsxCells(
        r.seconds,
        {},
        view === "daily" && isOver(r.seconds.worked, overtime.dailyHours),
      ),
      r.status,
      r.approver,
      ...r.trailing,
    ]),
    [
      { value: "Total", style: bold },
      ...leading.slice(1).map(() => ""),
      ...durationXlsxCells(table.total, bold),
      "",
      "",
      ...TRAILING[view].map(() => ""),
    ],
  ];
  const sheets: XlsxSheet[] = [
    { name: XLSX_SHEET_NAMES[view], rows, widths: widthsOf(rows), freezeHeader: true },
  ];
  if (overtime.weeklyHours !== null) {
    sheets.push(weeklySheet(segments, overtime.weeklyHours, options.weekStart));
  }
  return xlsxWorkbook(sheets);
}
