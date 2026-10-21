import type { Enums, Invite, InviteResult } from "@ai-proctor/contracts";
import { InviteReply } from "@ai-proctor/contracts";
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";

export interface Member {
  id: string;
  fullName: string;
  email: string;
  role: Enums<"user_role">;
  managerId: string | null;
  country: string;
  state: string | null;
  timezone: string;
  active: boolean;
  /** TS-16: false means their week is approved as soon as they submit it. */
  approvalRequired: boolean;
  /** ORG-08: their team, if any (set on the Teams page). */
  teamId: string | null;
}

export const membersQuery = queryOptions({
  queryKey: ["members"],
  queryFn: async (): Promise<Member[]> => {
    const { data, error } = await supabase
      .from("users")
      .select(
        "id, full_name, email, role, manager_id, work_country, work_state, timezone, active, approval_required, team_id",
      )
      .order("full_name");
    if (error) throw error;
    return data.map((u) => ({
      id: u.id,
      fullName: u.full_name,
      email: u.email,
      role: u.role,
      managerId: u.manager_id,
      country: u.work_country,
      state: u.work_state,
      timezone: u.timezone,
      active: u.active,
      approvalRequired: u.approval_required,
      teamId: u.team_id,
    }));
  },
});

/** People who can be someone's direct manager (ORG-05). */
export function managersOf(members: Member[]): Member[] {
  return members.filter((m) => m.active && m.role !== "employee");
}

export async function updateMember(m: Member) {
  // Generated types don't mark function arguments nullable; these two may be null.
  const { error } = await supabase.rpc("update_member", {
    p_user_id: m.id,
    p_full_name: m.fullName,
    p_role: m.role,
    p_manager_id: (m.role === "owner" ? null : m.managerId) as string,
    p_work_country: m.country,
    p_work_state: (m.country === "US" ? m.state : null) as string,
    p_timezone: m.timezone,
  });
  if (error) throw new Error(explain(error.message));
}

/** TS-16: audit-logged by the database. */
export async function setApprovalRequired(id: string, required: boolean) {
  const { error } = await supabase.rpc("set_approval_required", {
    p_user_id: id,
    p_required: required,
  });
  if (error) throw new Error(explain(error.message));
}

export async function setActive(id: string, active: boolean) {
  const { error } = await supabase.rpc("set_user_active", { p_user_id: id, p_active: active });
  if (error) throw new Error(explain(error.message));
}

export async function sendInvites(invites: Invite[]): Promise<InviteResult[]> {
  const { data, error } = await supabase.functions.invoke("invite-users", { body: { invites } });
  if (error) throw new Error(explain(error.message));
  return InviteReply.parse(data).results.map((r) =>
    r.error ? { ...r, error: explain(r.error) } : r,
  );
}

const messages: Record<string, string> = {
  admin_only: "Only owners and admins can do this.",
  owner_only: "Only the owner can change the owner.",
  already_a_member: "Already in an organisation.",
  email_exists: "Already has an account.",
  manager_required: "Choose a direct manager.",
  manager_not_found: "That manager isn't an active member.",
  manager_must_be_manager_or_admin: "The manager must be a manager, admin or owner.",
  cannot_manage_self: "Nobody can be their own manager.",
  reporting_loop: "That would make a reporting loop.",
  has_reports: "Move this person's reports to another manager first.",
  cannot_change_own_role: "You can't change your own role.",
  cannot_change_owner: "Ownership can't be changed here.",
  cannot_change_self: "You can't deactivate yourself.",
  us_state_required: "Choose a state for the US.",
  state_only_for_us: "Only the US has a state.",
  invalid_timezone: "Choose a time zone.",
  invalid_country: "Use a two-letter country code.",
  invalid_name: "Enter a name.",
  invalid_shifts: "Each shift needs at least one day and different start and end times.",
  manager_or_admin_only: "Only their manager or an admin can change this.",
  invalid_approval: "Choose whether approval is required.",
};

export function explain(code: string): string {
  return messages[code] ?? code;
}
