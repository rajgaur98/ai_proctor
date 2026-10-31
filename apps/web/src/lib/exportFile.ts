// The files a list page exports (#255, TS-20 extended): a table of what the page shows,
// written as CSV or XLSX with the timesheet export's writers (#65, packages/core). Pure,
// so the name and the bytes are tested without a browser or a database.
import {
  type CellValue,
  decimalHours,
  EXPORT_FORMATS,
  type ExportFormat,
  toCsv,
  XLSX_MIME,
  xlsxWorkbook,
} from "@ai-proctor/core";
import { DateTime } from "luxon";

export { EXPORT_FORMATS, type ExportFormat };

export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = { csv: "CSV", xlsx: "XLSX" };

/** One sheet: a header row, then one row per item. Numbers stay numbers in the XLSX. */
export interface ExportTable {
  /** The XLSX sheet's name: up to 31 characters, none of : \ / ? * [ ]. */
  sheet: string;
  header: string[];
  rows: CellValue[][];
}

/**
 * The page's current filters as the page names them, with values as people read them
 * (a team's name, not its id). "" means not filtered; such entries are left out of the
 * file name and the audit row.
 */
export type ExportFilters = Record<string, string>;

/** The filters that are set, in the page's order. */
export function activeFilters(filters: ExportFilters): ExportFilters {
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => v.trim() !== ""));
}

/** An instant as ISO 8601 with the offset of `zone` (the viewer's by default), to the second. */
export function exportTime(iso: string | null, zone?: string): string {
  if (!iso) return "";
  const t = DateTime.fromISO(iso, zone ? { zone } : {});
  return t.isValid ? (t.toISO({ suppressMilliseconds: true }) ?? iso) : iso;
}

/** Whole seconds as decimal hours (2 places, the timesheet export's rounding), as a number. */
export function exportHours(seconds: number): number {
  return Number(decimalHours(seconds));
}

export const yesNo = (v: boolean): string => (v ? "Yes" : "No");

/** Lower case ASCII letters and digits, with single hyphens between words. */
export function slug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** How much of the name the filters may take, so it stays readable and short. */
const FILTERS_MAX = 60;

/**
 * `<page>-<filters>-<date>.<format>`: people-all-2026-10-31.csv,
 * alerts-missed-check-ins_erin-employee-2026-10-31.xlsx. The filters are the values
 * that are set, each made safe for a file name, joined with "_"; "all" when none is.
 */
export function exportFilename(
  page: string,
  filters: ExportFilters,
  format: ExportFormat,
  date: string,
): string {
  const parts = Object.values(activeFilters(filters)).map(slug).filter(Boolean);
  const joined = parts
    .join("_")
    .slice(0, FILTERS_MAX)
    .replace(/[-_]+$/, "");
  return `${slug(page) || "export"}-${joined || "all"}-${date}.${format}`;
}

/** Column widths for the XLSX, from the longest text in each column (capped). */
function widths(table: ExportTable): number[] {
  return table.header.map((h, i) => {
    let longest = h.length;
    for (const row of table.rows) {
      const v = row[i];
      if (v !== null && v !== undefined) longest = Math.max(longest, String(v).length);
    }
    return Math.min(60, Math.max(8, longest + 2));
  });
}

/** The file's contents and type: CSV text (RFC 4180, formula-guarded) or XLSX bytes. */
export function exportContents(
  format: ExportFormat,
  table: ExportTable,
): { data: string | Uint8Array; type: string } {
  if (format === "csv") {
    return { data: toCsv([table.header, ...table.rows]), type: "text/csv;charset=utf-8" };
  }
  return {
    data: xlsxWorkbook([
      {
        name: table.sheet,
        rows: [table.header.map((h) => ({ value: h, style: { bold: true } })), ...table.rows],
        widths: widths(table),
        freezeHeader: true,
      },
    ]),
    type: XLSX_MIME,
  };
}
