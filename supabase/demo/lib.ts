// Shared helpers for the demo seed (#351): a seeded PRNG, deterministic UUIDs, time
// zone arithmetic without a library (Intl only) and a tiny solid-colour WebP encoder.
// Everything here is deterministic: the same inputs give the same outputs.

/** mulberry32 seeded from a string (FNV-1a), so every person/day has its own stream. */
export function rng(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = () => number;

export const between = (r: Rand, lo: number, hi: number) => lo + r() * (hi - lo);
export const int = (r: Rand, lo: number, hi: number) => Math.floor(between(r, lo, hi + 1));
export const chance = (r: Rand, p: number) => r() < p;
export function pick<T>(r: Rand, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}
export function weighted<T>(r: Rand, xs: readonly (readonly [T, number])[]): T {
  const total = xs.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of xs) {
    x -= w;
    if (x < 0) return v;
  }
  return (xs[xs.length - 1] as readonly [T, number])[0];
}

/** A version 4 UUID drawn from `r` (deterministic for a given stream). */
export function uuid(r: Rand): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16));
  hex[12] = "4";
  hex[16] = "89ab"[Math.floor(r() * 4)] as string;
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// ---- time zones -----------------------------------------------------------------------

const MIN = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of instant `ms` in `tz`. */
export function localParts(tz: string, ms: number) {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return {
    y: p.year as number,
    m: p.month as number,
    d: p.day as number,
    h: p.hour as number,
    mi: p.minute as number,
    s: p.second as number,
  };
}

function offsetMs(tz: string, ms: number): number {
  const p = localParts(tz, ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** A local calendar day, as days since 1970-01-01 (no time zone). */
export type Day = number;

export function dayOf(tz: string, ms: number): Day {
  const p = localParts(tz, ms);
  return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000);
}

export function dayString(day: Day): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** ISO weekday (1 = Monday .. 7 = Sunday) of a local day. */
export function isoDow(day: Day): number {
  const d = new Date(day * 86_400_000).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The instant at local `day` + `minutes` (may exceed 24 h) in `tz`. */
export function localToUtc(tz: string, day: Day, minutes: number): number {
  const guess = day * 86_400_000 + minutes * MIN;
  let t = guess - offsetMs(tz, guess);
  const second = offsetMs(tz, t);
  if (guess - second !== t) t = guess - second;
  return t;
}

export function hm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h as number) * 60 + (m as number);
}

export const iso = (ms: number) => new Date(ms).toISOString();

// ---- WebP -------------------------------------------------------------------------------

/**
 * A lossless WebP (VP8L) of one solid colour. Each of the five prefix codes holds a
 * single symbol, so every pixel takes zero bits: the file is a few dozen bytes at any
 * size. Used for the placeholder captures (no real screens or faces).
 */
export function solidWebp(
  width: number,
  height: number,
  rgb: [number, number, number],
): Uint8Array<ArrayBuffer> {
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = 0; i < n; i++) bits.push((value >> i) & 1);
  };
  put(0x2f, 8); // signature
  put(width - 1, 14);
  put(height - 1, 14);
  put(0, 1); // alpha not used
  put(0, 3); // version
  put(0, 1); // no transform
  put(0, 1); // no colour cache
  put(0, 1); // no meta prefix codes
  // green, red, blue, alpha, distance: a "simple" code with one symbol each
  const one = (symbol: number) => {
    put(1, 1); // simple code
    put(0, 1); // one symbol
    if (symbol < 2) {
      put(0, 1);
      put(symbol, 1);
    } else {
      put(1, 1);
      put(symbol, 8);
    }
  };
  one(rgb[1]);
  one(rgb[0]);
  one(rgb[2]);
  one(255);
  one(0);
  const data = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    data[i >> 3] = (data[i >> 3] as number) | (b << (i & 7));
  });
  const padded = data.length % 2 === 1 ? data.length + 1 : data.length;
  const out = new Uint8Array(20 + padded);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, 12 + padded, true);
  out.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c], 8); // WEBPVP8L
  view.setUint32(16, data.length, true);
  out.set(data, 20);
  return out;
}
