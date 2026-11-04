// Windowing for the Live team list (#323, DSH-01/DSH-11): with thousands of people on shift
// only the rows on screen are drawn, and the rest of the table is two spacer rows of the same
// height, so the page scrolls as if every row were there. Pure, so it can be unit-tested.

/** Lists up to this many rows are drawn in full; longer ones are windowed. */
export const FULL_RENDER_MAX = 200;
/** Rows drawn above and below the screen, so scrolling and Tab never reach a gap. */
export const OVERSCAN = 8;

/** Rows `start` (inclusive) to `end` (exclusive). */
export interface RowRange {
  start: number;
  end: number;
}

/**
 * The rows on screen plus `overscan` either side. `bodyTop` is where the first row's top is,
 * relative to the top of the viewport (negative once it has scrolled past). Always at least one
 * row, so its height can be measured.
 */
export function rowRange(
  count: number,
  rowHeight: number,
  bodyTop: number,
  viewportHeight: number,
  overscan = OVERSCAN,
): RowRange {
  if (count <= 0) return { start: 0, end: 0 };
  const h = Math.max(1, rowHeight);
  const first = Math.floor(-bodyTop / h);
  const last = Math.ceil((viewportHeight - bodyTop) / h);
  const start = Math.min(Math.max(first - overscan, 0), count - 1);
  const end = Math.min(Math.max(last + overscan, start + 1), count);
  return { start, end };
}

/** A row to draw, or a gap of `gap` rows from row `from`, drawn as one spacer. */
export type Slot = { index: number } | { gap: number; from: number };

/**
 * What to draw: the rows in `range`, plus `pinned` (the row that has focus) wherever it is, so
 * scrolling away never drops the focus; spacers stand in for everything else.
 */
export function slots(count: number, range: RowRange, pinned: number | null): Slot[] {
  const start = Math.min(range.start, count);
  const end = Math.min(Math.max(range.end, start), count);
  const out: Slot[] = [];
  const pin = pinned !== null && pinned >= 0 && pinned < count ? pinned : null;
  let at = 0;
  const gapTo = (i: number) => {
    if (i > at) out.push({ gap: i - at, from: at });
  };
  if (pin !== null && pin < start) {
    gapTo(pin);
    out.push({ index: pin });
    at = pin + 1;
  }
  gapTo(start);
  for (let i = start; i < end; i++) out.push({ index: i });
  at = Math.max(at, end);
  if (pin !== null && pin >= end) {
    gapTo(pin);
    out.push({ index: pin });
    at = pin + 1;
  }
  gapTo(count);
  return out;
}

/**
 * Where a key moves the focus from row `index`: up and down a row, a screen (`page` rows) with
 * Page Up / Page Down, the first or last row with Home / End, and Tab / Shift + Tab to the
 * next or previous row (each row has one stop, so that's what Tab does anyway; handling it
 * keeps working when the next row isn't drawn). Null leaves the key to the browser.
 */
export function keyTarget(
  key: string,
  shift: boolean,
  index: number,
  count: number,
  page: number,
): number | null {
  const last = count - 1;
  switch (key) {
    case "ArrowDown":
      return Math.min(index + 1, last);
    case "ArrowUp":
      return Math.max(index - 1, 0);
    case "PageDown":
      return Math.min(index + Math.max(1, page), last);
    case "PageUp":
      return Math.max(index - Math.max(1, page), 0);
    case "Home":
      return 0;
    case "End":
      return last;
    case "Tab": {
      const next = shift ? index - 1 : index + 1;
      return next < 0 || next > last ? null : next;
    }
    default:
      return null;
  }
}
