import { billingCatalog, workTotals } from "@ai-proctor/core";
import { describe, expect, it } from "vitest";
import type { ManualEntry } from "../day/entryData";
import type { DayList } from "./dayList";
import {
  DAY_LIST_HEADER,
  dayListTable,
  SHEET_LIST_HEADER,
  sheetListTable,
  TOTALS_HEADER,
  totalsTable,
} from "./sheetExport";
import type { ListRow, SheetStatus } from "./timesheetData";

const statusText: Record<SheetStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  returned: "Returned",
};

const catalog = billingCatalog(
  [
    { id: "p1", clientId: "c1", billable: true },
    { id: "p2", clientId: null, billable: false },
  ],
  [{ id: "t1", billable: false }],
);

function listRow(extra: Partial<ListRow>): ListRow {
  return {
    id: "s1",
    userId: "u1",
    periodStart: "2026-10-19",
    status: "submitted",
    submittedAt: null,
    approvedAt: null,
    returnedAt: null,
    comment: null,
    lateDataAt: null,
    lateDataLastAt: null,
    lateDataCount: 0,
    fullName: "Erin Employee",
    timezone: "UTC",
    workedS: 0,
    flaggedS: 0,
    excludedS: 0,
    assigned: [],
    ...extra,
  };
}

describe("sheetListTable", () => {
  it("has the list's columns in decimal hours from raw seconds", () => {
    const table = sheetListTable(
      [
        listRow({
          workedS: 41 * 3600 + 30,
          flaggedS: 1800,
          assigned: [
            { projectId: "p1", taskId: null, seconds: 30 * 3600 },
            { projectId: "p1", taskId: "t1", seconds: 3600 },
            { projectId: null, seconds: 10 * 3600 + 30 },
          ],
        }),
        listRow({
          fullName: "Ada Admin",
          status: "approved",
          lateDataCount: 2,
          lateDataAt: "2026-10-26T09:00:00Z",
          workedS: 3600,
        }),
      ],
      "2026-10-19",
      catalog,
      40,
      statusText,
    );
    expect(table.header).toEqual(SHEET_LIST_HEADER);
    expect(table.rows).toEqual([
      ["Erin Employee", "2026-10-19", "Submitted", "No", 41.01, 30, 11.01, 0.5, "Yes"],
      ["Ada Admin", "2026-10-19", "Approved", "Yes", 1, 0, 0, 0, "No"],
    ]);
  });

  it("leaves overtime empty without a weekly threshold", () => {
    const [row] = sheetListTable([listRow({})], "2026-10-19", catalog, null, statusText).rows;
    expect(row?.at(-1)).toBe("");
  });
});

describe("totalsTable", () => {
  it("has the total, then by client, by project and by task", () => {
    const totals = workTotals(
      [
        { projectId: "p1", taskId: "t1", seconds: 3600 },
        { projectId: "p1", taskId: null, seconds: 7200 },
        { projectId: null, seconds: 900 },
      ],
      catalog,
    );
    const table = totalsTable(totals, {
      client: (c) => (c.unassigned ? "Unassigned" : c.clientId === "c1" ? "Acme" : "No client"),
      project: (id) => (id === "p1" ? "Website" : "Unassigned"),
      task: (projectId, taskId) =>
        projectId === null ? "Unassigned" : `Website › ${taskId ? "Design" : "No task"}`,
    });
    expect(table.header).toEqual(TOTALS_HEADER);
    expect(table.rows[0]).toEqual(["Total", "All worked time", 3.25, 2, 1.25]);
    expect(table.rows.map((r) => `${r[0]}:${r[1]}`)).toEqual([
      "Total:All worked time",
      ...totals.byClient.map((c) => `Client:${c.unassigned ? "Unassigned" : "Acme"}`),
      ...totals.byProject.map((p) => `Project:${p.projectId ? "Website" : "Unassigned"}`),
      ...totals.byTask.map(
        (t) =>
          `Task:${t.projectId === null ? "Unassigned" : `Website › ${t.taskId ? "Design" : "No task"}`}`,
      ),
    ]);
    // Every group adds up to the total, from raw seconds.
    for (const group of ["Client", "Project", "Task"]) {
      const sum = totals[
        group === "Client" ? "byClient" : group === "Project" ? "byProject" : "byTask"
      ]
        .map((r) => r.seconds)
        .reduce((a, b) => a + b, 0);
      expect(sum).toBe(totals.seconds);
    }
  });
});

describe("dayListTable", () => {
  const entry: ManualEntry = {
    id: "e1",
    startAt: "2026-10-19T14:00:00Z",
    endAt: "2026-10-19T15:30:00Z",
    projectId: "p1",
    taskId: "t1",
    reason: "Offline",
    note: "Client workshop",
    status: "pending",
    decisionNote: null,
  };
  const days: DayList[] = [
    {
      day: "2026-10-19",
      items: [
        {
          kind: "tracked",
          startAt: "2026-10-19T09:00:00Z",
          endAt: "2026-10-19T12:00:20Z",
          seconds: 10820,
          projectId: "p2",
          taskId: null,
          flagged: true,
          excluded: false,
        },
        { kind: "manual", startAt: entry.startAt, endAt: entry.endAt, seconds: 5400, entry },
      ],
    },
    { day: "2026-10-20", items: [] },
  ];

  it("has a row per run and entry with the day, ISO times and decimal hours", () => {
    const table = dayListTable(
      days,
      (id) => (id === "p1" ? "Website" : id === "p2" ? "Internal" : "Unassigned"),
      (id) => (id === "t1" ? "Design" : "Task"),
      (projectId, taskId) => projectId === "p1" && taskId !== "t1",
      "America/New_York",
    );
    expect(table.header).toEqual(DAY_LIST_HEADER);
    expect(table.rows).toEqual([
      [
        "2026-10-19",
        "2026-10-19T05:00:00-04:00",
        "2026-10-19T08:00:20-04:00",
        3.01,
        10820,
        "Tracked · flagged",
        "Internal",
        "",
        "No",
        "",
      ],
      [
        "2026-10-19",
        "2026-10-19T10:00:00-04:00",
        "2026-10-19T11:30:00-04:00",
        1.5,
        5400,
        "Manual · pending, not counted",
        "Website",
        "Design",
        "No",
        "Client workshop",
      ],
    ]);
  });
});
