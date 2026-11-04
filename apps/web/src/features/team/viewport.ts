// Zoom and pan for the seat map's canvas (DSH-11, #308), hand-rolled and pure so the
// invariants can be property-tested. A view maps the canvas to the screen:
// screen = canvas × k + (x, y).

export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Limits {
  min: number;
  max: number;
}

/** Zoomed in this far or more, chairs show initials and can be hovered and clicked. */
export const CHAIRS_K = 0.7;
/** Below this, each table is a block with its counts; between the two, chairs are dots. */
export const DOTS_K = 0.22;
/** The most a viewer can zoom in. */
export const MAX_K = 2;
/** One press of + or −. */
export const ZOOM_STEP = 1.25;

export type Detail = "blocks" | "dots" | "chairs";

/** What is drawn at zoom `k`. */
export function detailFor(k: number): Detail {
  return k >= CHAIRS_K ? "chairs" : k >= DOTS_K ? "dots" : "blocks";
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** From the screen to the canvas. */
export function toCanvas(v: View, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k };
}

/** From the canvas to the screen. */
export function toScreen(v: View, cx: number, cy: number): { x: number; y: number } {
  return { x: cx * v.k + v.x, y: cy * v.k + v.y };
}

/** The part of the canvas on screen. */
export function visibleRect(v: View, size: Size): Rect {
  const a = toCanvas(v, 0, 0);
  return { x: a.x, y: a.y, w: size.width / v.k, h: size.height / v.k };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** Zooms by `factor`, keeping the canvas point under the screen point (sx, sy) where it is. */
export function zoomAt(v: View, factor: number, sx: number, sy: number, limits: Limits): View {
  const k = clamp(v.k * factor, limits.min, limits.max);
  const p = toCanvas(v, sx, sy);
  return { x: sx - p.x * k, y: sy - p.y * k, k };
}

export function panBy(v: View, dx: number, dy: number): View {
  return { x: v.x + dx, y: v.y + dy, k: v.k };
}

/** The view with the canvas point (cx, cy) in the middle of the screen at zoom `k`. */
export function centerOn(cx: number, cy: number, k: number, size: Size): View {
  return { x: size.width / 2 - cx * k, y: size.height / 2 - cy * k, k };
}

/** The canvas point in the middle of the screen. */
export function centerOf(v: View, size: Size): { x: number; y: number } {
  return toCanvas(v, size.width / 2, size.height / 2);
}

/** The zoom at which `rect` fits the screen inside `pad` pixels on every side. */
export function fitZoom(rect: Rect, size: Size, pad: number): number {
  const w = Math.max(1, size.width - 2 * pad);
  const h = Math.max(1, size.height - 2 * pad);
  return Math.min(w / Math.max(rect.w, 1), h / Math.max(rect.h, 1));
}

/** The view showing all of `rect`, centred, as large as `limits` allow. */
export function fitRect(rect: Rect, size: Size, pad: number, limits: Limits): View {
  const k = clamp(fitZoom(rect, size, pad), limits.min, limits.max);
  return centerOn(rect.x + rect.w / 2, rect.y + rect.h / 2, k, size);
}

/** How far a viewer can zoom for a canvas of this size: out a little past "Fit all", in to 200%. */
export function zoomLimits(content: Rect, size: Size): Limits {
  const fit = fitZoom(content, size, 24);
  return { min: Math.max(0.01, Math.min(0.1, fit * 0.8)), max: MAX_K };
}

/**
 * Keeps some of the canvas on screen: at least `margin` pixels of it (or all of it, if
 * smaller) in each direction, so a viewer can't pan away into nothing.
 */
export function clampView(v: View, content: Rect, size: Size, margin: number): View {
  const axis = (offset: number, start: number, length: number, screen: number) => {
    const lo = start * v.k;
    const len = length * v.k;
    const keep = Math.min(margin, len);
    // The content spans [offset + lo, offset + lo + len]; keep `keep` of it on [0, screen].
    const min = keep - lo - len;
    const max = screen - keep - lo;
    return min > max ? (min + max) / 2 : clamp(offset, min, max);
  };
  return {
    x: axis(v.x, content.x, content.w, size.width),
    y: axis(v.y, content.y, content.h, size.height),
    k: v.k,
  };
}

/** Partway (t from 0 to 1) from view a to view b: the centre moves straight, the zoom evenly in log. */
export function tween(a: View, b: View, t: number, size: Size): View {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const ca = centerOf(a, size);
  const cb = centerOf(b, size);
  const k = Math.exp(Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * t);
  return centerOn(ca.x + (cb.x - ca.x) * t, ca.y + (cb.y - ca.y) * t, k, size);
}

/** Smooth start and stop for animated zooms. */
export function ease(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** A view saved per viewer: the canvas point in the middle and the zoom, so it survives a resize. */
export interface SavedView {
  cx: number;
  cy: number;
  k: number;
}

export function parseSavedView(raw: string | null): SavedView | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SavedView>;
    return [v.cx, v.cy, v.k].every((n) => typeof n === "number" && Number.isFinite(n)) &&
      (v.k as number) > 0
      ? { cx: v.cx as number, cy: v.cy as number, k: v.k as number }
      : null;
  } catch {
    return null;
  }
}

/** Mouse wheel (or trackpad) delta in pixels, whatever unit the browser reported it in. */
export function wheelPixels(delta: number, mode: number): number {
  return mode === 1 ? delta * 16 : mode === 2 ? delta * 400 : delta;
}

/** How much a Ctrl/Cmd + wheel step zooms: smooth for trackpad pinches, capped for wheel notches. */
export function wheelZoom(deltaPixels: number): number {
  return Math.exp(-clamp(deltaPixels, -60, 60) * 0.01);
}
