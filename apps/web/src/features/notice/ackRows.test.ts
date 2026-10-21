import { describe, expect, it } from "vitest";
import { type AckRow, ackCounts, ackReportCsv, filterAcks, isBlocked } from "./ackRows";

const row = (over: Partial<AckRow>): AckRow => ({
  userId: "u",
  fullName: "Erin Employee",
  email: "erin@acme.test",
  role: "employee",
  managerName: "Max Manager",
  acknowledgedVersion: 2,
  acknowledgedAt: "2026-10-20T14:03:00+00:00",
  acknowledgedCurrent: true,
  ...over,
});

const rows = [
  row({ userId: "1" }),
  row({ userId: "2", acknowledgedVersion: 1, acknowledgedCurrent: false }),
  row({ userId: "3", acknowledgedVersion: null, acknowledgedAt: null, acknowledgedCurrent: false }),
];

describe("filterAcks", () => {
  it("filters on the current version", () => {
    expect(filterAcks(rows, "all").map((r) => r.userId)).toEqual(["1", "2", "3"]);
    expect(filterAcks(rows, "acknowledged_current").map((r) => r.userId)).toEqual(["1"]);
    expect(filterAcks(rows, "not_yet").map((r) => r.userId)).toEqual(["2", "3"]);
  });
});

describe("counts and blocked", () => {
  it("is blocked only when no version was ever acknowledged", () => {
    expect(rows.map(isBlocked)).toEqual([false, false, true]);
    expect(ackCounts(rows)).toEqual({ total: 3, current: 1, blocked: 1 });
  });
});

describe("ackReportCsv", () => {
  it("writes a header and a row per person", () => {
    expect(ackReportCsv(rows)).toBe(
      [
        "Name,Email,Role,Manager,Acknowledged version,Acknowledged at (UTC),Acknowledged current version,Blocked from clocking in",
        "Erin Employee,erin@acme.test,Employee,Max Manager,2,2026-10-20T14:03:00.000Z,Yes,No",
        "Erin Employee,erin@acme.test,Employee,Max Manager,1,2026-10-20T14:03:00.000Z,No,No",
        "Erin Employee,erin@acme.test,Employee,Max Manager,,,No,Yes",
        "",
      ].join("\r\n"),
    );
  });

  it("defuses a name that would run as a formula", () => {
    const csv = ackReportCsv([
      row({ fullName: '=HYPERLINK("http://evil","x")', managerName: null }),
    ]);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
  });
});
