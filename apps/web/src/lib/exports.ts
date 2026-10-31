// Runs a list page's export (#255, TS-20 extended, AUD-01): builds the page's table from
// the page's own queries (so row-level security and the page's filters decide what is in
// it), records the export in the audit log, then hands the file to the browser. Nothing
// is saved when the audit row can't be written.
import { DateTime } from "luxon";
import {
  activeFilters,
  type ExportFilters,
  type ExportFormat,
  type ExportTable,
  exportContents,
  exportFilename,
} from "./exportFile";
import { supabase } from "./supabase";

export interface ExportSpec {
  /** A short name for the page, in file names and the audit log: "people", "alerts". */
  page: string;
  /** The page's current filters (see ExportFilters). */
  filters: ExportFilters;
  /** The rows the page shows, from the page's queries; may fetch every page of a long list. */
  table: () => ExportTable | Promise<ExportTable>;
}

const messages: Record<string, string> = {
  not_signed_in: "Sign in again to export.",
  not_a_member: "You're no longer a member of this organisation.",
  user_inactive: "Your account is deactivated.",
};

/** Writes the `export.created` audit row; throws a message the page can show. */
export async function recordExport(
  page: string,
  format: ExportFormat,
  filters: ExportFilters,
  rowCount: number,
): Promise<void> {
  const { error } = await supabase.rpc("record_export", {
    p_page: page,
    p_format: format,
    p_filters: activeFilters(filters),
    p_row_count: rowCount,
  });
  if (error) throw new Error(messages[error.message] ?? "The export failed. Try again.");
}

/** Hands a file to the browser as a download. */
export function saveFile(name: string, data: string | Uint8Array, type: string): void {
  // A fresh ArrayBuffer-backed copy keeps Blob's types happy for the XLSX bytes.
  const part = typeof data === "string" ? data : new Uint8Array(data);
  const url = URL.createObjectURL(new Blob([part], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // After the browser has taken the file.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Builds, records and downloads one export; returns the file's name and its row count. */
export async function runExport(
  spec: ExportSpec,
  format: ExportFormat,
): Promise<{ filename: string; rowCount: number }> {
  const table = await spec.table();
  const { data, type } = exportContents(format, table);
  await recordExport(spec.page, format, spec.filters, table.rows.length);
  const filename = exportFilename(
    spec.page,
    spec.filters,
    format,
    DateTime.now().toISODate() ?? "",
  );
  saveFile(filename, data, type);
  return { filename, rowCount: table.rows.length };
}
