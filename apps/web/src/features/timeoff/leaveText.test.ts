import { describe, expect, it } from "vitest";
import { offByDay, twoWeeks } from "./calendar";
import { explain, holidayPlace, leaveDays, leaveLength, leaveWhen, statusLabel } from "./leaveText";
import { requestProblem } from "./RequestDialog";
import type { LeaveRequest } from "./timeOffData";

const days = {
  kind: "days",
  firstDay: "2026-11-16",
  lastDay: "2026-11-20",
  startAt: "2026-11-16T08:00:00+00:00",
  endAt: "2026-11-21T08:00:00+00:00",
  timezone: "America/Los_Angeles",
};
const part = {
  kind: "part_day",
  firstDay: "2026-12-04",
  lastDay: "2026-12-04",
  startAt: "2026-12-04T21:00:00+00:00",
  endAt: "2026-12-04T23:30:00+00:00",
  timezone: "America/Los_Angeles",
};

describe("leaveWhen", () => {
  it("reads whole days as the person's own dates", () => {
    expect(leaveWhen(days)).toBe("Mon 16 Nov – Fri 20 Nov 2026");
    expect(leaveWhen({ ...days, lastDay: days.firstDay })).toBe("Mon 16 Nov 2026");
  });

  it("reads a part day's times in the zone the person asked in, named", () => {
    expect(leaveWhen(part)).toBe("Fri 4 Dec 2026, 13:00–15:30 PST");
  });
});

describe("leaveLength", () => {
  it("counts whole days, both ends included, and a part day's time", () => {
    expect(leaveDays(days)).toBe(5);
    expect(leaveLength(days)).toBe("5 days");
    expect(leaveLength({ ...days, lastDay: days.firstDay })).toBe("1 day");
    expect(leaveDays(part)).toBe(0);
    expect(leaveLength(part)).toBe("2 h 30 min");
  });
});

describe("labels", () => {
  it("names states, places and errors", () => {
    expect(statusLabel("rejected")).toBe("Declined");
    expect(statusLabel("pending")).toBe("Pending");
    expect(holidayPlace(null, null)).toBe("Everyone");
    expect(holidayPlace("US", null)).toBe("US");
    expect(holidayPlace("US", "CA")).toBe("US · CA");
    expect(explain("leave_overlaps")).toMatch(/already have time off/);
    expect(explain("something_new")).toBe("something_new");
  });
});

describe("requestProblem", () => {
  const ok = {
    typeId: "t",
    partDay: false,
    firstDay: "2026-11-16",
    lastDay: "2026-11-20",
    start: "13:00",
    end: "15:00",
  };
  it("accepts a whole-day and a part-day request", () => {
    expect(requestProblem(ok)).toBeNull();
    expect(requestProblem({ ...ok, partDay: true, lastDay: "" })).toBeNull();
  });
  it("names what is missing or out of order", () => {
    expect(requestProblem({ ...ok, typeId: "" })).toMatch(/type/);
    expect(requestProblem({ ...ok, lastDay: "2026-11-15" })).toMatch(/last day/);
    expect(requestProblem({ ...ok, partDay: true, end: "12:00" })).toMatch(/end time/);
  });
});

describe("team calendar", () => {
  const req = (over: Partial<LeaveRequest>): LeaveRequest => ({
    id: "r",
    userId: "u",
    employeeName: "Erin Employee",
    typeId: "t",
    typeName: "Vacation",
    paid: true,
    note: null,
    status: "approved",
    decidedByName: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: "",
    canDecide: false,
    canCancel: false,
    ...days,
    ...over,
  });

  it("covers this week and next from Monday", () => {
    const d = twoWeeks("2026-11-18");
    expect(d).toHaveLength(14);
    expect(d[0]).toBe("2026-11-16");
    expect(d[13]).toBe("2026-11-29");
  });

  it("lists approved leave on each of its days, and the holidays", () => {
    const out = offByDay(
      ["2026-11-15", "2026-11-16", "2026-11-26"],
      [
        req({}),
        req({ id: "p", employeeName: "Lucas Martin", status: "pending" }),
        req({
          id: "q",
          employeeName: "Ada Admin",
          ...part,
          firstDay: "2026-11-16",
          lastDay: "2026-11-16",
        }),
      ],
      [{ id: "h", day: "2026-11-26", name: "Thanksgiving", country: "US", state: null }],
    );
    expect(out[0]?.people).toEqual([]);
    expect(out[1]?.people).toEqual([
      { name: "Ada Admin", typeName: "Vacation", partDay: true },
      { name: "Erin Employee", typeName: "Vacation", partDay: false },
    ]);
    expect(out[2]?.people).toEqual([]);
    expect(out[2]?.holidays.map((h) => h.name)).toEqual(["Thanksgiving"]);
  });
});
