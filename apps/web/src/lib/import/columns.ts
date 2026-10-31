// The columns of each import (#256) and how a file's header row maps to them. A header
// matches whatever its case, spaces or punctuation ("Manager E-mail" = manager_email)
// and common other names ("Reports to", "Full name", "Time zone"). Columns that match
// nothing are listed back as ignored; their values are never read.

import type { ImportKind } from "@ai-proctor/contracts";
import { type CsvRow, unguardCell } from "@ai-proctor/core";
import { normalizeHeader } from "./values";

export interface ColumnSpec {
  /** The name in the template and in error messages. */
  name: string;
  /** Other header names that mean this column. */
  synonyms: string[];
  /** The file must have this column. */
  required: boolean;
  /** The template's example value. */
  example: string;
}

const col = (name: string, example: string, synonyms: string[] = [], required = false) => ({
  name,
  synonyms,
  required,
  example,
});

const EMAIL = ["email address", "e-mail", "work email", "mail"];
const MEMBERS = ["member", "member emails", "members emails", "people", "emails"];
const TIMEZONE = ["time zone", "tz", "zone"];

export const COLUMNS: Record<ImportKind, ColumnSpec[]> = {
  people: [
    col("email", "jane.doe@example.com", EMAIL, true),
    col("name", "Jane Doe", ["full name", "full_name", "employee name", "display name"]),
    col("role", "employee", ["user role"]),
    col("manager_email", "manager@example.com", [
      "manager",
      "manager e-mail",
      "reports to",
      "reports to email",
      "supervisor",
      "supervisor email",
      "line manager",
    ]),
    col("team", "Support", ["team name", "group"]),
    col("country", "US", ["work country", "country code"]),
    col("state", "NY", ["work state", "state code", "us state"]),
    col("work_location", "", ["location", "work location"]),
    col("timezone", "America/New_York", TIMEZONE),
  ],
  teams: [
    col("team", "Support", ["name", "team name"], true),
    col("members", "jane.doe@example.com; sam.lee@example.com", MEMBERS),
  ],
  clients: [
    col("name", "Acme Corp", ["client", "client name", "customer"], true),
    col("archived", "no", ["archive", "is archived"]),
  ],
  projects: [
    col("project", "Website redesign", ["name", "project name"], true),
    col("client", "Acme Corp", ["client name", "customer"]),
    col("billable", "yes", ["is billable"]),
    col("archived", "no", ["archive", "is archived"]),
    col("members", "jane.doe@example.com; sam.lee@example.com", MEMBERS),
  ],
  shifts: [
    col("email", "jane.doe@example.com", [...EMAIL, "employee email", "person"], true),
    col("days", "Mon-Fri", ["day", "weekdays", "days of week", "working days"], true),
    col("start", "09:00", ["start time", "shift start", "from", "starts"], true),
    col("end", "17:30", ["end time", "shift end", "to", "ends"], true),
    col("timezone", "America/New_York", TIMEZONE),
  ],
};

// The template leaves the combined work location out: country and state say the same.
export const TEMPLATE_SKIP = new Set(["work_location"]);

export interface ColumnMap {
  /** Column name -> index in the row. */
  index: Map<string, number>;
  ignored: string[];
  errors: string[];
}

/** Which header cell is which column; file-level errors for repeats and missing ones. */
export function mapColumns(kind: ImportKind, header: string[]): ColumnMap {
  const specs = COLUMNS[kind];
  const lookup = new Map<string, ColumnSpec>();
  for (const spec of specs) {
    for (const name of [spec.name, ...spec.synonyms]) lookup.set(normalizeHeader(name), spec);
  }
  const index = new Map<string, number>();
  const ignored: string[] = [];
  const errors: string[] = [];
  header.forEach((cell, i) => {
    const text = unguardCell(cell).trim();
    const key = normalizeHeader(text);
    if (!key) return;
    const spec = lookup.get(key);
    if (!spec) {
      ignored.push(text);
      return;
    }
    const first = index.get(spec.name);
    if (first !== undefined) {
      errors.push(
        `The columns "${unguardCell(header[first] ?? "").trim()}" and "${text}" both mean ${spec.name}. Keep one.`,
      );
      return;
    }
    index.set(spec.name, i);
  });
  for (const spec of specs) {
    if (spec.required && !index.has(spec.name)) {
      errors.push(`The file needs the ${spec.name} column.`);
    }
  }
  return { index, ignored, errors };
}

/** One data row, read by column name. */
export interface RowCells {
  row: number;
  /** The trimmed cell, without a CSV formula guard; "" when empty or not in the file. */
  get(name: string): string;
  /** Whether the file has this column. */
  has(name: string): boolean;
  /** The row has values past the last header cell. */
  overflow: boolean;
}

export function rowCells(row: CsvRow, header: string[], map: ColumnMap): RowCells {
  return {
    row: row.row,
    get: (name) => {
      const i = map.index.get(name);
      return i === undefined ? "" : unguardCell(row.cells[i] ?? "").trim();
    },
    has: (name) => map.index.has(name),
    overflow: row.cells.slice(header.length).some((c) => c.trim() !== ""),
  };
}
