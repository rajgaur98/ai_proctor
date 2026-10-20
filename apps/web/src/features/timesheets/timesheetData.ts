// Weekly timesheets (#43, TS-10..13, TS-18, DSH-06): read a week, and submit,
// approve, return, reopen and edit it. The rules live in the database; messages
// here only explain its error codes.
import type { ManualEntryRequest } from "@ai-proctor/contracts";
import { queryOptions } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { supabase } from "../../lib/supabase";
import type { TimeSegment } from "./reassign";
import type { BreakdownRow } from "./summary";
import { weekDays, weekStartDay } from "./weeks";

export type SheetStatus = "draft" | "submitted" | "approved" | "returned";
export type EditKind = "keep" | "exclude" | "include" | "project" | "adjust" | "employee_project";

export interface Timesheet {
  id: string;
  userId: string;
  periodStart: string;
  status: SheetStatus;
  submittedAt: string | null;
  approvedAt: string | null;
  returnedAt: string | null;
  comment: string | null;
}

export interface FlaggedSegment {
  id: string;
  day: string;
  type: string;
  startAt: string;
  endAt: string;
  projectId: string | null;
  excluded: boolean;
  excludedReason: string | null;
  /** The manager's review decision; null while undecided (and always for the employee). */
  decision: "keep" | "exclude" | null;
}

export interface SheetEdit {
  id: string;
  kind: EditKind;
  startAt: string;
  endAt: string;
  projectId: string | null;
  reason: string | null;
  editorId: string | null;
  createdAt: string;
}

const sheetColumns =
  "id, user_id, period_start, status, submitted_at, approved_at, returned_at, comment";

export const statusLabel: Record<SheetStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  returned: "Returned",
};

/** The org's week-start day (policy.week_start), as a Luxon weekday. */
export const weekStartQuery = queryOptions({
  queryKey: ["week-start"],
  staleTime: 5 * 60_000,
  queryFn: async (): Promise<number> => {
    // Members read only their own org, so this is the viewer's.
    const { data, error } = await supabase.from("orgs").select("policy").limit(1).maybeSingle();
    if (error) throw error;
    const policy = (data?.policy ?? {}) as { week_start?: unknown };
    return weekStartDay(policy.week_start);
  },
});

/** One person's week, created as a draft the first time it's opened. */
export const timesheetQuery = (userId: string, weekStart: string) =>
  queryOptions({
    queryKey: ["timesheet", userId, weekStart],
    queryFn: async (): Promise<Timesheet> => {
      const ensured = await supabase.rpc("ensure_timesheet", {
        p_user_id: userId,
        p_period_start: weekStart,
      });
      if (ensured.error) throw new Error(explain(ensured.error.message));
      const { data, error } = await supabase
        .from("timesheets")
        .select(sheetColumns)
        .eq("id", ensured.data)
        .single();
      if (error) throw error;
      return toTimesheet(data);
    },
  });

function toTimesheet(r: {
  id: string;
  user_id: string;
  period_start: string;
  status: string;
  submitted_at: string | null;
  approved_at: string | null;
  returned_at: string | null;
  comment: string | null;
}): Timesheet {
  return {
    id: r.id,
    userId: r.user_id,
    periodStart: r.period_start,
    status: r.status as SheetStatus,
    submittedAt: r.submitted_at,
    approvedAt: r.approved_at,
    returnedAt: r.returned_at,
    comment: r.comment,
  };
}

export const breakdownQuery = (userId: string, weekStart: string) =>
  queryOptions({
    queryKey: ["timesheet-breakdown", userId, weekStart],
    queryFn: async (): Promise<BreakdownRow[]> => {
      const days = weekDays(weekStart);
      const { data, error } = await supabase.rpc("timesheet_breakdown", {
        p_user_id: userId,
        p_from: days[0] ?? weekStart,
        p_to: days[6] ?? weekStart,
      });
      if (error) throw error;
      return data.map((r) => ({
        day: r.day,
        type: r.type,
        projectId: r.project_id,
        counted: r.counted,
        flagged: r.flagged,
        excluded: r.excluded,
        seconds: r.seconds,
      }));
    },
  });

export const flaggedQuery = (userId: string, weekStart: string) =>
  queryOptions({
    queryKey: ["timesheet-flagged", userId, weekStart],
    queryFn: async (): Promise<FlaggedSegment[]> => {
      const days = weekDays(weekStart);
      const { data, error } = await supabase.rpc("timesheet_flagged_segments", {
        p_user_id: userId,
        p_from: days[0] ?? weekStart,
        p_to: days[6] ?? weekStart,
      });
      if (error) throw error;
      return data.map((r) => ({
        id: r.id,
        day: r.day,
        type: r.type,
        startAt: r.start_at,
        endAt: r.end_at,
        projectId: r.project_id,
        excluded: r.excluded,
        excludedReason: r.excluded_reason,
        decision: r.decision === "keep" || r.decision === "exclude" ? r.decision : null,
      }));
    },
  });

/**
 * Counted, not excluded time of a week as stored, for the employee's Unassigned list
 * (PRJ-03/04). Time segments are visible to the person they belong to.
 */
export const segmentsQuery = (userId: string, weekStart: string) =>
  queryOptions({
    queryKey: ["timesheet-segments", userId, weekStart],
    queryFn: async (): Promise<TimeSegment[]> => {
      const days = weekDays(weekStart);
      const { data, error } = await supabase
        .from("time_segments")
        .select("start_at, end_at, project_id, counted, excluded, flagged")
        .eq("user_id", userId)
        .gte("day", days[0] ?? weekStart)
        .lte("day", days[6] ?? weekStart)
        .eq("counted", true)
        .eq("excluded", false)
        .order("start_at");
      if (error) throw error;
      return data.map((r) => ({
        startAt: r.start_at,
        endAt: r.end_at,
        projectId: r.project_id,
        counted: r.counted,
        excluded: r.excluded,
        flagged: r.flagged,
      }));
    },
  });

/** Edits to the week (the manager's and the employee's), oldest first. 'keep' decisions never reach the employee. */
export const editsQuery = (timesheetId: string) =>
  queryOptions({
    queryKey: ["timesheet-edits", timesheetId],
    queryFn: async (): Promise<SheetEdit[]> => {
      const { data, error } = await supabase
        .from("timesheet_edits")
        .select("id, kind, start_at, end_at, project_id, reason, editor_id, created_at")
        .eq("timesheet_id", timesheetId)
        .neq("kind", "keep")
        .order("seq");
      if (error) throw error;
      return data.map((e) => ({
        id: e.id,
        kind: e.kind as EditKind,
        startAt: e.start_at,
        endAt: e.end_at,
        projectId: e.project_id,
        reason: e.reason,
        editorId: e.editor_id,
        createdAt: e.created_at,
      }));
    },
  });

/** Whether the viewer is this person's direct manager or active delegate. */
export const canDecideQuery = (userId: string) =>
  queryOptions({
    queryKey: ["can-decide", userId],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc("can_decide_timesheet", { target: userId });
      if (error) throw error;
      return data === true;
    },
  });

/**
 * Whether the viewer can reopen this person's approved week: their direct manager or
 * active delegate, or the owner at the top of the org on their own auto-approved week.
 */
export const canReopenQuery = (userId: string) =>
  queryOptions({
    queryKey: ["can-reopen", userId],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc("can_reopen_timesheet", { target: userId });
      if (error) throw error;
      return data === true;
    },
  });

export interface ListRow extends Timesheet {
  fullName: string;
  timezone: string;
  workedS: number;
  flaggedS: number;
  excludedS: number;
}

/** The timesheets the viewer can see for a week, with totals (DSH-06). */
export const weekListQuery = (weekStart: string) =>
  queryOptions({
    queryKey: ["timesheet-list", weekStart],
    queryFn: async (): Promise<ListRow[]> => {
      const days = weekDays(weekStart);
      const [sheets, totals] = await Promise.all([
        supabase
          .from("timesheets")
          .select(`${sheetColumns}, users!timesheets_user_id_fkey(full_name, timezone)`)
          .eq("period_start", weekStart),
        supabase.rpc("timesheet_totals", {
          p_from: days[0] ?? weekStart,
          p_to: days[6] ?? weekStart,
        }),
      ]);
      if (sheets.error) throw sheets.error;
      if (totals.error) throw totals.error;
      const byUser = new Map(totals.data.map((t) => [t.user_id, t]));
      return sheets.data
        .map((s) => {
          const t = byUser.get(s.user_id);
          return {
            ...toTimesheet(s),
            fullName: s.users?.full_name ?? "",
            timezone: s.users?.timezone ?? "UTC",
            workedS: t?.worked_s ?? 0,
            flaggedS: t?.flagged_s ?? 0,
            excludedS: t?.excluded_s ?? 0,
          };
        })
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
    },
  });

/**
 * Rebuilds the week's segments (the Edge Function accepts one day at a time from a
 * signed-in viewer), so what's shown or submitted is fresh. Days that haven't
 * started in the employee's zone have nothing to rebuild.
 */
export async function rebuildWeek(userId: string, weekStart: string, zone: string) {
  const today = DateTime.now().setZone(zone).toISODate() ?? weekStart;
  const days = weekDays(weekStart).filter((d) => d <= today);
  const results = await Promise.all(
    days.map((day) =>
      supabase.functions.invoke("rebuild-segments", { body: { user_id: userId, day } }),
    ),
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) throw new Error(`Couldn't refresh the week: ${failed.error.message}`);
}

/** Refreshes the week's segments, then submits it. Returns the new status. */
export async function submitWeek(
  sheet: Pick<Timesheet, "id" | "userId" | "periodStart">,
  zone: string,
): Promise<SheetStatus> {
  await rebuildWeek(sheet.userId, sheet.periodStart, zone);
  const { data, error } = await supabase.rpc("submit_timesheet", { p_id: sheet.id });
  if (error) throw new Error(explain(error.message));
  return data as SheetStatus;
}

/** Opens (creating, if needed) a person's week and submits it. */
export async function ensureAndSubmit(
  userId: string,
  weekStart: string,
  zone: string,
): Promise<SheetStatus> {
  const ensured = await supabase.rpc("ensure_timesheet", {
    p_user_id: userId,
    p_period_start: weekStart,
  });
  if (ensured.error) throw new Error(explain(ensured.error.message));
  return submitWeek({ id: ensured.data, userId, periodStart: weekStart }, zone);
}

export async function approveWeek(id: string): Promise<void> {
  const { error } = await supabase.rpc("approve_timesheet", { p_id: id });
  if (error) throw new Error(explain(error.message));
}

export async function returnWeek(id: string, comment: string): Promise<void> {
  const { error } = await supabase.rpc("return_timesheet", { p_id: id, p_comment: comment });
  if (error) throw new Error(explain(error.message));
}

export async function reopenWeek(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc("reopen_timesheet", { p_id: id, p_reason: reason });
  if (error) throw new Error(explain(error.message));
}

export interface SegmentEdit {
  timesheetId: string;
  kind: "keep" | "exclude" | "include" | "project";
  startAt: string;
  endAt: string;
  /** For 'project': the new project; null is Unassigned. */
  projectId?: string | null;
  reason?: string;
}

export async function editSegment(e: SegmentEdit): Promise<void> {
  const { error } = await supabase.rpc("edit_segment", {
    p_timesheet_id: e.timesheetId,
    p_kind: e.kind,
    p_start_at: e.startAt,
    p_end_at: e.endAt,
    // Generated types don't mark function arguments nullable.
    p_project_id: (e.projectId ?? null) as string,
    p_reason: (e.reason ?? null) as string,
  });
  if (error) throw new Error(explain(error.message));
}

/** PRJ-04: the employee moves their own time to a project they're on (null: Unassigned). */
export async function reassignMyTime(r: {
  startAt: string;
  endAt: string;
  projectId: string | null;
  reason?: string;
}): Promise<void> {
  const { error } = await supabase.rpc("reassign_my_time", {
    p_start: r.startAt,
    p_end: r.endAt,
    // Generated types don't mark function arguments nullable.
    p_project_id: r.projectId as string,
    p_reason: (r.reason?.trim() || null) as string,
  });
  if (error) throw new Error(explain(error.message));
}

/** Adds time on the employee's behalf, or (with entryId) changes one of their entries. */
export async function adjustTime(
  timesheetId: string,
  r: ManualEntryRequest,
  entryId: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("adjust_time", {
    p_timesheet_id: timesheetId,
    p_start_at: r.start_at,
    p_end_at: r.end_at,
    p_project_id: r.project_id as string,
    p_reason: r.reason,
    p_entry_id: entryId as string,
  });
  if (error) throw new Error(explain(error.message));
}

const messages: Record<string, string> = {
  timesheet_not_found: "That timesheet isn't available to you.",
  user_not_found: "That person isn't available to you.",
  invalid_week: "That isn't a week of this org's calendar.",
  not_your_timesheet: "Only the employee submits their own week.",
  not_submittable: "This week has already been submitted.",
  week_in_future: "This week hasn't started yet.",
  no_manager: "You have no manager to approve this. Ask an admin to set one.",
  not_the_manager: "Only the direct manager or their delegate can do this.",
  not_submitted: "This week isn't waiting for approval.",
  not_approved: "Only an approved week can be reopened.",
  timesheet_locked: "This week is approved. Reopen it to make changes.",
  timesheet_submitted:
    "This week is with your manager. You can change projects again if they return it.",
  no_counted_time: "There's no counted time there to move.",
  pending_entries: "Decide on the manual entry requests first.",
  undecided_flagged: "Decide on every flagged segment first.",
  invalid_comment: "Add a comment of up to 500 characters.",
  invalid_reason: "Give a reason of up to 500 characters.",
  invalid_kind: "That edit isn't supported.",
  invalid_range: "The end must be after the start.",
  range_too_long: "An entry can be at most 24 hours.",
  in_the_future: "The time can't end in the future.",
  outside_week: "That time is outside this week.",
  not_flagged: "Only flagged time can be excluded.",
  already_excluded: "That time is excluded. Put it back with a reason.",
  no_segments: "There's no recorded time there to move.",
  project_not_allowed: "That project isn't available.",
  entry_not_found: "That manual entry no longer exists.",
  not_adjustable: "A rejected entry can't be changed.",
  overlaps_clocked_time: "That overlaps time the person was clocked in.",
  overlaps_manual_entry: "That overlaps another manual entry.",
  day_locked: "That day is in an approved timesheet.",
};

export function explain(code: string): string {
  return messages[code] ?? code;
}
