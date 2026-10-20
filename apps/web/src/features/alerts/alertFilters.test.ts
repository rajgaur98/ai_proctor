import { describe, expect, it } from "vitest";
import { cursorFilter, dateBounds, filtersActive, NO_FILTERS, splitPage } from "./alertFilters";

describe("filtersActive", () => {
  it("is off for the defaults and on for any change", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, read: "unread" })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, kind: "tamper" })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, from: "2026-10-01" })).toBe(true);
  });
});

describe("dateBounds", () => {
  it("covers whole local days, the end day included", () => {
    expect(dateBounds({ from: "2026-10-19", to: "2026-10-20" }, "UTC")).toEqual({
      from: "2026-10-19T00:00:00.000Z",
      to: "2026-10-21T00:00:00.000Z",
    });
    expect(dateBounds({ from: "2026-10-19", to: "2026-10-19" }, "Asia/Kolkata")).toEqual({
      from: "2026-10-18T18:30:00.000Z",
      to: "2026-10-19T18:30:00.000Z",
    });
  });

  it("leaves an end open when it is empty or not a date", () => {
    expect(dateBounds({ from: "", to: "" }, "UTC")).toEqual({ from: null, to: null });
    expect(dateBounds({ from: "nope", to: "2026-10-20" }, "UTC")).toEqual({
      from: null,
      to: "2026-10-21T00:00:00.000Z",
    });
  });
});

describe("cursorFilter", () => {
  it("breaks ties on the id", () => {
    expect(cursorFilter({ triggeredAt: "2026-10-20T10:00:00.123456+00:00", id: "abc" })).toBe(
      'triggered_at.lt."2026-10-20T10:00:00.123456+00:00",and(triggered_at.eq."2026-10-20T10:00:00.123456+00:00",id.lt.abc)',
    );
  });
});

describe("splitPage", () => {
  const row = (n: number) => ({ id: `id${n}`, triggeredAt: `t${n}` });

  it("has no next page when the rows fit", () => {
    expect(splitPage([row(1), row(2)], 2)).toEqual({ rows: [row(1), row(2)], next: null });
    expect(splitPage([], 2)).toEqual({ rows: [], next: null });
  });

  it("drops the extra row and points at the last one shown", () => {
    expect(splitPage([row(1), row(2), row(3)], 2)).toEqual({
      rows: [row(1), row(2)],
      next: { triggeredAt: "t2", id: "id2" },
    });
  });
});
