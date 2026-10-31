// Words for the parts of a check-in its employee removed (#253, EMP-06): shown instead
// of the captures and the app, so the day view doesn't read like a failed capture. It is
// not a flag: the check-in still passed and its time counts. Pure, so it is unit tested.
import { DateTime } from "luxon";

/** When each part was removed, or null. */
export interface RemovedParts {
  webcam: string | null;
  screen: string | null;
  apps: string | null;
  domains: string | null;
}

export type Part = keyof RemovedParts;

export const PART_ORDER: Part[] = ["webcam", "screen", "apps", "domains"];

export const noneRemoved: RemovedParts = { webcam: null, screen: null, apps: null, domains: null };

const words: Record<Part, string> = {
  webcam: "webcam",
  screen: "screen",
  apps: "apps",
  domains: "browser domains",
};

/** The removed parts, in a fixed order. */
export function removedParts(r: RemovedParts): Part[] {
  return PART_ORDER.filter((p) => r[p] !== null);
}

/** "a, b and c". */
function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "Webcam" from "webcam": sentence case for the first word. */
function capital(s: string): string {
  return s ? `${s[0]?.toUpperCase()}${s.slice(1)}` : s;
}

/** The day the last part was removed, as "31 Oct", in `zone`. */
function onDay(r: RemovedParts, zone: string): string {
  const latest = removedParts(r)
    .map((p) => r[p] as string)
    .sort()
    .at(-1);
  return latest ? DateTime.fromISO(latest, { zone }).toFormat("d LLL") : "";
}

/**
 * "Webcam and screen removed by Erin Employee on 31 Oct", for whichever parts were
 * removed; null when none were. `who` is the employee's name, or "you" on their own page.
 */
export function removedText(r: RemovedParts, who: string, zone: string): string | null {
  const parts = removedParts(r);
  if (parts.length === 0) return null;
  return `${capital(list(parts.map((p) => words[p])))} removed by ${who} on ${onDay(r, zone)}`;
}

/** One part's slot text: "Webcam frame removed by Erin Employee on 31 Oct". */
export function partRemovedText(label: string, at: string, who: string, zone: string): string {
  return `${label} removed by ${who} on ${DateTime.fromISO(at, { zone }).toFormat("d LLL")}`;
}

/** The removed parts as the check-in row stores them. */
export function removedFromRow(row: {
  webcam_deleted_at: string | null;
  screen_deleted_at: string | null;
  apps_deleted_at: string | null;
  domains_deleted_at: string | null;
}): RemovedParts {
  return {
    webcam: row.webcam_deleted_at,
    screen: row.screen_deleted_at,
    apps: row.apps_deleted_at,
    domains: row.domains_deleted_at,
  };
}
