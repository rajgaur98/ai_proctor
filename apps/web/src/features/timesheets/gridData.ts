// The week grid's own reads and writes (#264, TS-34): the rows the employee pinned, and
// copying last week's manual entries. The rules live in the database (set_timesheet_favourite,
// copy_week_manual_entries); this only calls them.
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { explain } from "../day/entryData";
import type { CopyResult } from "./copyWeek";
import type { GridAssignment } from "./weekGridModel";

/** The signed-in person's pinned rows (row-level security returns only their own). */
export const favouritesQuery = queryOptions({
  queryKey: ["timesheet-favourites"],
  queryFn: async (): Promise<GridAssignment[]> => {
    const { data, error } = await supabase
      .from("timesheet_favourites")
      .select("project_id, task_id")
      .order("created_at");
    if (error) throw error;
    return data.map((f) => ({ projectId: f.project_id, taskId: f.task_id }));
  },
});

/** Pins or unpins a row of the caller's grid. */
export async function setFavourite(a: GridAssignment, pinned: boolean): Promise<void> {
  const { error } = await supabase.rpc("set_timesheet_favourite", {
    p_project_id: a.projectId as string,
    // Generated types don't mark function arguments nullable; no task is the project's row.
    p_task_id: a.taskId as string,
    p_pinned: pinned,
  });
  if (error) throw new Error(favouriteMessages[error.message] ?? explain(error.message));
}

const favouriteMessages: Record<string, string> = {
  too_many_favourites: "You can pin at most 50 rows. Unpin one first.",
};

/**
 * Copies the caller's manual entries `entryIds` from the week before `week` into `week`,
 * seven days later at the same times; one result per entry, copied or skipped.
 */
export async function copyWeekEntries(week: string, entryIds: string[]): Promise<CopyResult[]> {
  const { data, error } = await supabase.rpc("copy_week_manual_entries", {
    p_week: week,
    p_entry_ids: entryIds,
  });
  if (error) throw new Error(explain(error.message));
  return (data as { entry_id: string; id?: string; skipped?: string }[]).map((r) => ({
    entryId: r.entry_id,
    id: r.id ?? null,
    skipped: r.skipped ?? null,
  }));
}
