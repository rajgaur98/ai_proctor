// Cell values for imports (#256): each parser takes the trimmed text of a cell and
// returns the value or a plain-words problem. Lenient about how people type things
// (case, "9am", "Mon-Fri", "yes"), strict about what's stored.
import { ImportEmail } from "@ai-proctor/contracts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = <T>(message: string): Parsed<T> => ({ ok: false, message });

/** Lower case, letters and digits only: "Manager E-mail" and "manager_email" match. */
export function normalizeHeader(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Case-insensitive key for names (teams, clients, projects), spaces collapsed. */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseEmail(text: string): Parsed<string> {
  const email = text.trim().toLowerCase();
  return ImportEmail.safeParse(email).success
    ? ok(email)
    : bad(`"${text}" isn't an email address.`);
}

/** Emails in one cell, separated by semicolons, commas, spaces or line breaks. */
export function parseEmailList(text: string): Parsed<string[]> {
  const out: string[] = [];
  const wrong: string[] = [];
  for (const part of text.split(/[;,\s]+/)) {
    if (!part) continue;
    const email = parseEmail(part);
    if (!email.ok) wrong.push(part);
    else if (!out.includes(email.value)) out.push(email.value);
  }
  if (wrong.length > 0) {
    return bad(
      `${wrong.map((w) => `"${w}"`).join(", ")} ${wrong.length === 1 ? "isn't an email address" : "aren't email addresses"}.`,
    );
  }
  return ok(out);
}

const YES = new Set(["yes", "y", "true", "1"]);
const NO = new Set(["no", "n", "false", "0"]);

/** yes / no, true / false, 1 / 0, and any extra words the column allows. */
export function parseYesNo(
  text: string,
  extra: { yes?: string[]; no?: string[] } = {},
): Parsed<boolean> {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (YES.has(t) || extra.yes?.includes(t)) return ok(true);
  if (NO.has(t) || extra.no?.includes(t)) return ok(false);
  const words = ["yes", "no", ...(extra.yes ?? []), ...(extra.no ?? [])];
  return bad(`"${text}" should be ${words.slice(0, -1).join(", ")} or ${words.at(-1)}.`);
}

const ROLES: Record<string, "owner" | "admin" | "manager" | "employee"> = {
  owner: "owner",
  admin: "admin",
  administrator: "admin",
  manager: "manager",
  employee: "employee",
};

export function parseRole(text: string): Parsed<"owner" | "admin" | "manager" | "employee"> {
  const role = ROLES[text.trim().toLowerCase()];
  return role ? ok(role) : bad(`"${text}" isn't a role. Use admin, manager or employee.`);
}

export function parseCountry(text: string): Parsed<string> {
  const t = text.trim().toUpperCase();
  if (t === "USA") return ok("US");
  return /^[A-Z]{2}$/.test(t)
    ? ok(t)
    : bad(`"${text}" isn't a country code. Use two letters, like US or IN.`);
}

export function parseState(text: string): Parsed<string> {
  const t = text.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(t)
    ? ok(t)
    : bad(`"${text}" isn't a state code. Use two letters, like NY.`);
}

/** A work location in one cell: "US-NY", "US/NY", "US NY" or a country alone ("IN"). */
export function parseLocation(text: string): Parsed<{ country: string; state: string | null }> {
  const m = text.trim().match(/^([A-Za-z]{2,3})(?:\s*[-/,\s]\s*([A-Za-z]{2}))?$/);
  const country = m ? parseCountry(m[1] ?? "") : null;
  if (!m || !country?.ok) {
    return bad(
      `"${text}" isn't a work location. Use a country code, with the state for the US, like US-NY or IN.`,
    );
  }
  return ok({ country: country.value, state: m[2] ? m[2].toUpperCase() : null });
}

let zoneNames: Map<string, string> | null = null;

/**
 * An IANA time zone name, spelled the way the database knows it (it compares names
 * exactly). Any case is accepted for names the browser lists or resolves to
 * ("america/new_york" becomes "America/New_York", "utc" becomes "UTC"); other valid
 * names (links like "Asia/Kolkata") are kept as typed.
 */
export function parseTimeZone(text: string): Parsed<string> {
  const t = text.trim();
  if (!t) return bad("The time zone is empty.");
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: t }).resolvedOptions().timeZone;
  } catch {
    return bad(`"${text}" isn't a time zone. Use a name like America/New_York or Asia/Kolkata.`);
  }
  zoneNames ??= new Map(Intl.supportedValuesOf("timeZone").map((z) => [z.toLowerCase(), z]));
  const listed = zoneNames.get(t.toLowerCase());
  if (listed) return ok(listed);
  return ok(resolved.toLowerCase() === t.toLowerCase() ? resolved : t);
}

/** A wall-clock time: "9", "09:00", "9:30am", "5 pm", "17:30", "17:30:00". As "HH:MM". */
export function parseTime(text: string): Parsed<string> {
  const m = text
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)?$/);
  const wrong = bad<string>(`"${text}" isn't a time. Use a time like 09:00 or 5:30pm.`);
  if (!m) return wrong;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (minute > 59 || (m[3] !== undefined && Number(m[3]) !== 0)) return wrong;
  const half = m[4]?.[0];
  if (half) {
    if (hour < 1 || hour > 12) return wrong;
    hour = (hour % 12) + (half === "p" ? 12 : 0);
  } else if (hour > 23) return wrong;
  return ok(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
}

const DAY_NAMES: [number, string[]][] = [
  [1, ["1", "mon", "monday"]],
  [2, ["2", "tue", "tues", "tuesday"]],
  [3, ["3", "wed", "weds", "wednesday"]],
  [4, ["4", "thu", "thur", "thurs", "thursday"]],
  [5, ["5", "fri", "friday"]],
  [6, ["6", "sat", "saturday"]],
  [7, ["7", "sun", "sunday"]],
];
const DAY = new Map(DAY_NAMES.flatMap(([n, names]) => names.map((name) => [name, n] as const)));
const DAY_SETS: Record<string, number[]> = {
  weekdays: [1, 2, 3, 4, 5],
  weekends: [6, 7],
  weekend: [6, 7],
  daily: [1, 2, 3, 4, 5, 6, 7],
  everyday: [1, 2, 3, 4, 5, 6, 7],
  all: [1, 2, 3, 4, 5, 6, 7],
};

/**
 * Days of the week as ISO numbers (1 = Monday … 7 = Sunday), sorted: "Mon-Fri",
 * "Mon, Wed, Fri", "1-5", "Fri to Mon" (wraps), "weekdays", "weekends", "daily".
 */
export function parseDays(text: string): Parsed<number[]> {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\bevery ?day\b/g, "everyday")
    .replace(/\s+to\s+/g, "-")
    .replace(/\s*-\s*/g, "-");
  const days = new Set<number>();
  const wrong: string[] = [];
  for (const token of t.split(/[\s,;/&+]+|\band\b/)) {
    if (!token) continue;
    const set = DAY_SETS[token];
    if (set) {
      for (const d of set) days.add(d);
      continue;
    }
    const [from, to, more] = token.split("-");
    const a = DAY.get(from ?? "");
    const b = to === undefined ? a : DAY.get(to);
    if (a === undefined || b === undefined || more !== undefined) {
      wrong.push(token);
      continue;
    }
    for (let d = a, n = 0; n < 7; d = (d % 7) + 1, n++) {
      days.add(d);
      if (d === b) break;
    }
  }
  if (wrong.length > 0 || days.size === 0) {
    return bad(
      `"${text}" isn't a set of days. Use names or ranges, like Mon-Fri or Mon, Wed, Fri.`,
    );
  }
  return ok([...days].sort((x, y) => x - y));
}

const SHORT_DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Days back as text, ranges joined: [1,2,3,4,5,7] -> "Mon-Fri, Sun". */
export function formatDays(days: number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < days.length) {
    let j = i;
    while (j + 1 < days.length && (days[j + 1] as number) === (days[j] as number) + 1) j++;
    const a = SHORT_DAYS[days[i] as number];
    const b = SHORT_DAYS[days[j] as number];
    parts.push(j - i >= 2 ? `${a}-${b}` : j === i ? `${a}` : `${a}, ${b}`);
    i = j + 1;
  }
  return parts.join(", ");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function ymd(year: number, month: number, day: number): string | null {
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * A calendar date as "YYYY-MM-DD": "2026-10-28", "2026/10/28", "28 Oct 2026",
 * "Oct 28, 2026", "28-Oct-2026". Day-and-month numbers alone ("10/28/2026", "28.10.2026")
 * are refused: a file can mean either order, and guessing would move time to another day.
 */
export function parseDate(text: string): Parsed<string> {
  const t = text.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  const wrong = bad<string>(`"${text}" isn't a date. Use a date like 2026-10-28.`);
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    const d = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
    return d ? ok(d) : wrong;
  }
  const month = (name: string) => MONTHS.indexOf(name.slice(0, 3)) + 1;
  m = t.match(/^(\d{1,2})[ -]([a-z]{3,9})\.?[ -](\d{4})$/);
  if (m && month(m[2] ?? "") > 0) {
    const d = ymd(Number(m[3]), month(m[2] ?? ""), Number(m[1]));
    return d ? ok(d) : wrong;
  }
  m = t.match(/^([a-z]{3,9})\.? (\d{1,2}) (\d{4})$/);
  if (m && month(m[1] ?? "") > 0) {
    const d = ymd(Number(m[3]), month(m[1] ?? ""), Number(m[2]));
    return d ? ok(d) : wrong;
  }
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(t)) {
    return bad(`"${text}" could be read day-first or month-first. Use a date like 2026-10-28.`);
  }
  return wrong;
}

/**
 * A time of day with seconds, as "HH:MM:SS": "9", "09:00", "9:30am", "17:30:15". "24:00"
 * is midnight at the end of the day (an end time).
 */
export function parseClockTime(text: string): Parsed<string> {
  const m = text
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)?$/);
  const wrong = bad<string>(`"${text}" isn't a time. Use a time like 09:00 or 5:30pm.`);
  if (!m) return wrong;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const second = Number(m[3] ?? 0);
  if (minute > 59 || second > 59) return wrong;
  const half = m[4]?.[0];
  if (half) {
    if (hour < 1 || hour > 12) return wrong;
    hour = (hour % 12) + (half === "p" ? 12 : 0);
  } else if (hour > 24 || (hour === 24 && (minute > 0 || second > 0))) return wrong;
  const pad = (n: number) => String(n).padStart(2, "0");
  return ok(`${pad(hour)}:${pad(minute)}:${pad(second)}`);
}
