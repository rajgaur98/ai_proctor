// Time off (#304, LV-01..03): leave types and holidays (everyone in the org reads them;
// owners and admins change them), and requests through leave_requests_list, which says
// for each row whether the viewer may decide or cancel it. The rules, audit log and
// notifications live in the database; this fetches, maps and explains its errors.
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { explain, type LeaveSpan } from "./leaveText";

export interface LeaveType {
  id: string;
  name: string;
  paid: boolean;
  archived: boolean;
}

export interface Holiday {
  id: string;
  day: string;
  name: string;
  country: string | null;
  state: string | null;
}

export interface LeaveRequest extends LeaveSpan {
  id: string;
  userId: string;
  employeeName: string;
  typeId: string;
  typeName: string;
  paid: boolean;
  note: string | null;
  status: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  canDecide: boolean;
  canCancel: boolean;
}

export const leaveTypesQuery = queryOptions({
  queryKey: ["leave-types"],
  queryFn: async (): Promise<LeaveType[]> => {
    const { data, error } = await supabase
      .from("leave_types")
      .select("id, name, paid, archived")
      .order("name");
    if (error) throw error;
    return data;
  },
});

export const holidaysQuery = queryOptions({
  queryKey: ["holidays"],
  queryFn: async (): Promise<Holiday[]> => {
    const { data, error } = await supabase
      .from("holidays")
      .select("id, day, name, country, state")
      .order("day")
      .order("country", { nullsFirst: true })
      .order("state", { nullsFirst: true });
    if (error) throw error;
    return data;
  },
});

/** Requests overlapping `from`..`to` (open ends when omitted) the viewer may see. */
export const leaveRequestsQuery = (from?: string, to?: string) =>
  queryOptions({
    queryKey: ["leave-requests", from ?? "", to ?? ""],
    queryFn: async (): Promise<LeaveRequest[]> => {
      const { data, error } = await supabase.rpc("leave_requests_list", {
        ...(from ? { p_from: from } : {}),
        ...(to ? { p_to: to } : {}),
      });
      if (error) throw new Error(explain(error.message));
      return data.map((r) => ({
        id: r.id,
        userId: r.user_id,
        employeeName: r.employee_name,
        typeId: r.leave_type_id,
        typeName: r.type_name,
        paid: r.paid,
        kind: r.kind,
        firstDay: r.first_day,
        lastDay: r.last_day,
        startAt: r.start_at,
        endAt: r.end_at,
        timezone: r.timezone,
        note: r.note,
        status: r.status,
        decidedByName: r.decided_by_name,
        decidedAt: r.decided_at,
        decisionNote: r.decision_note,
        createdAt: r.created_at,
        canDecide: r.can_decide,
        canCancel: r.can_cancel,
      }));
    },
  });

export interface NewRequest {
  typeId: string;
  firstDay: string;
  /** Whole days: the last day (both included). */
  lastDay: string;
  /** A part day: "HH:mm" start and end on firstDay. */
  partDay: { start: string; end: string } | null;
  note: string;
}

export async function requestLeave(r: NewRequest): Promise<string> {
  // Generated types don't mark optional function arguments nullable.
  const { data, error } = await supabase.rpc("request_leave", {
    p_leave_type_id: r.typeId,
    p_first_day: r.firstDay,
    ...(r.partDay
      ? { p_start_time: r.partDay.start, p_end_time: r.partDay.end }
      : { p_last_day: r.lastDay }),
    ...(r.note.trim() ? { p_note: r.note.trim() } : {}),
  });
  if (error) throw new Error(explain(error.message));
  return data;
}

export async function decideLeave(id: string, approve: boolean, note: string): Promise<void> {
  const { error } = await supabase.rpc("decide_leave", {
    p_request_id: id,
    p_approve: approve,
    ...(note.trim() ? { p_note: note.trim() } : {}),
  });
  if (error) throw new Error(explain(error.message));
}

export async function cancelLeave(id: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_leave", { p_request_id: id });
  if (error) throw new Error(explain(error.message));
}

/** Creates (null id) or changes a leave type; returns its id. Owners and admins. */
export async function saveLeaveType(t: Omit<LeaveType, "id"> & { id: string | null }) {
  const { data, error } = await supabase.rpc("save_leave_type", {
    p_id: t.id as string,
    p_name: t.name,
    p_paid: t.paid,
    p_archived: t.archived,
  });
  if (error) throw new Error(explain(error.message));
  return data;
}

/** Adds (null id) or changes a holiday; returns its id. Owners and admins. */
export async function saveHoliday(h: Omit<Holiday, "id"> & { id: string | null }) {
  const { data, error } = await supabase.rpc("save_holiday", {
    p_id: h.id as string,
    p_day: h.day,
    p_name: h.name,
    ...(h.country ? { p_country: h.country } : {}),
    ...(h.country && h.state ? { p_state: h.state } : {}),
  });
  if (error) throw new Error(explain(error.message));
  return data;
}

export async function deleteHoliday(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_holiday", { p_id: id });
  if (error) throw new Error(explain(error.message));
}
