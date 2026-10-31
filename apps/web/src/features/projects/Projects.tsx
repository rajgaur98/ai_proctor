// Projects (#38, PRJ-01..03): the project list, its client and billable flag, and
// who can log time to it. Admins and managers edit; everyone else reads names only.
// Each project's tasks (#254, PRJ-05) are added, renamed and archived from its row.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { membersQuery } from "../people/members";
import { ClientsDialog } from "./ClientsDialog";
import {
  clientsQuery,
  type Project,
  projectsQuery,
  saveProject,
  setMembers,
  tasksQuery,
} from "./projectData";
import { TasksDialog } from "./TasksDialog";

export function Projects() {
  const { profile } = useRouteContext({ from: "/_app" });
  const projects = useQuery(projectsQuery);
  const clients = useQuery(clientsQuery);
  const tasks = useQuery(tasksQuery);
  // null: closed, "new": blank form, else the project being edited.
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const [tasksOf, setTasksOf] = useState<Project | null>(null);
  const activeTasks = (projectId: string) =>
    (tasks.data ?? []).filter((t) => t.projectId === projectId && !t.archived).length;
  const [clientsOpen, setClientsOpen] = useState(false);

  const clientName = new Map((clients.data ?? []).map((c) => [c.id, c.name]));
  // Active projects first.
  const rows = [...(projects.data ?? [])].sort(
    (a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name),
  );
  const error = projects.error ?? clients.error;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">Projects</h1>
          <p className="mt-1 text-[13.5px] text-ink2">{profile.orgName}</p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={() => setClientsOpen(true)}>
            Clients
          </Button>
          <Button onClick={() => setEditing("new")}>New project</Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {error ? (
          <p role="alert" className="p-6 text-sm text-warnink">
            Couldn't load projects: {error.message}
          </p>
        ) : projects.isPending ? (
          <p className="p-6 text-sm text-ink2">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <span
              aria-hidden
              className="mb-1.5 h-10 w-10 rounded-full border-[1.5px] border-dashed border-line2"
            />
            <p className="text-base font-semibold">No projects yet</p>
            <p className="max-w-[380px] text-[13.5px] text-ink2">
              Add a project and choose who can log time to it.
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse text-[13.5px]">
            <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
              <tr className="h-10 border-b border-line">
                <th className="px-5 font-medium">Project</th>
                <th className="font-medium">Client</th>
                <th className="font-medium">Billable</th>
                <th className="font-medium">People</th>
                <th className="font-medium">Tasks</th>
                <th className="font-medium">Status</th>
                <th className="pr-5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.id}
                  className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:h-14 md:p-0"
                >
                  <td className="font-medium md:px-5">{p.name}</td>
                  <td className="text-ink2">{(p.clientId && clientName.get(p.clientId)) || "—"}</td>
                  <td>{p.billable ? "Yes" : "No"}</td>
                  <td className="text-ink2 tabular-nums">{p.memberIds.length}</td>
                  <td className="text-ink2 tabular-nums">{activeTasks(p.id)}</td>
                  <td className={p.archived ? "text-ink3" : ""}>
                    {p.archived ? "Archived" : "Active"}
                  </td>
                  <td className="flex gap-2 md:table-cell md:pr-5 md:text-right">
                    <Button
                      variant="secondary"
                      className="h-9 md:mr-2"
                      aria-label={`Tasks of ${p.name}`}
                      onClick={() => setTasksOf(p)}
                    >
                      Tasks
                    </Button>
                    <Button
                      variant="secondary"
                      className="h-9"
                      aria-label={`Edit ${p.name}`}
                      onClick={() => setEditing(p)}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="px-5 py-3 text-xs text-ink3">
          People are those you can see. Time without a project is shown as Unassigned.
        </p>
      </div>

      {clientsOpen && <ClientsDialog onClose={() => setClientsOpen(false)} />}
      {tasksOf && <TasksDialog project={tasksOf} onClose={() => setTasksOf(null)} />}
      {editing && (
        <ProjectDialog
          project={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

const select =
  "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink disabled:opacity-60";

function ProjectDialog({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const clients = useQuery(clientsQuery).data ?? [];
  const members = useQuery(membersQuery).data ?? [];
  const [name, setName] = useState(project?.name ?? "");
  const [clientId, setClientId] = useState(project?.clientId ?? "");
  const [billable, setBillable] = useState(project?.billable ?? true);
  const [archived, setArchived] = useState(project?.archived ?? false);
  const [picked, setPicked] = useState(() => new Set(project?.memberIds ?? []));
  // Set once the project row exists, so a retry after a failed people save doesn't
  // create it twice.
  const savedId = useRef<string | null>(project?.id ?? null);

  const save = useMutation({
    mutationFn: async () => {
      const ids = [...picked];
      if (savedId.current && !project) return setMembers(savedId.current, ids);
      const next = {
        id: project?.id ?? null,
        name,
        clientId: clientId || null,
        billable,
        archived,
      };
      savedId.current = await saveProject(next, ids);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey });
      onClose();
    },
    onError: () => queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey }),
  });

  // Active people, plus anyone already on the project who has since been deactivated.
  const people = members.filter((m) => m.active || picked.has(m.id));
  const choices = clients.filter((c) => !c.archived || c.id === project?.clientId);

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby={`${id}-title`}
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {project ? `Edit ${project.name}` : "New project"}
        </h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Project name</Label>
          <Input
            id={`${id}-name`}
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-client`}>Client</Label>
          <select
            id={`${id}-client`}
            className={select}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            <option value="">No client</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={billable}
            onChange={(e) => setBillable(e.target.checked)}
            className="h-4 w-4"
          />
          Billable
        </label>
        {project && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
              className="h-4 w-4"
            />
            Archived
          </label>
        )}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-[13px] font-medium text-ink2">People</legend>
          {people.length === 0 ? (
            <p className="text-sm text-ink2">No one to assign yet.</p>
          ) : (
            <div className="flex max-h-[200px] flex-col gap-2 overflow-y-auto rounded-[9px] border border-line2 p-3">
              {people.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.has(m.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(m.id);
                      else next.delete(m.id);
                      setPicked(next);
                    }}
                    className="h-4 w-4"
                  />
                  {m.fullName}
                  {m.active ? "" : " · deactivated"}
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-ink3">Only people you can see are listed.</p>
        </fieldset>
        {save.error && (
          <p role="alert" className="text-sm text-warnink">
            {save.error.message}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save project"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
