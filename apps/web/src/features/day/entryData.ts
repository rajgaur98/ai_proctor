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
  /** The project's task (#254, PRJ-05). */
  taskId: string | null;
  reason: string;
  /** What was done (TS-24). */
  note: string | null;
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
        .select("id, start_at, end_at, project_id, task_id, reason, note, status, decision_note")
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
        taskId: e.task_id,
        reason: e.reason,
        note: e.note,
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
    p_task_id: (r.task_id ?? null) as string,
    p_note: (r.note ?? null) as string,
  });
  if (error) throw new Error(explain(error.message));
}

/**
 * TS-24 (#254): changes an entry's task and work note. The employee's own change needs no
 * reason; anyone else's does (audit-logged, the employee is told).
 */
export async function updateEntryDetails(
  id: string,
  taskId: string | null,
  note: string | null,
  reason?: string,
): Promise<void> {
  const { error } = await supabase.rpc("update_manual_entry_details", {
    p_id: id,
    // Generated types don't mark function arguments nullable.
    p_task_id: taskId as string,
    p_note: note as string,
    ...(reason ? { p_reason: reason } : {}),
  });
  if (error) throw new Error(explain(error.message));
}

/**
 * #263 (TS-30): the employee changes the times, task and note of their own entry, on a
 * draft or returned week. New times on an approved entry need approving again.
 */
export async function editEntry(
  id: string,
  e: { startAt: string; endAt: string; taskId: string | null; note: string | null },
): Promise<void> {
  const { error } = await supabase.rpc("edit_manual_entry", {
    p_id: id,
    p_start_at: e.startAt,
    p_end_at: e.endAt,
    // Generated types don't mark function arguments nullable.
    p_task_id: e.taskId as string,
    p_note: e.note as string,
  });
  if (error) throw new Error(explain(error.message));
}

/** #263: splits the employee's own entry at `at` into two; returns the second part's id. */
export async function splitEntry(id: string, at: string): Promise<string> {
  const { data, error } = await supabase.rpc("split_manual_entry", { p_id: id, p_at: at });
  if (error) throw new Error(explain(error.message));
  return data;
}

/** #263: merges two of the employee's own entries that touch; returns the kept one's id. */
export async function mergeEntries(first: string, second: string): Promise<string> {
  const { data, error } = await supabase.rpc("merge_manual_entries", {
    p_first: first,
    p_second: second,
  });
  if (error) throw new Error(explain(error.message));
  return data;
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
  // A decision note is at most 500 characters, a work note 2,000.
  invalid_note: "That note is too long.",
  project_not_allowed: "You can't log time to that project.",
  overlaps_clocked_time: "That overlaps time you were clocked in.",
  overlaps_manual_entry: "That overlaps another manual entry.",
  day_locked: "That day is in a submitted timesheet.",
  entry_not_found: "That entry no longer exists.",
  not_the_manager: "Only the direct manager can decide this.",
  not_pending: "This entry has already been decided.",
  task_not_allowed: "That task isn't available for this project.",
  not_adjustable: "A rejected entry can't be changed.",
  timesheet_submitted: "This week is with your manager. You can change it if they return it.",
  timesheet_locked: "This week is approved. It can't change unless it's reopened.",
  not_your_entry: "Only the employee changes their own entries.",
  invalid_split: "Choose a time inside the entry.",
  invalid_merge: "Choose two entries to merge.",
  not_adjacent: "Only entries that follow on from each other can be merged.",
  not_same_day: "Only entries on the same day can be merged.",
  not_same_assignment: "Only entries with the same project and task can be merged.",
};

export function explain(code: string): string {
  return messages[code] ?? code;
}
