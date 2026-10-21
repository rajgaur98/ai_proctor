// Teams (#66, ORG-08, ADM-02): reads the teams row-level security lets the viewer see
// (admins all of the org's; others the teams of people they can see) and calls the
// admin-only functions that change them. The database validates, audit-logs and bumps
// the members' config; this only fetches, maps and explains its errors.
import { SetTeamPolicyReply, type TeamPolicy, TeamPolicyKeys } from "@ai-proctor/contracts";
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";

export interface Team {
  id: string;
  name: string;
  /** The team's overrides; a key that isn't here follows the org's policy. */
  policy: TeamPolicy;
}

export const teamsQuery = queryOptions({
  queryKey: ["teams"],
  queryFn: async (): Promise<Team[]> => {
    const { data, error } = await supabase.from("teams").select("id, name, policy").order("name");
    if (error) throw error;
    return data.map((t) => ({
      id: t.id,
      name: t.name,
      // Stored by set_team_policy, so it parses; anything else shows as no overrides.
      policy: TeamPolicyKeys.catch({}).parse(t.policy),
    }));
  },
});

/** Creates (null id) or renames a team; returns its id. */
export async function saveTeam(id: string | null, name: string): Promise<string> {
  // Generated types don't mark function arguments nullable; a new team has no id.
  const { data, error } = await supabase.rpc("save_team", {
    p_team_id: id as string,
    p_name: name,
  });
  if (error) throw new Error(explain(error.message, error.details));
  return data;
}

/** The team's members become exactly `userIds`; people named here leave their old team. */
export async function setTeamMembers(id: string, userIds: string[]) {
  const { error } = await supabase.rpc("set_team_members", {
    p_team_id: id,
    p_user_ids: userIds,
  });
  if (error) throw new Error(explain(error.message, error.details));
}

/** The team's overrides become exactly `policy` ({} follows the org's policy everywhere). */
export async function setTeamPolicy(id: string, policy: TeamPolicy): Promise<SetTeamPolicyReply> {
  const { data, error } = await supabase.rpc("set_team_policy", {
    p_team_id: id,
    p_policy: policy,
  });
  if (error) throw new Error(explain(error.message, error.details));
  return SetTeamPolicyReply.parse(data);
}

export async function deleteTeam(id: string) {
  const { error } = await supabase.rpc("delete_team", { p_team_id: id });
  if (error) throw new Error(explain(error.message, error.details));
}

const messages: Record<string, string> = {
  admin_only: "Only owners and admins can change teams.",
  team_not_found: "That team no longer exists.",
  user_not_found: "Someone you picked is no longer in the organisation.",
  name_taken: "Another team already has that name.",
  invalid_name: "Enter a team name (up to 80 characters).",
  mfa_required: "Verify two-factor authentication to change a team's policy.",
};

/** `details` is the key the database refused, when it names one. */
export function explain(code: string, details?: string | null): string {
  if (
    code === "invalid_policy" ||
    code === "unknown_policy_key" ||
    code === "not_team_policy_key"
  ) {
    return `The server refused ${details ?? "the overrides"}.`;
  }
  return messages[code] ?? code;
}
