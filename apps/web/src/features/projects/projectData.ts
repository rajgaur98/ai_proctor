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

/** A task under a project (#254, PRJ-05). */
export interface Task {
  id: string;
  projectId: string;
  name: string;
  billable: boolean;
  archived: boolean;
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

/** Every task in the org, in each project's order. */
export const tasksQuery = queryOptions({
  queryKey: ["project-tasks"],
  queryFn: async (): Promise<Task[]> => {
    const { data, error } = await supabase
      .from("project_tasks")
      .select("id, project_id, name, billable, archived")
      .order("sort_order")
      .order("name");
    if (error) throw error;
    return data.map((t) => ({
      id: t.id,
      projectId: t.project_id,
      name: t.name,
      billable: t.billable,
      archived: t.archived,
    }));
  },
});

/**
 * The tasks someone may pick for time on `projectId`: its active ones, plus `keep` (the
 * task the time already has, even if archived since).
 */
export function tasksFor(tasks: Task[], projectId: string | null, keep?: string | null): Task[] {
  if (!projectId) return [];
  return tasks.filter((t) => t.projectId === projectId && (!t.archived || t.id === keep));
}

/** "Website revamp › Design", or just the project when there's no task. */
export function assignmentLabel(project: string, taskName: string | null | undefined): string {
  return taskName ? `${project} › ${taskName}` : project;
}

/** Creates (null id) or updates a task. A new task's billable flag defaults to the project's. */
export async function saveTask(t: {
  id: string | null;
  projectId: string;
  name: string;
  billable?: boolean;
  archived: boolean;
}): Promise<string> {
  const { data, error } = await supabase.rpc("save_task", {
    // Generated types don't mark function arguments nullable; a new task has no id.
    p_id: t.id as string,
    p_project_id: t.projectId,
    p_name: t.name,
    p_archived: t.archived,
    // Left out: the project's flag (new) or the task's current one (update).
    ...(t.billable === undefined ? {} : { p_billable: t.billable }),
  });
  if (error) throw new Error(explain(error.message));
  return data;
}

/** Puts a project's tasks in the order of `taskIds`: all of them, archived ones too (#269). */
export async function reorderTasks(projectId: string, taskIds: string[]) {
  const { error } = await supabase.rpc("reorder_tasks", {
    p_project_id: projectId,
    p_task_ids: taskIds,
  });
  if (error) throw new Error(explain(error.message));
}

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
  task_not_found: "That task no longer exists.",
  admin_only: "Only owners and admins can change the order of tasks.",
  task_list_changed: "The tasks changed while you were ordering them. Try again.",
};

export function explain(code: string): string {
  return messages[code] ?? code;
}
