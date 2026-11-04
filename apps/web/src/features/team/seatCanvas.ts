// Draws the seat map (DSH-11, #308) on a 2D canvas: only the tables on screen, at the
// detail the zoom calls for. Nothing here is read by assistive technology; the component
// keeps a list of tables and chairs alongside for that (DSH-09).
import {
  CHAIR_SIZE,
  type PlacedTable,
  type SeatLayout,
  type SeatTone,
  TABLE_RADIUS,
  tableBody,
} from "./seats";
import { type Detail, intersects, type Size, toScreen, type View, visibleRect } from "./viewport";

/** The design tokens the drawing uses, read from CSS so light and dark both work. */
export interface Palette {
  panel: string;
  sunk: string;
  line2: string;
  ink: string;
  ink2: string;
  ink3: string;
  active: string;
  inactive: string;
  acc: string;
}

const TOKENS: Record<keyof Palette, string> = {
  panel: "--panel",
  sunk: "--sunk",
  line2: "--line2",
  ink: "--ink",
  ink2: "--ink2",
  ink3: "--ink3",
  active: "--sactive",
  inactive: "--stamper",
  acc: "--acc",
};

export function readPalette(el: Element): Palette {
  const style = getComputedStyle(el);
  const out = {} as Palette;
  for (const [k, v] of Object.entries(TOKENS)) {
    out[k as keyof Palette] = style.getPropertyValue(v).trim() || "#888";
  }
  return out;
}

export interface TableCounts {
  active: number;
  total: number;
}

export interface DrawInput {
  view: View;
  size: Size;
  dpr: number;
  detail: Detail;
  layout: SeatLayout;
  palette: Palette;
  font: string;
  toneOf: (userId: string) => SeatTone;
  initialsOf: (userId: string) => string;
  counts: (table: number) => TableCounts;
  /** Tables and people to ring in the accent colour (found or picked). */
  highlightTables: ReadonlySet<number>;
  highlightPeople: ReadonlySet<string>;
  /** People the status filter leaves out: drawn faint, not hidden, so nobody moves. */
  faded: (userId: string) => boolean;
}

/** Draws one frame. Returns how many tables it drew. */
export function drawSeatMap(ctx: CanvasRenderingContext2D, d: DrawInput): number {
  const { view, size, dpr } = d;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  const seen = visibleRect(view, size);
  // A little beyond the edges, so labels and rings at the edge aren't cut.
  const margin = 40 / view.k;
  const area = {
    x: seen.x - margin,
    y: seen.y - margin,
    w: seen.w + 2 * margin,
    h: seen.h + 2 * margin,
  };
  let drawn = 0;
  const onScreen: number[] = [];
  d.layout.tables.forEach((t, i) => {
    if (intersects(area, { x: t.x, y: t.y, w: t.w, h: t.h })) onScreen.push(i);
  });

  if (d.detail === "blocks") {
    for (const i of onScreen) {
      const t = d.layout.tables[i];
      if (t) drawBlock(ctx, d, t, i);
      drawn++;
    }
    return drawn;
  }

  // Tables first, in canvas units.
  ctx.save();
  ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
  for (const i of onScreen) {
    const t = d.layout.tables[i];
    if (!t) continue;
    drawTableBody(ctx, d, t, d.highlightTables.has(i));
    drawn++;
  }
  if (d.detail === "dots") drawDots(ctx, d, onScreen);
  else drawChairs(ctx, d, onScreen);
  ctx.restore();

  // Labels in screen pixels, so they stay readable at any zoom.
  for (const i of onScreen) {
    const t = d.layout.tables[i];
    if (t) drawLabel(ctx, d, t, i);
  }
  return drawn;
}

function stadium(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = Math.min(h / 2, w / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawTableBody(
  ctx: CanvasRenderingContext2D,
  d: DrawInput,
  t: PlacedTable,
  highlighted: boolean,
) {
  const b = tableBody(t.shape);
  stadium(
    ctx,
    t.x + b.left - TABLE_RADIUS,
    t.y + b.cy - TABLE_RADIUS,
    t.shape.length + 2 * TABLE_RADIUS,
    2 * TABLE_RADIUS,
  );
  ctx.fillStyle = d.palette.sunk;
  ctx.fill();
  ctx.lineWidth = highlighted ? 4 / d.view.k : 1.5;
  ctx.strokeStyle = highlighted ? d.palette.acc : d.palette.line2;
  ctx.stroke();
}

const DOT_R = CHAIR_SIZE * 0.32;

function drawDots(ctx: CanvasRenderingContext2D, d: DrawInput, onScreen: number[]) {
  // One path per look, so thousands of dots are a handful of draw calls.
  const filled = new Path2D();
  const rings = new Path2D();
  const fadedFilled = new Path2D();
  const fadedRings = new Path2D();
  const marked = new Path2D();
  for (const i of onScreen) {
    const t = d.layout.tables[i];
    if (!t) continue;
    t.people.forEach((id, s) => {
      const p = t.seats[s];
      if (!p) return;
      const x = t.x + p.x;
      const y = t.y + p.y;
      const active = d.toneOf(id) === "active";
      const faded = d.faded(id);
      const path = active ? (faded ? fadedFilled : filled) : faded ? fadedRings : rings;
      // Active is a filled dot, not active a ring: shape as well as colour.
      const r = active ? DOT_R : DOT_R - 2;
      path.moveTo(x + r, y);
      path.arc(x, y, r, 0, Math.PI * 2);
      if (d.highlightPeople.has(id)) {
        marked.moveTo(x + DOT_R + 7, y);
        marked.arc(x, y, DOT_R + 7, 0, Math.PI * 2);
      }
    });
  }
  ctx.fillStyle = d.palette.active;
  ctx.fill(filled);
  ctx.strokeStyle = d.palette.inactive;
  ctx.lineWidth = 4;
  ctx.stroke(rings);
  ctx.globalAlpha = 0.25;
  ctx.fill(fadedFilled);
  ctx.stroke(fadedRings);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = d.palette.acc;
  ctx.lineWidth = Math.max(3, 3 / d.view.k);
  ctx.stroke(marked);
}

/** A chair from above, drawn facing down, centred on the origin: back, arms, then seat. */
const half = CHAIR_SIZE / 2;
const unit = CHAIR_SIZE / 46;
const chairFrame = (() => {
  const p = new Path2D();
  p.roundRect(-half + 9 * unit, -half + 2 * unit, 28 * unit, 10 * unit, 5 * unit);
  p.roundRect(-half + 2 * unit, -half + 13 * unit, 7 * unit, 23 * unit, 3.5 * unit);
  p.roundRect(-half + 37 * unit, -half + 13 * unit, 7 * unit, 23 * unit, 3.5 * unit);
  return p;
})();
const chairSeat = (() => {
  const p = new Path2D();
  p.roundRect(-half + 10.5 * unit, -half + 9.5 * unit, 25 * unit, 30 * unit, 9 * unit);
  return p;
})();

function drawChairs(ctx: CanvasRenderingContext2D, d: DrawInput, onScreen: number[]) {
  const base = ctx.getTransform();
  const labels: { x: number; y: number; text: string; faded: boolean }[] = [];
  for (const i of onScreen) {
    const t = d.layout.tables[i];
    if (!t) continue;
    t.people.forEach((id, s) => {
      const p = t.seats[s];
      if (!p) return;
      const x = t.x + p.x;
      const y = t.y + p.y;
      const tone = d.toneOf(id);
      const color = tone === "active" ? d.palette.active : d.palette.inactive;
      const faded = d.faded(id);
      ctx.globalAlpha = faded ? 0.3 : 1;
      if (d.highlightPeople.has(id)) {
        ctx.beginPath();
        ctx.arc(x, y, half + 6, 0, Math.PI * 2);
        ctx.strokeStyle = d.palette.acc;
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      ctx.translate(x, y);
      ctx.rotate((p.rotate * Math.PI) / 180);
      ctx.fillStyle = color;
      ctx.fill(chairFrame);
      ctx.fillStyle = d.palette.panel;
      ctx.fill(chairSeat);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5 * unit;
      // Not active is dashed: shape as well as colour (DSH-09).
      ctx.setLineDash(tone === "active" ? [] : [5 * unit, 3 * unit]);
      ctx.stroke(chairSeat);
      ctx.setLineDash([]);
      ctx.setTransform(base);
      labels.push({ x, y, text: d.initialsOf(id), faded });
    });
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = d.palette.ink;
  ctx.font = `600 14px ${d.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const l of labels) {
    ctx.globalAlpha = l.faded ? 0.4 : 1;
    ctx.fillText(l.text, l.x, l.y + 1);
  }
  ctx.globalAlpha = 1;
}

/** `text` cut to fit `max` pixels, with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (max <= 0) return "";
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : "";
}

function drawLabel(ctx: CanvasRenderingContext2D, d: DrawInput, t: PlacedTable, i: number) {
  const width = t.w * d.view.k;
  if (width < 48) return;
  const b = tableBody(t.shape);
  const at = toScreen(d.view, t.x + t.w / 2, t.y + 14);
  const counts = d.counts(i);
  const name = t.of > 1 ? `${t.name} · ${t.index + 1} of ${t.of}` : t.name;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = d.palette.ink;
  ctx.font = `600 13px ${d.font}`;
  const line =
    d.detail === "chairs"
      ? `${name}  ·  ${counts.total} ${counts.total === 1 ? "person" : "people"} · ${counts.active} active`
      : name;
  ctx.fillText(fit(ctx, line, width), at.x, at.y);
  // Mid zoom: the counts sit on the table.
  if (d.detail === "dots" && 2 * TABLE_RADIUS * d.view.k >= 22) {
    const mid = toScreen(d.view, t.x + t.w / 2, t.y + b.cy);
    ctx.fillStyle = d.palette.ink2;
    ctx.font = `500 11px ${d.font}`;
    ctx.fillText(
      fit(
        ctx,
        `${counts.active} active · ${counts.total - counts.active} not`,
        t.shape.length * d.view.k + 40,
      ),
      mid.x,
      mid.y,
    );
  }
}

/** Zoomed out: the table as a block with the team's name and its Active / not active counts. */
function drawBlock(ctx: CanvasRenderingContext2D, d: DrawInput, t: PlacedTable, i: number) {
  const a = toScreen(d.view, t.x, t.y);
  const w = t.w * d.view.k;
  const h = t.h * d.view.k;
  const highlighted = d.highlightTables.has(i) || t.people.some((id) => d.highlightPeople.has(id));
  ctx.beginPath();
  ctx.roundRect(a.x, a.y, w, h, Math.min(8, h / 4));
  ctx.fillStyle = d.palette.sunk;
  ctx.fill();
  ctx.lineWidth = highlighted ? 3 : 1;
  ctx.strokeStyle = highlighted ? d.palette.acc : d.palette.line2;
  ctx.stroke();
  if (w < 30 || h < 16) return;
  const counts = d.counts(i);
  const name = t.of > 1 ? `${t.name} · ${t.index + 1} of ${t.of}` : t.name;
  ctx.textBaseline = "middle";
  // The counts: a filled dot and the Active count, a ring and the not-active count (shape as
  // well as colour). They come first: a short block drops the name before the counts.
  ctx.font = `500 11px ${d.font}`;
  const activeText = `${counts.active}`;
  const restText = `${counts.total - counts.active}`;
  const countsWidth =
    8 + ctx.measureText(activeText).width + 10 + 8 + ctx.measureText(restText).width;
  const twoLines = h >= 38;
  const countsY = twoLines ? a.y + h / 2 + 9 : a.y + h / 2;
  let x = twoLines ? a.x + 10 : a.x + w - 6 - countsWidth;
  if (x >= a.x + 4) {
    ctx.textAlign = "left";
    ctx.beginPath();
    ctx.arc(x, countsY, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = d.palette.active;
    ctx.fill();
    x += 8;
    ctx.fillStyle = d.palette.ink2;
    ctx.fillText(activeText, x, countsY);
    x += ctx.measureText(activeText).width + 10;
    ctx.beginPath();
    ctx.arc(x, countsY, 3, 0, Math.PI * 2);
    ctx.strokeStyle = d.palette.inactive;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    x += 8;
    ctx.fillText(restText, x, countsY);
  }
  ctx.textAlign = "left";
  ctx.fillStyle = d.palette.ink;
  ctx.font = `600 12px ${d.font}`;
  const room = twoLines ? w - 12 : w - 18 - countsWidth;
  ctx.fillText(fit(ctx, name, room), a.x + 6, twoLines ? a.y + h / 2 - 8 : a.y + h / 2);
}

/** The minimap: every table as a small block, the found ones in the accent colour. */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  layout: SeatLayout,
  scale: number,
  dpr: number,
  palette: Palette,
  highlightTables: ReadonlySet<number>,
) {
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  ctx.clearRect(0, 0, layout.width + 1, layout.height + 1);
  layout.tables.forEach((t, i) => {
    ctx.fillStyle = highlightTables.has(i) ? palette.acc : palette.line2;
    ctx.fillRect(t.x, t.y + 20, t.w, t.h - 20);
  });
}
