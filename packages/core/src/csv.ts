// A small CSV writer (RFC 4180) for exports (PRD 4.10 TS-20). Pure: strings in, string
// out, so the Edge Function and the dashboard share it.
//
// Spreadsheets run a cell that starts with = + - @ (or a tab or carriage return) as a
// formula, and names and project titles are user text. Such strings get a leading
// apostrophe, which spreadsheets show as plain text. Numbers are never changed.

export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_START = /^\s*[=+\-@]|^[\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One cell as it appears in the file: formula-guarded, then quoted when it must be. */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows as CSV: comma separated, CRLF after every row (RFC 4180), nothing for no rows. */
export function toCsv(rows: CsvCell[][]): string {
  return rows.map((row) => `${row.map(csvCell).join(",")}\r\n`).join("");
}
