// A CSV reader for imports (#256), the inverse of csv.ts's writer. Pure: text in, rows
// out, so the dashboard (and anything else) reads what toCsv writes.
//
// RFC 4180, read leniently, the way spreadsheets save files:
//   - a byte order mark at the start is dropped (Excel's "CSV UTF-8" writes one);
//   - rows end in CRLF, LF or a lone CR;
//   - a quoted cell may hold commas, line breaks and "" (one quote);
//   - text after a closing quote is kept ("ab"c reads as abc), a quote inside an
//     unquoted cell is kept as it is; only a quote that never closes is an error;
//   - the separator is a comma, or a semicolon or tab when the header row has no comma
//     but has one of those (spreadsheets in some locales save with semicolons);
//   - blank rows (every cell empty or spaces) are skipped but still counted, so row
//     numbers match what a spreadsheet shows: the header is row 1.
//
// toCsv puts an apostrophe before text a spreadsheet would run as a formula; unguardCell
// takes it off again, so an exported file imports as the values it came from.

/** The most data rows (the header not counted) an import reads. */
export const CSV_IMPORT_MAX_ROWS = 5_000;

export type CsvDelimiter = "," | ";" | "\t";

export interface CsvRow {
  /** The row number a spreadsheet shows for this row (the header is row 1). */
  row: number;
  cells: string[];
}

export interface CsvTable {
  header: string[];
  /** Data rows, blank ones left out. */
  rows: CsvRow[];
  delimiter: CsvDelimiter;
}

export type CsvReadResult = { ok: true; table: CsvTable } | { ok: false; error: string };

export interface CsvReadOptions {
  /** Default CSV_IMPORT_MAX_ROWS. */
  maxRows?: number;
  /** Default: detected from the header row. */
  delimiter?: CsvDelimiter;
}

/** The separator the first row uses: a comma unless it has none and has a ; or tab. */
export function detectDelimiter(text: string): CsvDelimiter {
  let quoted = false;
  let semicolons = 0;
  let tabs = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted) {
      if (c === ",") return ",";
      if (c === ";") semicolons++;
      else if (c === "\t") tabs++;
      else if (c === "\n" || c === "\r") break;
    }
  }
  if (semicolons === 0 && tabs === 0) return ",";
  return semicolons >= tabs ? ";" : "\t";
}

interface RawRecord {
  row: number;
  cells: string[];
}

/** Every record, blank ones included, numbered from 1. Throws on a quote that never closes. */
function records(text: string, delimiter: CsvDelimiter): RawRecord[] {
  const out: RawRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let quoteRow = 0;
  let started = false; // anything read since the last row ended
  const end = () => {
    cells.push(cell);
    out.push({ row: out.length + 1, cells });
    cells = [];
    cell = "";
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") {
      quoted = true;
      quoteRow = out.length + 1;
      started = true;
    } else if (c === delimiter) {
      cells.push(cell);
      cell = "";
      started = true;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      end();
    } else {
      cell += c;
      started = true;
    }
  }
  if (quoted) throw new Error(`A quoted value that starts on row ${quoteRow} never ends.`);
  if (started || cell !== "" || cells.length > 0) end();
  return out;
}

const blank = (cells: string[]) => cells.every((c) => c.trim() === "");

/**
 * The header row and the data rows of a CSV file. Fails, in plain words, when the file
 * is empty, a quote never closes, or it has more than `maxRows` data rows.
 */
export function readCsv(text: string, options: CsvReadOptions = {}): CsvReadResult {
  const maxRows = options.maxRows ?? CSV_IMPORT_MAX_ROWS;
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const delimiter = options.delimiter ?? detectDelimiter(body);
  let all: RawRecord[];
  try {
    all = records(body, delimiter);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return tableOf(all, maxRows, delimiter);
}

/**
 * The header (the first non-blank row) and the non-blank rows after it, numbered as
 * given; the same checks as readCsv. Shared with the XLSX reader.
 */
export function tableOf(all: CsvRow[], maxRows: number, delimiter: CsvDelimiter): CsvReadResult {
  const headerAt = all.findIndex((r) => !blank(r.cells));
  const header = all[headerAt];
  if (!header) return { ok: false, error: "The file is empty." };
  const rows = all.slice(headerAt + 1).filter((r) => !blank(r.cells));
  if (rows.length === 0) {
    return { ok: false, error: "The file has a header row but no data rows." };
  }
  if (rows.length > maxRows) {
    return {
      ok: false,
      error: `The file has ${rows.length.toLocaleString("en-US")} rows; the limit is ${maxRows.toLocaleString("en-US")}. Split it into smaller files.`,
    };
  }
  return { ok: true, table: { header: header.cells, rows, delimiter } };
}

// What csv.ts guards: text a spreadsheet would run as a formula.
const GUARDED = /^'(?:\s*[=+\-@]|[\t\r])/;

/** A cell without the apostrophe toCsv put before formula-like text. */
export function unguardCell(value: string): string {
  return GUARDED.test(value) ? value.slice(1) : value;
}
