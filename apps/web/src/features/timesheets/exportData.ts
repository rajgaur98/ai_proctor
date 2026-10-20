// Timesheet export (#45, TS-20..23): asks the export-timesheet Edge Function for a CSV
// and hands it to the browser as a download. The access check and the audit row are the
// database's; these are only the lists the form offers and the call.
import { type ExportView, exportFilename } from "@ai-proctor/core";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import type { SheetStatus } from "./timesheetData";

export const exportViewLabel: Record<ExportView, string> = {
  daily: "Per employee per day",
  project: "Per project and client, per employee",
  segments: "Segment detail",
};

export interface ExportRequest {
  view: ExportView;
  from: string;
  to: string;
  userId: string;
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
  export_failed: "The export failed. Try again.",
};

async function explain(error: Error): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = (await error.context.json().catch(() => null)) as { error?: string } | null;
    return messages[body?.error ?? ""] ?? messages.export_failed ?? error.message;
  }
  return error.message;
}

/** Downloads the export; throws a message the form can show. */
export async function downloadExport(r: ExportRequest): Promise<void> {
  const filters = {
    from: r.from,
    to: r.to,
    ...(r.userId ? { user_ids: [r.userId] } : {}),
    ...(r.clientId ? { client_ids: [r.clientId] } : {}),
    ...(r.projectId ? { project_ids: [r.projectId] } : {}),
    ...(r.status ? { statuses: [r.status] } : {}),
  };
  const { data, error } = await supabase.functions.invoke("export-timesheet", {
    body: { view: r.view, filters },
  });
  if (error) throw new Error(await explain(error));

  const url = URL.createObjectURL(new Blob([data as string], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = exportFilename(r.view, r.from, r.to);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
