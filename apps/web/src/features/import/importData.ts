// Imports (#256): what already exists, for the preview, and the apply step. People go
// through the import-people Edge Function (it makes the Auth users and sends the invite
// emails after the import commits); every other kind calls import_apply directly. Both
// apply all or nothing; the database checks everything again. Time entries (#282) also
// need the file's people's entries, clocked time and approved weeks around its dates:
// importTimeContextQuery, once the file is read.
import type { ImportPayload, Json } from "@ai-proctor/contracts";
import { queryOptions } from "@tanstack/react-query";
import type { ImportContext, TimeContext, UserRole } from "../../lib/import";
import { supabase } from "../../lib/supabase";
import { ImportError, rowsOf } from "./importErrors";

/** Everything the preview compares against, minus the importer and the defaults. */
export type ImportData = Omit<ImportContext, "me" | "defaults" | "time"> & {
  /** Ids, for the defaults: the importer's own row. */
  byId: Map<string, ImportContext["people"][number]>;
};

export const importContextQuery = queryOptions({
  queryKey: ["import-context"],
  queryFn: async (): Promise<ImportData> => {
    const [users, teams, clients, projects, members, shifts, tasks] = await Promise.all([
      supabase
        .from("users")
        .select(
          "id, email, full_name, role, manager_id, team_id, work_country, work_state, timezone, active",
        ),
      supabase.from("teams").select("id, name"),
      supabase.from("clients").select("id, name, archived"),
      supabase.from("projects").select("id, name, client_id, billable, archived"),
      supabase.from("project_members").select("project_id, user_id"),
      supabase.from("shifts").select("user_id, days, start_time, end_time, timezone"),
      supabase.from("project_tasks").select("project_id, name, archived"),
    ]);
    for (const r of [users, teams, clients, projects, members, shifts, tasks]) {
      if (r.error) throw r.error;
    }
    const emailOf = new Map((users.data ?? []).map((u) => [u.id, u.email.toLowerCase()]));
    const teamOf = new Map((teams.data ?? []).map((t) => [t.id, t.name]));
    const clientOf = new Map((clients.data ?? []).map((c) => [c.id, c.name]));
    const projectOf = new Map((projects.data ?? []).map((p) => [p.id, p]));
    const people = (users.data ?? []).map((u) => ({
      id: u.id,
      person: {
        email: u.email.toLowerCase(),
        full_name: u.full_name,
        role: u.role as UserRole,
        manager_email: u.manager_id ? (emailOf.get(u.manager_id) ?? null) : null,
        team: u.team_id ? (teamOf.get(u.team_id) ?? null) : null,
        work_country: u.work_country,
        work_state: u.work_state,
        timezone: u.timezone,
        active: u.active,
      },
    }));
    return {
      byId: new Map(people.map((p) => [p.id, p.person])),
      people: people.map((p) => p.person),
      teams: (teams.data ?? []).map((t) => ({ name: t.name })),
      clients: (clients.data ?? []).map((c) => ({ name: c.name, archived: c.archived })),
      projects: (projects.data ?? []).map((p) => ({
        name: p.name,
        client: p.client_id ? (clientOf.get(p.client_id) ?? null) : null,
        billable: p.billable,
        archived: p.archived,
        members: (members.data ?? [])
          .filter((m) => m.project_id === p.id)
          .flatMap((m) => emailOf.get(m.user_id) ?? []),
      })),
      shifts: (shifts.data ?? []).flatMap((s) => {
        const email = emailOf.get(s.user_id);
        return email
          ? [
              {
                email,
                days: s.days,
                start: s.start_time.slice(0, 5),
                end: s.end_time.slice(0, 5),
                timezone: s.timezone,
              },
            ]
          : [];
      }),
      tasks: (tasks.data ?? []).flatMap((t) => {
        const p = projectOf.get(t.project_id);
        return p
          ? [
              {
                project: p.name,
                client: p.client_id ? (clientOf.get(p.client_id) ?? null) : null,
                name: t.name,
                archived: t.archived,
              },
            ]
          : [];
      }),
    };
  },
});

/** A time-entry file's people and dates (timeEntriesScope). */
export interface TimeScope {
  emails: string[];
  from: string;
  to: string;
}

export const importTimeContextQuery = (scope: TimeScope) =>
  queryOptions({
    queryKey: ["import-time-context", scope],
    queryFn: async (): Promise<TimeContext> => {
      const { data, error } = await supabase.rpc("import_time_entries_context", {
        p_emails: scope.emails,
        p_from: scope.from,
        p_to: scope.to,
      });
      if (error) throw error;
      return data as unknown as TimeContext;
    },
  });

export interface ApplyResult {
  created: number;
  updated: number;
  /** People imports: one per new person, whether their invite email went out. */
  invites: { email: string; ok: boolean; error?: string }[];
}

export async function applyImport(payload: ImportPayload): Promise<ApplyResult> {
  if (payload.kind !== "people") {
    const { data, error } = await supabase.rpc("import_apply", {
      p_payload: payload as unknown as Json,
    });
    if (error) throw new ImportError(error.message, rowsOf(error.details));
    const r = data as { created: number; updated: number };
    return { created: r.created, updated: r.updated, invites: [] };
  }
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new ImportError("not_signed_in", []);
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/import-people`, {
    method: "POST",
    headers: {
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ payload }),
  });
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    detail?: string;
    result?: { created: number; updated: number };
    invites?: ApplyResult["invites"];
  } | null;
  if (!res.ok || !body?.result) {
    throw new ImportError(body?.error ?? "import_failed", rowsOf(body?.detail));
  }
  return { ...body.result, invites: body.invites ?? [] };
}
