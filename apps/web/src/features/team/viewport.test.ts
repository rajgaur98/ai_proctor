import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHAIRS_K,
  centerOf,
  centerOn,
  clampView,
  contains,
  DOTS_K,
  detailFor,
  fitRect,
  type Limits,
  panBy,
  parseSavedView,
  type Rect,
  toCanvas,
  toScreen,
  tween,
  type View,
  visibleRect,
  wheelZoom,
  zoomAt,
  zoomLimits,
} from "./viewport";

const close = (a: number, b: number, eps = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(eps * Math.max(1, Math.abs(a), Math.abs(b)));

const limits: Limits = { min: 0.05, max: 2 };
const size = { width: 1200, height: 700 };
const coord = fc.double({ min: -5000, max: 5000, noNaN: true });
const view = fc.record({
  x: coord,
  y: coord,
  k: fc.double({ min: limits.min, max: limits.max, noNaN: true }),
});
const point = fc.record({
  x: fc.double({ min: 0, max: size.width, noNaN: true }),
  y: fc.double({ min: 0, max: size.height, noNaN: true }),
});
const factor = fc.double({ min: 0.2, max: 5, noNaN: true });
const rect = fc.record({
  x: coord,
  y: coord,
  w: fc.double({ min: 10, max: 20000, noNaN: true }),
  h: fc.double({ min: 10, max: 20000, noNaN: true }),
});

describe("zoomAt", () => {
  it("keeps the canvas point under the pointer where it is", () => {
    fc.assert(
      fc.property(view, factor, point, (v, f, p) => {
        const before = toCanvas(v, p.x, p.y);
        const after = toCanvas(zoomAt(v, f, p.x, p.y, limits), p.x, p.y);
        close(after.x, before.x);
        close(after.y, before.y);
      }),
    );
  });

  it("never goes past the limits, however many steps", () => {
    fc.assert(
      fc.property(view, fc.array(factor, { maxLength: 30 }), point, (v, fs, p) => {
        const end = fs.reduce((acc, f) => zoomAt(acc, f, p.x, p.y, limits), v);
        expect(end.k).toBeGreaterThanOrEqual(limits.min);
        expect(end.k).toBeLessThanOrEqual(limits.max);
      }),
    );
  });

  it("zooming in then out by the same step comes back (within the limits)", () => {
    fc.assert(
      fc.property(view, factor, point, (v, f, p) => {
        const there = zoomAt(v, f, p.x, p.y, limits);
        fc.pre(there.k === v.k * f);
        const back = zoomAt(there, 1 / f, p.x, p.y, limits);
        close(back.k, v.k);
        close(back.x, v.x, 1e-6);
        close(back.y, v.y, 1e-6);
      }),
    );
  });
});

describe("panBy and the coordinate maps", () => {
  it("pans add up and screen and canvas map back and forth", () => {
    fc.assert(
      fc.property(view, coord, coord, coord, coord, (v, a, b, c, d) => {
        const once = panBy(panBy(v, a, b), c, d);
        const both = panBy(v, a + c, b + d);
        close(once.x, both.x);
        close(once.y, both.y);
        const s = toScreen(v, a, b);
        const back = toCanvas(v, s.x, s.y);
        close(back.x, a, 1e-6);
        close(back.y, b, 1e-6);
      }),
    );
  });

  it("the visible rect is the screen's corners on the canvas", () => {
    fc.assert(
      fc.property(view, (v) => {
        const r = visibleRect(v, size);
        const end = toCanvas(v, size.width, size.height);
        close(r.x + r.w, end.x);
        close(r.y + r.h, end.y);
      }),
    );
  });
});

describe("fitRect", () => {
  it("shows all of the rect, centred, when the limits allow", () => {
    fc.assert(
      fc.property(rect, (r) => {
        const v = fitRect(r, size, 24, { min: 0.0001, max: 100 });
        const seen = visibleRect(v, size);
        const slack = 1e-6 * Math.max(r.w, r.h, Math.abs(r.x), Math.abs(r.y));
        expect(
          contains(
            { x: seen.x - slack, y: seen.y - slack, w: seen.w + 2 * slack, h: seen.h + 2 * slack },
            r,
          ),
        ).toBe(true);
        const c = centerOf(v, size);
        close(c.x, r.x + r.w / 2, 1e-6);
        close(c.y, r.y + r.h / 2, 1e-6);
      }),
    );
  });

  it("stops at the closest zoom allowed", () => {
    const v = fitRect({ x: 0, y: 0, w: 10, h: 10 }, size, 24, limits);
    expect(v.k).toBe(limits.max);
  });
});

describe("zoomLimits", () => {
  it("lets the viewer zoom out past fitting everything and down to blocks", () => {
    fc.assert(
      fc.property(rect, (r) => {
        const l = zoomLimits(r, size);
        const fit = fitRect(r, size, 24, { min: 0, max: 100 });
        expect(l.min).toBeLessThanOrEqual(fit.k);
        expect(l.min).toBeLessThan(DOTS_K);
        expect(l.max).toBeGreaterThan(CHAIRS_K);
      }),
    );
  });
});

describe("clampView", () => {
  it("always leaves some of the canvas on screen, and leaves a view that does alone", () => {
    const content: Rect = { x: 0, y: 0, w: 3000, h: 2000 };
    fc.assert(
      fc.property(view, (v) => {
        const c = clampView(v, content, size, 80);
        const seen = visibleRect(c, size);
        expect(seen.x < content.x + content.w && content.x < seen.x + seen.w).toBe(true);
        expect(seen.y < content.y + content.h && content.y < seen.y + seen.h).toBe(true);
        expect(clampView(c, content, size, 80)).toEqual(c);
      }),
    );
  });
});

describe("tween", () => {
  it("starts at a, ends at b, and keeps the zoom between them", () => {
    fc.assert(
      fc.property(view, view, fc.double({ min: 0, max: 1, noNaN: true }), (a, b, t) => {
        expect(tween(a, b, 0, size)).toEqual(a);
        expect(tween(a, b, 1, size)).toEqual(b);
        const mid = tween(a, b, t, size);
        expect(mid.k).toBeGreaterThanOrEqual(Math.min(a.k, b.k) * (1 - 1e-9));
        expect(mid.k).toBeLessThanOrEqual(Math.max(a.k, b.k) * (1 + 1e-9));
      }),
    );
  });
});

describe("detailFor", () => {
  it("goes blocks, dots, chairs as the zoom grows", () => {
    expect(detailFor(0.05)).toBe("blocks");
    expect(detailFor(DOTS_K)).toBe("dots");
    expect(detailFor(CHAIRS_K)).toBe("chairs");
    const rank = { blocks: 0, dots: 1, chairs: 2 };
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 2, noNaN: true }),
        fc.double({ min: 0.01, max: 2, noNaN: true }),
        (a, b) => {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          expect(rank[detailFor(lo)]).toBeLessThanOrEqual(rank[detailFor(hi)]);
        },
      ),
    );
  });
});

describe("saved views and the wheel", () => {
  it("reads back what was saved and ignores anything else", () => {
    const v: View = centerOn(120, 340, 0.5, size);
    const c = centerOf(v, size);
    expect(parseSavedView(JSON.stringify({ cx: c.x, cy: c.y, k: v.k }))).toEqual({
      cx: c.x,
      cy: c.y,
      k: 0.5,
    });
    for (const bad of [
      null,
      "",
      "nope",
      "{}",
      '{"cx":1,"cy":2,"k":0}',
      '{"cx":"1","cy":2,"k":1}',
    ]) {
      expect(parseSavedView(bad)).toBeNull();
    }
  });

  it("zooms in on a pinch out, out on a pinch in, and caps a wheel notch", () => {
    expect(wheelZoom(-10)).toBeGreaterThan(1);
    expect(wheelZoom(10)).toBeLessThan(1);
    expect(wheelZoom(1000)).toBe(wheelZoom(60));
  });
});
