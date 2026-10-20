// Manual time entries (#42, TS-07..09): read a day's entries, request one, and
// decide or cancel. The rules live in the database; messages here only explain
// its error codes.
import type { ManualEntryRequest } from "@ai-proctor/contracts";
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";

export type EntryStatus = "pending" | "approved" | "rejected";

export interface ManualEntry {
  id: string;
  startAt: string;
  endAt: string;
  projectId: string | null;
  reason: string;
  status: EntryStatus;
  decisionNote: string | null;
}

/** Entries that overlap [fromIso, toIso), the employee's local day. */
export const dayEntriesQuery = (userId: string, fromIso: string, toIso: string) =>
  queryOptions({
    queryKey: ["manual-entries", userId, fromIso, toIso],
    queryFn: async (): Promise<ManualEntry[]> => {
      const { data, error } = await supabase
        .from("manual_entries")
        .select("id, start_at, end_at, project_id, reason, status, decision_note")
        .eq("user_id", userId)
        .lt("start_at", toIso)
        .gt("end_at", fromIso)
        .order("start_at");
      if (error) throw error;
      return data.map((e) => ({
        id: e.id,
        startAt: e.start_at,
        endAt: e.end_at,
        projectId: e.project_id,
        reason: e.reason,
        status: e.status as EntryStatus,
        decisionNote: e.decision_note,
      }));
    },
  });

export async function requestEntry(r: ManualEntryRequest): Promise<void> {
  const { error } = await supabase.rpc("request_manual_entry", {
    p_start_at: r.start_at,
    p_end_at: r.end_at,
    // Generated types don't mark function arguments nullable; no project is Unassigned.
    p_project_id: r.project_id as string,
    p_reason: r.reason,
  });
  if (error) throw new Error(explain(error.message));
}

export async function decideEntry(id: string, approve: boolean, note: string): Promise<void> {
  const { error } = await supabase.rpc("decide_manual_entry", {
    p_id: id,
    p_approve: approve,
    p_note: note.trim(),
  });
  if (error) throw new Error(explain(error.message));
}

export async function cancelEntry(id: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_manual_entry", { p_id: id });
  if (error) throw new Error(explain(error.message));
}

const messages: Record<string, string> = {
  invalid_range: "The end must be after the start.",
  range_too_long: "An entry can be at most 24 hours.",
  in_the_future: "The entry can't end in the future.",
  invalid_reason: "Give a reason of up to 500 characters.",
  invalid_note: "The note can be at most 500 characters.",
  project_not_allowed: "You can't log time to that project.",
  overlaps_clocked_time: "That overlaps time you were clocked in.",
  overlaps_manual_entry: "That overlaps another manual entry.",
  day_locked: "That day is in a submitted timesheet.",
  entry_not_found: "That entry no longer exists.",
  not_the_manager: "Only the direct manager can decide this.",
  not_pending: "This entry has already been decided.",
};

export function explain(code: string): string {
  return messages[code] ?? code;
}
