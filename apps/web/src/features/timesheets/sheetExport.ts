// Exports of the timesheet views the timesheet export (export-timesheet, #45/#65) doesn't
// cover (#255 part 2, TS-27/28): the Timesheets list's rows, a Totals panel (#266) and a
// week's Days list (#263). Hours are decimals from raw seconds (TS-05); times are ISO
// 8601 with the viewer's offset. Pure, so the columns are unit-tested.
import {
  type BillingCatalog,
  type CellValue,
  isOver,
  type WorkTotals,
  workTotals,
} from "@ai-proctor/core";
import { type ExportTable, exportHours, exportTime, yesNo } from "../../lib/exportFile";
import type { ManualEntry } from "../day/entryData";
import type { DayList } from "./dayList";
// Types only: timesheetData opens the Supabase client.
import type { ListRow, SheetStatus } from "./timesheetData";

export const SHEET_LIST_HEADER = [
  "Person",
  "Week",
  "Status",
  "New data after approval",
  "Worked (h)",
  "Billable (h)",
  "Non-billable (h)",
  "Flagged (h)",
  "Over weekly threshold",
];

/**
 * The Timesheets list's rows as shown, for `week`. Billable needs the projects' and tasks'
 * flags (`catalog`); the overtime column is empty without a weekly threshold. `status`
 * is the page's wording (timesheetData's statusLabel).
 */
export function sheetListTable(
  rows: readonly ListRow[],
  week: string,
  catalog: BillingCatalog,
  weeklyHours: number | null,
  status: Record<SheetStatus, string>,
): ExportTable {
  return {
    sheet: "Timesheets",
    header: SHEET_LIST_HEADER,
    rows: rows.map((r) => {
      const split = workTotals(r.assigned, catalog);
      return [
        r.fullName,
        week,
        status[r.status],
        yesNo(r.status === "approved" && r.lateDataCount > 0 && r.lateDataAt !== null),
        exportHours(r.workedS),
        exportHours(split.billable),
        exportHours(split.nonBillable),
        exportHours(r.flaggedS),
        weeklyHours ? yesNo(isOver(r.workedS, weeklyHours)) : "",
      ];
    }),
  };
}

/** Names for a Totals panel's rows (Totals.tsx's totalsNames). */
export interface TotalsNames {
  client: (c: WorkTotals["byClient"][number]) => string;
  project: (projectId: string | null) => string;
  task: (projectId: string | null, taskId: string | null) => string;
}

export const TOTALS_HEADER = ["Group", "Name", "Worked (h)", "Billable (h)", "Non-billable (h)"];

/**
 * A Totals panel as one table: the overall total, then the rows by client, by project
 * and by task, in the panel's order.
 */
export function totalsTable(totals: WorkTotals, names: TotalsNames): ExportTable {
  const line = (
    group: string,
    name: string,
    s: { seconds: number; billable: number; nonBillable: number },
  ): CellValue[] => [
    group,
    name,
    exportHours(s.seconds),
    exportHours(s.billable),
    exportHours(s.nonBillable),
  ];
  return {
    sheet: "Totals",
    header: TOTALS_HEADER,
    rows: [
      line("Total", "All worked time", totals),
      ...totals.byClient.map((c) => line("Client", names.client(c), c)),
      ...totals.byProject.map((p) => line("Project", names.project(p.projectId), p)),
      ...totals.byTask.map((t) => line("Task", names.task(t.projectId, t.taskId), t)),
    ],
  };
}

const entryStatus: Record<ManualEntry["status"], string> = {
  pending: "Manual · pending, not counted",
  approved: "Manual · approved",
  rejected: "Manual · rejected",
};

export const DAY_LIST_HEADER = [
  "Day",
  "Start",
  "End",
  "Hours",
  "Seconds",
  "Kind",
  "Project",
  "Task",
  "Billable",
  "Note",
];

/**
 * A week's Days list: each day's tracked runs and manual entries in time order, as the
 * list shows them. `billable` decides from the project and task, as the list does.
 */
export function dayListTable(
  days: readonly DayList[],
  projectName: (id: string | null) => string,
  taskName: (id: string | null) => string,
  billable: (projectId: string | null, taskId: string | null) => boolean,
  zone: string,
): ExportTable {
  return {
    sheet: "Days",
    header: DAY_LIST_HEADER,
    rows: days.flatMap(({ day, items }) =>
      items.map((item) => {
        const projectId = item.kind === "manual" ? item.entry.projectId : item.projectId;
        const taskId = item.kind === "manual" ? item.entry.taskId : item.taskId;
        const seconds = Math.round(item.seconds);
        return [
          day,
          exportTime(item.startAt, zone),
          exportTime(item.endAt, zone),
          exportHours(seconds),
          seconds,
          item.kind === "manual"
            ? entryStatus[item.entry.status]
            : `Tracked${item.excluded ? " · excluded" : item.flagged ? " · flagged" : ""}`,
          projectName(projectId),
          projectId && taskId ? taskName(taskId) : "",
          yesNo(billable(projectId, taskId)),
          item.kind === "manual" ? (item.entry.note ?? "") : "",
        ];
      }),
    ),
  };
}
