// CSV writer for exports (RFC 4180): comma separated, CRLF between records, fields
// with a comma, quote or line break in double quotes with "" for a quote. Text that
// a spreadsheet would run as a formula (starts with = + - @, a tab or a line break)
// gets a leading ' so it opens as plain text (CSV injection).

export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r\n]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvField(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  // Numbers are written as they are, so a negative one is not mistaken for a formula.
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  const text = FORMULA_START.test(cell) ? `'${cell}` : cell;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One record per row, each ending in CRLF. */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return rows.map((row) => `${row.map(csvField).join(",")}\r\n`).join("");
}
