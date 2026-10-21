// Timesheet export (#45, #65, TS-20..23): asks the export-timesheet Edge Function for a
// CSV or XLSX file and hands it to the browser as a download. The access check and the
// audit row are the database's; these are only the lists the form offers and the call.
import { type ExportFormat, type ExportView, exportFilename } from "@ai-proctor/core";
import { queryOptions } from "@tanstack/react-query";
import { callFunction, FunctionError, saveDownload } from "../../lib/functions";
import { supabase } from "../../lib/supabase";
import type { SheetStatus } from "./timesheetData";

export const exportViewLabel: Record<ExportView, string> = {
  daily: "Per employee per day",
  project: "Per project and client, per employee",
  segments: "Segment detail",
};

export const exportFormatLabel: Record<ExportFormat, string> = { csv: "CSV", xlsx: "XLSX" };

export interface ExportRequest {
  view: ExportView;
  format: ExportFormat;
  from: string;
  to: string;
  userId: string;
  /** TS-20: one team ("" is everyone the viewer can see). */
  teamId: string;
  clientId: string;
  projectId: string;
  status: SheetStatus | "";
}

/** The people the viewer may export (row-level security limits the list). */
export const exportPeopleQuery = queryOptions({
  queryKey: ["export-people"],
  queryFn: async () => {
    const { data, error } = await supabase.from("users").select("id, full_name").order("full_name");
    if (error) throw error;
    return data;
  },
});

const messages: Record<string, string> = {
  forbidden: "You can't export that person's time.",
  invalid_request: "Check the dates and filters. The range can be up to a year.",
  not_signed_in: "Sign in again to export.",
  too_large: "Too many rows for a spreadsheet. Choose a shorter range or CSV.",
  export_failed: "The export failed. Try again.",
};
const failed = messages.export_failed as string;

/** Downloads the export; throws a message the form can show. */
export async function downloadExport(r: ExportRequest): Promise<void> {
  const filters = {
    from: r.from,
    to: r.to,
    ...(r.userId ? { user_ids: [r.userId] } : {}),
    ...(r.teamId ? { team_id: r.teamId } : {}),
    ...(r.clientId ? { client_ids: [r.clientId] } : {}),
    ...(r.projectId ? { project_ids: [r.projectId] } : {}),
    ...(r.status ? { statuses: [r.status] } : {}),
  };
  let res: Response;
  try {
    // The raw response: the XLSX is binary, which supabase.functions.invoke reads as text.
    res = await callFunction(
      "export-timesheet",
      { view: r.view, format: r.format, filters },
      failed,
    );
  } catch (e) {
    if (e instanceof FunctionError) throw new Error(messages[e.code ?? ""] ?? e.message);
    throw e;
  }
  await saveDownload(res, exportFilename(r.view, r.from, r.to, r.format));
}
