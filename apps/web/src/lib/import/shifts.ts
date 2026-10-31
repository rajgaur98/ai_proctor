// Shift imports (#256, SHF-01): one row per shift, any number of rows per person. Each
// person in the file gets exactly the shifts listed for them (set_shifts: at most 7);
// people left out keep theirs. A shift whose end is before its start crosses midnight.
// An empty time zone is the person's own.
import { type ImportShift, ImportShifts } from "@ai-proctor/contracts";
import type { RowCells } from "./columns";
import { addIssues, RowResult } from "./rows";
import type { ImportContext, RowStatus } from "./types";
import { formatDays, parseDays, parseEmail, parseTime, parseTimeZone } from "./values";

const MAX_SHIFTS = 7;

const shiftKey = (s: ImportShift) => `${s.days.join("")}|${s.start}|${s.end}|${s.timezone}`;
const describe = (s: ImportShift) => `${formatDays(s.days)} ${s.start}-${s.end}`;

interface Group {
  email: string;
  results: RowResult[];
  shifts: ImportShift[];
  keys: Map<string, number>;
}

export function previewShifts(rows: RowCells[], ctx: ImportContext) {
  const people = new Map(ctx.people.map((p) => [p.email.toLowerCase(), p]));
  const existing = new Map<string, ImportShift[]>();
  for (const s of ctx.shifts) {
    const email = s.email.toLowerCase();
    const shift = {
      days: [...new Set(s.days)].sort((a, b) => a - b),
      start: s.start.slice(0, 5),
      end: s.end.slice(0, 5),
      timezone: s.timezone,
    };
    existing.set(email, [...(existing.get(email) ?? []), shift]);
  }
  const groups = new Map<string, Group>();
  const results: RowResult[] = [];

  for (const cells of rows) {
    const get = cells.get;
    const result = new RowResult(cells.row, get("email").toLowerCase() || `row ${cells.row}`);
    results.push(result);
    if (cells.overflow) result.error(null, "This row has more values than the header has columns.");

    let email: string | undefined;
    const emailCell = get("email");
    if (!emailCell) result.error("email", "The email is missing.");
    else {
      const e = parseEmail(emailCell);
      if (!e.ok) result.error("email", e.message);
      else if (!people.has(e.value)) {
        result.error("email", `${e.value} isn't in your organisation. Import people first.`);
      } else if (!people.get(e.value)?.active) {
        result.error("email", `${e.value} is deactivated.`);
      } else email = e.value;
    }

    const read = <T>(
      name: string,
      label: string,
      parse: (t: string) => { ok: true; value: T } | { ok: false; message: string },
    ) => {
      const cell = get(name);
      if (!cell) {
        result.error(name, `The ${label} is missing.`);
        return undefined;
      }
      const v = parse(cell);
      if (!v.ok) {
        result.error(name, v.message);
        return undefined;
      }
      return v.value;
    };
    const days = read("days", "days", parseDays);
    const start = read("start", "start time", parseTime);
    const end = read("end", "end time", parseTime);
    if (start && end && start === end) result.error("end", "The shift ends when it starts.");
    let timezone = email ? people.get(email)?.timezone : undefined;
    if (get("timezone")) timezone = read("timezone", "time zone", parseTimeZone);

    if (!email) continue;
    const group: Group = groups.get(email) ?? { email, results: [], shifts: [], keys: new Map() };
    groups.set(email, group);
    group.results.push(result);
    if (!result.ok || !days || !start || !end || !timezone) continue;
    const shift: ImportShift = { days, start, end, timezone };
    const first = group.keys.get(shiftKey(shift));
    if (first !== undefined) {
      result.error(null, `The same shift is also on row ${first}.`);
    } else if (group.shifts.length >= MAX_SHIFTS) {
      result.error(null, `${email} has more than ${MAX_SHIFTS} shifts in this file.`);
    } else {
      group.keys.set(shiftKey(shift), cells.row);
      group.shifts.push(shift);
    }
  }

  const items: ImportShifts[] = [];
  for (const group of groups.values()) {
    if (!group.results.every((r) => r.ok)) continue;
    const before = existing.get(group.email) ?? [];
    const was = new Set(before.map(shiftKey));
    const same =
      before.length === group.shifts.length && group.shifts.every((s) => was.has(shiftKey(s)));
    const action: Exclude<RowStatus, "error"> =
      before.length === 0 ? "create" : same ? "unchanged" : "update";
    for (const r of group.results) {
      r.action = action;
      if (action === "update") {
        r.changes.push(
          `replaces ${before.map(describe).join("; ")} with ${group.shifts.map(describe).join("; ")}`,
        );
      }
    }
    if (action === "unchanged") continue;
    const item = ImportShifts.safeParse({
      rows: group.results.map((r) => r.row),
      action,
      email: group.email,
      shifts: group.shifts,
    });
    if (item.success) items.push(item.data);
    else for (const r of group.results) addIssues(r, item.error.issues, () => null);
  }

  return { rows: results.map((r) => r.preview()), items };
}
