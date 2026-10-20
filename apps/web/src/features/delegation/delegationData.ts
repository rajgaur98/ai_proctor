// Delegation (#44, TS-14): a manager names a delegate approver for a date range, and
// ends it. The rules live in the database (set_delegation, end_delegation); the check
// here only spares a round trip and the messages explain its error codes.
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";

/** The most days one delegation may cover (the database refuses longer ones). */

export interface Delegation {
  id: string;
  managerId: string;
  managerName: string;
  delegateId: string;
  delegateName: string;
  startsOn: string;
  endsOn: string;
}

export interface Candidate {
  id: string;
  fullName: string;
  role: string;
}

/** The viewer's current and upcoming delegations, given and received. */
export const delegationsQuery = queryOptions({
  queryKey: ["delegations"],
  queryFn: async (): Promise<Delegation[]> => {
    const { data, error } = await supabase.rpc("my_delegations");
    if (error) throw error;
    return data.map((d) => ({
      id: d.id,
      managerId: d.manager_id,
      managerName: d.manager_name,
      delegateId: d.delegate_id,
      delegateName: d.delegate_name,
      startsOn: d.starts_on,
      endsOn: d.ends_on,
    }));
  },
});

/** The people the viewer may name as a delegate. */
export const candidatesQuery = queryOptions({
  queryKey: ["delegate-candidates"],
  queryFn: async (): Promise<Candidate[]> => {
    const { data, error } = await supabase.rpc("delegate_candidates");
    if (error) throw error;
    return data.map((c) => ({ id: c.id, fullName: c.full_name, role: c.role }));
  },
});

export async function setDelegation(delegateId: string, startsOn: string, endsOn: string) {
  const { error } = await supabase.rpc("set_delegation", {
    p_delegate_id: delegateId,
    p_starts_on: startsOn,
    p_ends_on: endsOn,
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
