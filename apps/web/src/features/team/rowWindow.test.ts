import { describe, expect, it } from "vitest";
import { keyTarget, rowRange, type Slot, slots } from "./rowWindow";

describe("rowRange", () => {
  it("covers the rows on screen plus the overscan", () => {
    // Table starts 300 px down; 900 px viewport; 60 px rows: rows 0..10 visible.
    expect(rowRange(1000, 60, 300, 900, 5)).toEqual({ start: 0, end: 15 });
    // Scrolled so row 100 is at the top.
    expect(rowRange(1000, 60, -6000, 900, 5)).toEqual({ start: 95, end: 120 });
  });

  it("stops at the end of the list", () => {
    expect(rowRange(1000, 60, -59_900, 900, 5)).toEqual({ start: 993, end: 1000 });
    expect(rowRange(1000, 60, -999_999, 900, 5)).toEqual({ start: 999, end: 1000 });
  });

  it("keeps one row when the table is below the screen, so it can be measured", () => {
    expect(rowRange(1000, 60, 5000, 900, 5)).toEqual({ start: 0, end: 1 });
  });

  it("is empty for an empty list and safe with a zero row height", () => {
    expect(rowRange(0, 60, 0, 900)).toEqual({ start: 0, end: 0 });
    expect(rowRange(10, 0, 0, 5, 0)).toEqual({ start: 0, end: 5 });
  });
});

const drawn = (s: Slot[]) => s.flatMap((x) => ("index" in x ? [x.index] : []));
const height = (s: Slot[]) => s.reduce((n, x) => n + ("gap" in x ? x.gap : 1), 0);

describe("slots", () => {
  it("draws the range between two spacers that make up the rest", () => {
    const s = slots(100, { start: 40, end: 45 }, null);
    expect(s[0]).toEqual({ gap: 40, from: 0 });
    expect(drawn(s)).toEqual([40, 41, 42, 43, 44]);
    expect(s.at(-1)).toEqual({ gap: 55, from: 45 });
    expect(height(s)).toBe(100);
  });

  it("has no spacer at an edge", () => {
    expect(slots(5, { start: 0, end: 5 }, null)).toEqual(
      [0, 1, 2, 3, 4].map((index) => ({ index })),
    );
  });

  it("keeps the focused row drawn wherever it is, in its place", () => {
    const above = slots(100, { start: 40, end: 42 }, 10);
    expect(above).toEqual([
      { gap: 10, from: 0 },
      { index: 10 },
      { gap: 29, from: 11 },
      { index: 40 },
      { index: 41 },
      { gap: 58, from: 42 },
    ]);
    const below = slots(100, { start: 40, end: 42 }, 99);
    expect(below).toEqual([
      { gap: 40, from: 0 },
      { index: 40 },
      { index: 41 },
      { gap: 57, from: 42 },
      { index: 99 },
    ]);
    expect(height(above)).toBe(100);
    expect(height(below)).toBe(100);
    // Inside the range, or gone from the list: nothing extra.
    expect(drawn(slots(100, { start: 40, end: 42 }, 41))).toEqual([40, 41]);
    expect(drawn(slots(100, { start: 40, end: 42 }, 150))).toEqual([40, 41]);
  });

  it("clamps a range left over from a longer list", () => {
    const s = slots(10, { start: 40, end: 60 }, null);
    expect(drawn(s)).toEqual([]);
    expect(height(s)).toBe(10);
  });
});

describe("keyTarget", () => {
  it("moves a row, a page, or to either end, within the list", () => {
    expect(keyTarget("ArrowDown", false, 3, 10, 5)).toBe(4);
    expect(keyTarget("ArrowDown", false, 9, 10, 5)).toBe(9);
    expect(keyTarget("ArrowUp", false, 0, 10, 5)).toBe(0);
    expect(keyTarget("PageDown", false, 3, 10, 5)).toBe(8);
    expect(keyTarget("PageDown", false, 8, 10, 5)).toBe(9);
    expect(keyTarget("PageUp", false, 3, 10, 5)).toBe(0);
    expect(keyTarget("Home", false, 7, 10, 5)).toBe(0);
    expect(keyTarget("End", false, 2, 10, 5)).toBe(9);
  });

  it("tabs row to row and lets Tab leave the table at either end", () => {
    expect(keyTarget("Tab", false, 3, 10, 5)).toBe(4);
    expect(keyTarget("Tab", true, 3, 10, 5)).toBe(2);
    expect(keyTarget("Tab", false, 9, 10, 5)).toBeNull();
    expect(keyTarget("Tab", true, 0, 10, 5)).toBeNull();
  });

  it("leaves other keys alone", () => {
    expect(keyTarget("Enter", false, 3, 10, 5)).toBeNull();
    expect(keyTarget("a", false, 3, 10, 5)).toBeNull();
  });
});
