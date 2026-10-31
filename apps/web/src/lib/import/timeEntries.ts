// Time-entry imports (#282, TS-31): one manual time entry per row, from another tool. The
// date, start and end are wall-clock times in the person's own time zone; start and end
// are required (an entry given only as a duration isn't supported, #262). An end of 24:00
// (or 00:00) is midnight at the end of the day; time past midnight goes on a second row.
//
// Each row is checked against request_manual_entry's rules (TS-07, TS-24): at most 24
// hours, not in the future, a project the person can log to, a task of that project, a
// reason (empty: IMPORT_TIME_ENTRY_REASON), no overlap with their clocked time or other
// pending or approved entries, no approved (locked) week. Rows of the file mustn't overlap
// each other either. A re-import matches on email, start and end: an identical entry is
// unchanged, a different one is an error (imports never change entries).
import {
  IMPORT_TIME_ENTRY_REASON,
  ImportTimeEntry,
  MANUAL_ENTRY_MAX_REASON,
  MANUAL_ENTRY_MAX_SECONDS,
  WORK_NOTE_MAX,
} from "@ai-proctor/contracts";
import type { CsvReadResult } from "@ai-proctor/core";
import { DateTime } from "luxon";
import { mapColumns, type RowCells, rowCells } from "./columns";
import { addIssues, listWords, RowResult } from "./rows";
import type {
  ExistingProject,
  ExistingTask,
  ExistingTimeEntry,
  ImportContext,
  TimeContext,
} from "./types";
import { nameKey, parseClockTime, parseDate, parseEmail } from "./values";

const EMPTY: TimeContext = { entries: [], clocked: [], locked: [] };

/** One row's entry once it passed its own checks. */
interface Entry {
  result: RowResult;
  email: string;
  start: number;
  end: number;
  item: ImportTimeEntry;
}

const projectLabel = (p: { client: string | null; name: string }) =>
  p.client ? `${p.client} / ${p.name}` : p.name;

/**
 * The project a cell names: by name, or "Client / Project" when two clients have a
 * project of that name. Several matches keep the ones the person can log to.
 */
function findProject(
  cell: string,
  projects: ExistingProject[],
  email: string | undefined,
): { project: ExistingProject } | { error: string } {
  let found = projects.filter((p) => nameKey(p.name) === nameKey(cell));
  if (found.length === 0) {
    const slashed = (s: string) => nameKey(s).replace(/\s*\/\s*/g, " / ");
    found = projects.filter(
      (p) => p.client !== null && slashed(`${p.client} / ${p.name}`) === slashed(cell),
    );
  }
  if (found.length === 0) {
    return { error: `There's no project called "${cell}". Import projects first.` };
  }
  if (found.length > 1) {
    const usable = found.filter((p) => !p.archived && email && p.members.includes(email));
    if (usable.length === 1 && usable[0]) return { project: usable[0] };
    return {
      error: `${found.length} projects are called "${cell}" (${listWords(found.map(projectLabel))}). Write it as client / project.`,
    };
  }
  return { project: found[0] as ExistingProject };
}

const sameProject = (
  e: { project: string | null; client: string | null },
  p: { project: string | null; client: string | null },
) => e.project === p.project && e.client === p.client;

/** What differs between an existing entry and the row, in plain words. */
function differences(e: ExistingTimeEntry, item: ImportTimeEntry): string[] {
  const out: string[] = [];
  if (!sameProject(e, item)) out.push("project");
  if (e.task !== item.task) out.push("task");
  if ((e.note ?? null) !== item.note) out.push("note");
  if (e.reason !== item.reason) out.push("reason");
  return out;
}

export function previewTimeEntries(rows: RowCells[], ctx: ImportContext) {
  const time = ctx.time ?? EMPTY;
  const now = time.now ?? Date.now();
  const people = new Map(ctx.people.map((p) => [p.email.toLowerCase(), p]));
  const tasks = ctx.tasks ?? [];
  const byEmail = <T extends { email: string }>(list: T[]) => {
    const map = new Map<string, T[]>();
    for (const x of list) {
      const email = x.email.toLowerCase();
      map.set(email, [...(map.get(email) ?? []), x]);
    }
    return map;
  };
  const entriesOf = byEmail(time.entries);
  const clockedOf = byEmail(time.clocked);
  const lockedOf = byEmail(time.locked);
  const results: RowResult[] = [];
  const entries: Entry[] = [];

  for (const cells of rows) {
    const get = cells.get;
    const key = [get("email").toLowerCase(), get("date"), `${get("start")}-${get("end")}`]
      .filter((x) => x && x !== "-")
      .join(" ");
    const result = new RowResult(cells.row, key || `row ${cells.row}`);
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

    const read = (
      name: string,
      label: string,
      parse: (t: string) => { ok: true; value: string } | { ok: false; message: string },
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
    const date = read("date", "date", parseDate);
    const startText = read("start", "start time", parseClockTime);
    const endText = read("end", "end time", parseClockTime);
    if (startText === "24:00:00") result.error("start", "An entry can't start at 24:00.");

    // The instants, in the person's time zone.
    let start: DateTime | undefined;
    let end: DateTime | undefined;
    const zone = email ? people.get(email)?.timezone : undefined;
    if (zone && date && startText && endText && startText !== "24:00:00") {
      const at = (clock: string, column: string) => {
        const dt = DateTime.fromISO(`${date}T${clock}`, { zone });
        if (!dt.isValid || dt.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== `${date}T${clock}`) {
          result.error(
            column,
            `${clock.slice(0, 5)} doesn't exist on ${date} in ${zone}: the clocks went forward.`,
          );
          return undefined;
        }
        return dt;
      };
      start = at(startText, "start");
      end =
        endText === "24:00:00" || endText === "00:00:00"
          ? DateTime.fromISO(date, { zone }).plus({ days: 1 })
          : at(endText, "end");
      if (start && end) {
        const seconds = end.toSeconds() - start.toSeconds();
        if (seconds <= 0) {
          result.error(
            "end",
            seconds === 0
              ? "The entry ends when it starts."
              : "The end is before the start. Put time past midnight on a second row for the next day.",
          );
        } else if (seconds > MANUAL_ENTRY_MAX_SECONDS) {
          result.error("end", "An entry can be at most 24 hours.");
        } else if (end.toMillis() > now) {
          result.error("end", "This time hasn't happened yet.");
        }
      }
    }

    let project: ExistingProject | null = null;
    const projectCell = get("project").replace(/\s+/g, " ");
    if (projectCell) {
      const found = findProject(projectCell, ctx.projects, email);
      if ("error" in found) result.error("project", found.error);
      else if (found.project.archived) {
        result.error("project", `${projectLabel(found.project)} is archived.`);
      } else if (email && !found.project.members.includes(email)) {
        result.error(
          "project",
          `${email} can't log time to ${projectLabel(found.project)}. Add them to the project first.`,
        );
      } else project = found.project;
    }

    let task: ExistingTask | null = null;
    const taskCell = get("task").replace(/\s+/g, " ");
    if (taskCell) {
      if (!projectCell) result.error("task", "A task needs a project.");
      else if (project) {
        const p = project;
        const t = tasks.find(
          (x) =>
            nameKey(x.project) === nameKey(p.name) &&
            nameKey(x.client ?? "") === nameKey(p.client ?? "") &&
            nameKey(x.name) === nameKey(taskCell),
        );
        if (!t) result.error("task", `${projectLabel(p)} has no task called "${taskCell}".`);
        else if (t.archived) result.error("task", `The task ${t.name} is archived.`);
        else task = t;
      }
    }

    const note = get("note");
    if (note.length > WORK_NOTE_MAX) {
      result.error(
        "note",
        `A note can be at most ${WORK_NOTE_MAX.toLocaleString("en-US")} characters.`,
      );
    }
    const reason = get("reason") || IMPORT_TIME_ENTRY_REASON;
    if (reason.length > MANUAL_ENTRY_MAX_REASON) {
      result.error("reason", `A reason can be at most ${MANUAL_ENTRY_MAX_REASON} characters.`);
    }

    // An approved week is locked (TS-18). The entry is within one local day.
    if (email && date) {
      const week = (lockedOf.get(email) ?? []).find((l) => {
        const from = DateTime.fromISO(l.period_start, { zone: "UTC" });
        const day = DateTime.fromISO(date, { zone: "UTC" });
        return day >= from && day < from.plus({ days: 7 });
      });
      if (week) {
        result.error(null, `The week of ${week.period_start} is approved, so its time is locked.`);
      }
    }

    if (!result.ok || !email || !start || !end) continue;
    const item = ImportTimeEntry.safeParse({
      rows: [cells.row],
      action: "create",
      email,
      start_at: start.toISO({ suppressMilliseconds: true }),
      end_at: end.toISO({ suppressMilliseconds: true }),
      project: project?.name ?? null,
      client: project?.client ?? null,
      task: task?.name ?? null,
      note: note || null,
      reason,
    });
    if (!item.success) {
      addIssues(result, item.error.issues, (k) =>
        k === "start_at" ? "start" : k === "end_at" ? "end" : k === "rows" ? null : k,
      );
      continue;
    }
    entries.push({ result, email, start: start.toMillis(), end: end.toMillis(), item: item.data });
  }

  // What's already there: the same entry (unchanged, or an error when it differs), then
  // overlaps with other entries and clocked time.
  for (const e of entries) {
    const zone = people.get(e.email)?.timezone ?? "UTC";
    const local = (ms: number) => DateTime.fromMillis(ms, { zone }).toFormat("yyyy-MM-dd HH:mm");
    const span = (a: number, b: number) => {
      const [from, to] = [local(a), local(b)];
      return from.slice(0, 10) === to.slice(0, 10) ? `${from}-${to.slice(11)}` : `${from} to ${to}`;
    };
    const mine = entriesOf.get(e.email) ?? [];
    const same = mine.find(
      (x) => Date.parse(x.start_at) === e.start && Date.parse(x.end_at) === e.end,
    );
    if (same) {
      const diff = differences(same, e.item);
      if (diff.length === 0) e.result.action = "unchanged";
      else {
        e.result.error(
          null,
          `An entry for this time already exists with a different ${listWords(diff)}. Imports don't change existing entries.`,
        );
      }
    }
    const overlap = mine.find(
      (x) =>
        x !== same &&
        x.status !== "rejected" &&
        Date.parse(x.start_at) < e.end &&
        Date.parse(x.end_at) > e.start,
    );
    if (overlap) {
      e.result.error(
        null,
        `Overlaps a ${overlap.status} entry, ${span(Date.parse(overlap.start_at), Date.parse(overlap.end_at))}.`,
      );
    }
    const clocked = (clockedOf.get(e.email) ?? []).find(
      (c) => Date.parse(c.start_at) < e.end && (c.end_at ? Date.parse(c.end_at) : now) > e.start,
    );
    if (clocked) {
      const from = Date.parse(clocked.start_at);
      e.result.error(
        null,
        clocked.end_at
          ? `Overlaps clocked time, ${span(from, Date.parse(clocked.end_at))}.`
          : `Overlaps clocked time since ${local(from)} (still clocked in).`,
      );
    }
    if (e.result.ok && e.result.action === null) e.result.action = "create";
  }

  // Rows of the file mustn't overlap each other (unchanged ones included).
  const perPerson = new Map<string, Entry[]>();
  for (const e of entries) perPerson.set(e.email, [...(perPerson.get(e.email) ?? []), e]);
  for (const list of perPerson.values()) {
    list.sort((a, b) => a.start - b.start || a.end - b.end || a.result.row - b.result.row);
    let latest: Entry | undefined;
    for (const e of list) {
      if (latest && e.start < latest.end) {
        const other = latest.result.row;
        if (e.start === latest.start && e.end === latest.end) {
          e.result.error(null, `The same entry is also on row ${other}.`);
        } else {
          e.result.error(null, `Overlaps row ${other}.`);
        }
      }
      if (!latest || e.end > latest.end) latest = e;
    }
  }

  const items = entries
    .filter((e) => e.result.ok && e.result.action === "create")
    .map((e) => e.item);
  return { rows: results.map((r) => r.preview()), items };
}

/**
 * The people and dates a time-entry file is about, so the page can load what's already
 * there for them (TimeContext). Null when the file can't be read or names nobody.
 */
export function timeEntriesScope(
  read: CsvReadResult,
): { emails: string[]; from: string; to: string } | null {
  if (!read.ok) return null;
  const { header, rows } = read.table;
  const map = mapColumns("time_entries", header);
  if (map.errors.length > 0) return null;
  const emails = new Set<string>();
  let from: string | undefined;
  let to: string | undefined;
  for (const r of rows) {
    const cells = rowCells(r, header, map);
    const email = parseEmail(cells.get("email"));
    const date = parseDate(cells.get("date"));
    if (!email.ok || !date.ok) continue;
    emails.add(email.value);
    if (!from || date.value < from) from = date.value;
    if (!to || date.value > to) to = date.value;
  }
  if (!from || !to || emails.size === 0) return null;
  return { emails: [...emails].sort(), from, to };
}
