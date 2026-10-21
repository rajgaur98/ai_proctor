import { describe, expect, it } from "vitest";
import { chartNote, clampPageIndex, needsPager, pageCount, pageWindow } from "./paging";

describe("pageCount", () => {
  it("rounds up and is never less than one page", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(1, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(503, 50)).toBe(11);
    expect(pageCount(1000, 100)).toBe(10);
  });
});

describe("clampPageIndex", () => {
  it("keeps the page inside what exists", () => {
    expect(clampPageIndex(-3, 120, 50)).toBe(0);
    expect(clampPageIndex(2, 120, 50)).toBe(2);
    expect(clampPageIndex(5, 120, 50)).toBe(2);
    expect(clampPageIndex(4, 0, 50)).toBe(0);
  });
});

describe("pageWindow", () => {
  it("numbers the rows on a page from 1", () => {
    expect(pageWindow(0, 503, 50)).toEqual({ first: 1, last: 50 });
    expect(pageWindow(1, 503, 50)).toEqual({ first: 51, last: 100 });
    expect(pageWindow(10, 503, 50)).toEqual({ first: 501, last: 503 });
  });

  it("is empty for no rows and clamps a page past the end", () => {
    expect(pageWindow(0, 0, 50)).toEqual({ first: 0, last: 0 });
    expect(pageWindow(9, 120, 50)).toEqual({ first: 101, last: 120 });
  });

  it("covers every row exactly once across the pages", () => {
    const total = 503;
    const size = 25;
    let next = 1;
    for (let page = 0; page < pageCount(total, size); page++) {
      const w = pageWindow(page, total, size);
      expect(w.first).toBe(next);
      next = w.last + 1;
    }
    expect(next).toBe(total + 1);
  });
});

describe("needsPager", () => {
  it("is off while everyone fits the smallest page", () => {
    expect(needsPager(4)).toBe(false);
    expect(needsPager(25)).toBe(false);
    expect(needsPager(26)).toBe(true);
  });
});

describe("chartNote", () => {
  it("says nothing when the chart shows everyone", () => {
    expect(chartNote(25, 25, { id: "worked", desc: true }, "Worked")).toBeNull();
    expect(chartNote(4, 4, undefined, "")).toBeNull();
  });

  it("names the table's order when it cuts the list", () => {
    expect(chartNote(25, 503, { id: "worked", desc: true }, "Worked")).toBe(
      "Showing 25 of 503 by worked, highest first",
    );
    expect(chartNote(25, 503, { id: "late", desc: false }, "Late clock-ins")).toBe(
      "Showing 25 of 503 by late clock-ins, lowest first",
    );
    expect(chartNote(25, 503, { id: "person", desc: false }, "Person")).toBe(
      "Showing 25 of 503 by person, A to Z",
    );
    expect(chartNote(25, 503, { id: "person", desc: true }, "Person")).toBe(
      "Showing 25 of 503 by person, Z to A",
    );
  });
});
