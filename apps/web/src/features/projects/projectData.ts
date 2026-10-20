import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";

export interface Client {
  id: string;
  name: string;
  archived: boolean;
}

export interface Project {
  id: string;
  name: string;
  clientId: string | null;
  billable: boolean;
  archived: boolean;
  /** Assigned people the viewer can see. */
  memberIds: string[];
}

export const clientsQuery = queryOptions({
  queryKey: ["clients"],
  queryFn: async (): Promise<Client[]> => {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, archived")
      .order("name");
    if (error) throw error;
    return data;
  },
});

export const projectsQuery = queryOptions({
  queryKey: ["projects"],
  queryFn: async (): Promise<Project[]> => {
    const [projects, members] = await Promise.all([
      supabase.from("projects").select("id, name, client_id, billable, archived").order("name"),
      supabase.from("project_members").select("project_id, user_id"),
    ]);
    if (projects.error) throw projects.error;
    if (members.error) throw members.error;
    return projects.data.map((p) => ({
      id: p.id,
      name: p.name,
      clientId: p.client_id,
      billable: p.billable,
      archived: p.archived,
      memberIds: members.data.filter((m) => m.project_id === p.id).map((m) => m.user_id),
    }));
  },
});

export async function saveClient(id: string | null, name: string, archived: boolean) {
  // Generated types don't mark function arguments nullable; a new client has no id.
  const { error } = await supabase.rpc("save_client", {
    p_id: id as string,
    p_name: name,
    p_archived: archived,
  });
  if (error) throw new Error(explain(error.message));
}

/** Creates or updates the project, then sets who can log to it. Returns its id. */
export async function saveProject(
  p: Omit<Project, "id" | "memberIds"> & { id: string | null },
  memberIds: string[],
): Promise<string> {
  const { data, error } = await supabase.rpc("save_project", {
    p_id: p.id as string,
    p_name: p.name,
    p_client_id: p.clientId as string,
    p_billable: p.billable,
    p_archived: p.archived,
  });
  if (error) throw new Error(explain(error.message));
  await setMembers(data, memberIds);
  return data;
}

export async function setMembers(projectId: string, memberIds: string[]) {
  const { error } = await supabase.rpc("set_project_members", {
    p_project_id: projectId,
    p_user_ids: memberIds,
  });
  if (error) throw new Error(explain(error.message));
}

const messages: Record<string, string> = {
  manager_or_admin_only: "Only managers and admins can do this.",
  name_taken: "That name is already used. Choose another.",
  invalid_name: "Enter a name of up to 120 characters.",
  user_not_visible: "You can only assign people you can see.",
  project_not_found: "That project no longer exists.",
  client_not_found: "That client no longer exists.",
};

export function explain(code: string): string {
  return messages[code] ?? code;
}
