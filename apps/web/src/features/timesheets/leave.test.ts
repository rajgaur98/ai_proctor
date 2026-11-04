import { describe, expect, it } from "vitest";
import { leaveByDay, leaveByUser, leaveLabel, leaveTotal, onlyUnpaid, toLeaveItems } from "./leave";

const vacation = { name: "Vacation", paid: true, holiday: false, part_day: false };

describe("leave on the timesheet (LV-05)", () => {
  it("adds up the week's days from raw seconds, leaving other days out", () => {
    const byDay = leaveByDay([
      { day: "2026-11-23", seconds: 28800, items: [vacation] },
      { day: "2026-11-24", seconds: 9001, items: [vacation] },
      { day: "2026-11-30", seconds: 28800, items: [vacation] },
    ]);
    expect(leaveTotal(byDay, ["2026-11-23", "2026-11-24", "2026-11-25"])).toBe(37801);
  });

  it("adds up per person", () => {
    expect(
      leaveByUser([
        { userId: "a", seconds: 100 },
        { userId: "b", seconds: 5 },
        { userId: "a", seconds: 20 },
      ]),
    ).toEqual(
      new Map([
        ["a", 120],
        ["b", 5],
      ]),
    );
  });

  it("names the leave, unpaid included", () => {
    const unpaid = { day: "d", seconds: 0, items: [{ ...vacation, name: "Unpaid", paid: false }] };
    expect(leaveLabel(unpaid)).toBe("Unpaid (unpaid)");
    expect(onlyUnpaid(unpaid)).toBe(true);
    expect(leaveLabel({ day: "d", seconds: 3600, items: [] })).toBe("Leave");
  });

  it("reads the database's items and drops anything else", () => {
    expect(
      toLeaveItems([
        { name: "Thanksgiving", paid: true, holiday: true, part_day: false },
        { nope: 1 },
        null,
      ]),
    ).toEqual([{ name: "Thanksgiving", paid: true, holiday: true, part_day: false }]);
    expect(toLeaveItems(null)).toEqual([]);
  });
});
