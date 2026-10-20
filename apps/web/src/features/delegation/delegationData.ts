// Delegation (#44, TS-14): a manager names a delegate approver for a date range, and
// ends it; owners and admins do the same for any manager, and anyone reads their history
// (#147). The rules live in the database (set_delegation, end_delegation); the check
// here only spares a round trip and the messages explain its error codes.
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";

export type DelegationStatus = "upcoming" | "active" | "completed" | "ended";

export interface Delegation {
  id: string;
  managerId: string;
  managerName: string;
  delegateId: string;
  delegateName: string;
  startsOn: string;
  endsOn: string;
  /** Judged on the manager's local today; "ended" means ended early. */
  status: DelegationStatus;
  endedAt: string | null;
  /** Why it ended early; null for one ended by hand before this was recorded. */
  endReason: "manual" | "deactivated" | "demoted" | null;
}

export interface Candidate {
  id: string;
  fullName: string;
  role: string;
}

/**
 * The delegations a person is part of (the viewer when `personId` is omitted; any member for
 * an owner or admin): upcoming, current, completed and ended early, given and received.
 */
export const delegationsQuery = (personId?: string) =>
  queryOptions({
    queryKey: ["delegations", personId ?? "me"],
    queryFn: async (): Promise<Delegation[]> => {
      const { data, error } = await supabase.rpc(
        "delegation_history",
        personId ? { p_manager_id: personId } : {},
      );
      if (error) throw new Error(explain(error.message));
      return data.map((d) => ({
        id: d.id,
        managerId: d.manager_id,
        managerName: d.manager_name,
        delegateId: d.delegate_id,
        delegateName: d.delegate_name,
        startsOn: d.starts_on,
        endsOn: d.ends_on,
        status: d.status as DelegationStatus,
        endedAt: d.ended_at,
        endReason: d.end_reason as Delegation["endReason"],
      }));
    },
  });

/** The people the viewer may name as a delegate for `managerId` (the viewer when omitted). */
export const candidatesQuery = (managerId?: string) =>
  queryOptions({
    queryKey: ["delegate-candidates", managerId ?? "me"],
    queryFn: async (): Promise<Candidate[]> => {
      const { data, error } = await supabase.rpc(
        "delegate_candidates",
        managerId ? { p_manager_id: managerId } : {},
      );
      if (error) throw error;
      return data.map((c) => ({ id: c.id, fullName: c.full_name, role: c.role }));
    },
  });

/** For `managerId` (owners and admins only), else for the viewer. */
export async function setDelegation(
  delegateId: string,
  startsOn: string,
  endsOn: string,
  managerId?: string,
) {
  const { error } = await supabase.rpc("set_delegation", {
    p_delegate_id: delegateId,
    p_starts_on: startsOn,
    p_ends_on: endsOn,
    ...(managerId ? { p_manager_id: managerId } : {}),
  });
  if (error) throw new Error(explain(error.message));
}

export async function endDelegation(id: string) {
  const { error } = await supabase.rpc("end_delegation", { p_id: id });
  if (error) throw new Error(explain(error.message));
}

const messages: Record<string, string> = {
  not_a_manager: "Only managers, admins and owners can delegate.",
  manager_not_found: "That manager isn't available to you.",
  not_allowed: "Only the manager, an admin or the owner can do this.",
  delegate_not_found: "That person can't be a delegate.",
  cannot_delegate_to_self: "Choose someone other than yourself.",
  delegate_must_be_manager: "A delegate must be a manager, admin or owner.",
  invalid_range: "Check the dates: from today, at most 90 days.",
  delegation_overlaps: "You already have a delegation in those dates. End it first.",
  delegation_not_found: "That delegation no longer exists.",
  delegation_not_active: "That delegation is already over.",
};

export function explain(code: string): string {
  return messages[code] ?? code;
}
