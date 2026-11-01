// Comments on a week (#265, TS-33): read a week's comments, add one, and read who approved the
// week for the lock banner. The rules live in the database (who may comment, the target, the
// length); messages here only explain its error codes.
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import type { CommentTarget, SheetComment } from "./comments";

const errors: Record<string, string> = {
  invalid_comment: "Write a comment of up to 2,000 characters.",
  invalid_target: "That row or entry isn't part of this week.",
  not_allowed: "Only the employee and the people who review the week can comment.",
  timesheet_not_found: "This week isn't one you can see.",
  entry_not_found: "That entry isn't one you can see.",
};

function explain(message: string): string {
  return errors[message] ?? message;
}

/** Every comment on a week: its rows and the manual entries that start in it. */
export const sheetCommentsQuery = (timesheetId: string) =>
  queryOptions({
    queryKey: ["timesheet-comments", timesheetId],
    // Threads mount as their rows and entries load, after this read may have finished; fresh
    // for a while so each doesn't read the week's comments again (#267). Posting reloads them.
    staleTime: 60_000,
    queryFn: async (): Promise<SheetComment[]> => {
      const { data, error } = await supabase
        .from("timesheet_comments")
        .select(
          "id, timesheet_id, user_id, target, project_id, task_id, manual_entry_id, author_id, author_name, body, created_at",
        )
        .eq("timesheet_id", timesheetId)
        .order("created_at")
        .order("id");
      if (error) throw error;
      return data.map((c) => ({
        id: c.id,
        timesheetId: c.timesheet_id,
        userId: c.user_id,
        target: c.target === "entry" ? "entry" : "row",
        projectId: c.project_id,
        taskId: c.task_id,
        manualEntryId: c.manual_entry_id,
        authorId: c.author_id,
        authorName: c.author_name,
        body: c.body,
        createdAt: c.created_at,
      }));
    },
  });

/** The week's comments; shared by every thread on the page (one read per week). */
export function useSheetComments(timesheetId: string) {
  return useQuery({ ...sheetCommentsQuery(timesheetId), enabled: timesheetId !== "" });
}

/** Adds a comment to a row of the week or to one of its manual entries. Returns its id. */
export async function addComment(
  timesheetId: string,
  target: CommentTarget,
  body: string,
): Promise<string> {
  // Generated types don't mark function arguments nullable; null is "not this target".
  const { data, error } = await supabase.rpc(
    "add_timesheet_comment",
    target.kind === "entry"
      ? { p_timesheet_id: timesheetId, p_body: body, p_manual_entry_id: target.entryId }
      : {
          p_timesheet_id: timesheetId,
          p_body: body,
          p_project_id: target.projectId as string,
          p_task_id: (target.projectId === null ? null : target.taskId) as string,
        },
  );
  if (error) throw new Error(explain(error.message));
  return data;
}

/** Posts to one thread and reloads the week's comments. */
export function useAddComment(timesheetId: string, target: CommentTarget) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => addComment(timesheetId, target, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["timesheet-comments"] }),
  });
}

/**
 * Who approved the week (null while not approved, and when it approved itself, TS-16). Keyed
 * by when it was approved, so a new approval reads again.
 */
export const approverQuery = (timesheetId: string, approvedAt: string | null) =>
  queryOptions({
    queryKey: ["timesheet-approver", timesheetId, approvedAt],
    queryFn: async (): Promise<{ approverId: string | null; approverName: string | null }> => {
      const [sheet, name] = await Promise.all([
        supabase.from("timesheets").select("approver_id").eq("id", timesheetId).single(),
        supabase.rpc("timesheet_approver_name", { p_id: timesheetId }),
      ]);
      if (sheet.error) throw sheet.error;
      if (name.error) throw name.error;
      return { approverId: sheet.data.approver_id, approverName: name.data };
    },
  });
