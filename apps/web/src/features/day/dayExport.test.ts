import { describe, expect, it } from "vitest";
import type { CheckinRow } from "./dayData";
import {
  APPS_HEADER,
  appsTable,
  CHECKIN_HEADER,
  captureCells,
  checkinsTable,
  SEGMENT_HEADER,
  segmentsTable,
} from "./dayExport";
import { noneRemoved } from "./removedText";

function checkin(extra: Partial<CheckinRow>): CheckinRow {
  return {
    id: "c1",
    scheduledAt: "2026-10-19T09:00:00Z",
    shownAt: "2026-10-19T09:00:05Z",
    respondedAt: "2026-10-19T09:00:07Z",
    outcome: "pass",
    deferralReason: null,
    responseMs: 1840,
    wrongClicks: 0,
    idleSAtShow: null,
    deviceState: "active",
    missedReason: null,
    missedReasonKind: null,
    projectId: "p1",
    objectKeys: ["screen-1.webp", "screen-2.webp", "webcam.webp"],
    facePresent: true,
    removed: noneRemoved,
    ...extra,
  };
}

const project = (id: string | null) => (id === "p1" ? "Website" : "Unassigned");

describe("captureCells", () => {
  it("counts the kept screenshots and the webcam frame of a pass", () => {
    expect(captureCells(checkin({}), "UTC")).toEqual([2, "Yes", "", ""]);
  });

  it("shows removed parts and the latest removal time, never the files", () => {
    const cells = captureCells(
      checkin({
        removed: {
          webcam: "2026-10-20T08:00:00Z",
          screen: null,
          apps: "2026-10-21T08:00:00Z",
          domains: null,
        },
      }),
      "UTC",
    );
    expect(cells).toEqual([2, "Removed", "Webcam, Apps", "2026-10-21T08:00:00Z"]);
    const screen = captureCells(
      checkin({ removed: { ...noneRemoved, screen: "2026-10-20T08:00:00Z" } }),
      "UTC",
    );
    expect(screen.slice(0, 3)).toEqual([0, "Yes", "Screen"]);
  });

  it("has no captures for anything but a pass", () => {
    expect(captureCells(checkin({ outcome: "miss", objectKeys: [] }), "UTC")).toEqual([
      0,
      "No",
      "",
      "",
    ]);
  });
});

describe("checkinsTable", () => {
  it("has a row per check-in with the result, reason, remark and captures", () => {
    const table = checkinsTable(
      [
        checkin({}),
        checkin({
          id: "c2",
          outcome: "miss",
          shownAt: "2026-10-19T10:00:00Z",
          responseMs: null,
          missedReasonKind: "meeting",
          missedReason: "  Client call ",
          objectKeys: [],
          projectId: null,
        }),
        checkin({
          id: "c3",
          outcome: "deferred",
          shownAt: null,
          scheduledAt: "2026-10-19T11:00:00Z",
          deferralReason: "call",
          objectKeys: [],
        }),
      ],
      project,
      (id) => id === "c1",
      "Asia/Kolkata",
    );
    expect(table.header).toEqual(CHECKIN_HEADER);
    expect(table.rows).toEqual([
      [
        "2026-10-19T14:30:05+05:30",
        "Passed",
        1.8,
        "",
        "",
        "Website",
        2,
        "Yes",
        "",
        "",
        "No",
        "Yes",
      ],
      [
        "2026-10-19T15:30:00+05:30",
        "Missed",
        null,
        "Meeting",
        "Client call",
        "Unassigned",
        0,
        "No",
        "",
        "",
        "No",
        "No",
      ],
      [
        "2026-10-19T16:30:00+05:30",
        "Deferred",
        null,
        "On a call",
        "",
        "Website",
        0,
        "No",
        "",
        "",
        "No",
        "No",
      ],
    ]);
  });

  it("marks a pass without a face as no face detected", () => {
    const [row] = checkinsTable(
      [checkin({ facePresent: false })],
      project,
      () => false,
      "UTC",
    ).rows;
    expect(row?.[CHECKIN_HEADER.indexOf("No face detected")]).toBe("Yes");
  });
});

describe("segmentsTable", () => {
  it("has start, end, type, project, task, decimal hours from raw seconds and the flags", () => {
    const table = segmentsTable(
      [
        {
          type: "verified",
          start: Date.parse("2026-10-19T09:00:00Z"),
          end: Date.parse("2026-10-19T10:30:10Z"),
          projectId: "p1",
          taskId: "t1",
          counted: true,
          flagged: false,
          excluded: false,
        },
        {
          type: "idle",
          start: Date.parse("2026-10-19T10:30:10Z"),
          end: Date.parse("2026-10-19T10:35:10Z"),
          projectId: null,
          taskId: null,
          counted: true,
          flagged: true,
          excluded: true,
        },
      ],
      (t) => (t === "verified" ? "Verified" : "Idle (flagged)"),
      project,
      (id) => (id === "t1" ? "Design" : "Task"),
      "UTC",
    );
    expect(table.header).toEqual(SEGMENT_HEADER);
    expect(table.rows).toEqual([
      [
        "2026-10-19T09:00:00Z",
        "2026-10-19T10:30:10Z",
        "Verified",
        "Website",
        "Design",
        1.5,
        5410,
        "Yes",
        "No",
        "No",
      ],
      [
        "2026-10-19T10:30:10Z",
        "2026-10-19T10:35:10Z",
        "Idle (flagged)",
        "Unassigned",
        "",
        0.08,
        300,
        "Yes",
        "Yes",
        "Yes",
      ],
    ]);
  });
});

describe("appsTable", () => {
  it("lists the apps as shown, time only", () => {
    expect(
      appsTable([
        { appName: "Code", seconds: 7200 },
        { appName: "Chrome", seconds: 900 },
      ]),
    ).toEqual({
      sheet: "Apps",
      header: APPS_HEADER,
      rows: [
        ["Code", 2, 7200],
        ["Chrome", 0.25, 900],
      ],
    });
  });
});
