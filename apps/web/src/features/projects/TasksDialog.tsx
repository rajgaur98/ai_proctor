// Add, rename and archive a project's tasks (#254, PRJ-05). A new task is billable when
// the project is; its flag can be changed per task. Tasks are archived, never deleted, so
// time already logged keeps its task. Owners and admins put the active tasks in order with
// Move up / Move down (#269); the pickers list them that way.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { type Project, reorderTasks, saveTask, type Task, tasksQuery } from "./projectData";
import { moveId, withOrder } from "./taskOrder";

type Direction = "up" | "down";

export function TasksDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const id = useId();
  const { profile } = useRouteContext({ from: "/_app" });
  const canReorder = profile.role === "owner" || profile.role === "admin";
  const { data, error, isPending } = useQuery(tasksQuery);
  // Active tasks first, each group in the project's order.
  const tasks = (data ?? [])
    .filter((t) => t.projectId === project.id)
    .sort((a, b) => Number(a.archived) - Number(b.archived));
  const active = tasks.filter((t) => !t.archived);
  const reorder = useReorder(project.id);
  // After a move, focus goes back to the moved task's button (or its other one at an end).
  const list = useRef<HTMLUListElement>(null);
  const [focusNext, setFocusNext] = useState<{ id: string; dir: Direction; at: number } | null>(
    null,
  );
  const [moved, setMoved] = useState("");
  const order = active.map((t) => t.id).join();

  // Once the list shows the move (moving a row can take focus off its button).
  useEffect(() => {
    if (!focusNext || order.split(",").indexOf(focusNext.id) !== focusNext.at) return;
    const button = (dir: Direction) =>
      list.current?.querySelector<HTMLButtonElement>(`[data-move="${focusNext.id}:${dir}"]`);
    const same = button(focusNext.dir);
    (same && !same.disabled ? same : button(focusNext.dir === "up" ? "down" : "up"))?.focus();
    setFocusNext(null);
  }, [focusNext, order]);

  const move = (task: Task, dir: Direction) => {
    const ids = moveId(
      active.map((t) => t.id),
      task.id,
      dir === "up" ? -1 : 1,
    );
    if (!ids) return;
    // The whole list goes to the database: the active tasks, then the archived ones.
    reorder.mutate([...ids, ...tasks.filter((t) => t.archived).map((t) => t.id)]);
    const at = ids.indexOf(task.id);
    setFocusNext({ id: task.id, dir, at });
    setMoved(`Moved ${task.name} ${dir}, to ${at + 1} of ${ids.length}.`);
  };

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby={`${id}-title`}
      className="m-auto w-[min(560px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id={`${id}-title`} className="text-lg font-semibold">
            Tasks for {project.name}
          </h2>
          <p className="text-[13px] text-ink2">
            People pick a task when they log or tag time on this project. Archived tasks stay on
            time already logged.
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-warnink">
            Couldn't load tasks: {error.message}
          </p>
        ) : isPending ? (
          <p className="text-sm text-ink2">Loading…</p>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-ink2">No tasks yet.</p>
        ) : (
          <ul ref={list} className="flex flex-col gap-3">
            {tasks.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                order={
                  canReorder && !t.archived
                    ? {
                        first: active[0]?.id === t.id,
                        last: active.at(-1)?.id === t.id,
                        onMove: (dir) => move(t, dir),
                      }
                    : undefined
                }
              />
            ))}
          </ul>
        )}
        <p aria-live="polite" className="sr-only">
          {moved}
        </p>
        {reorder.error && (
          <p role="alert" className="text-sm text-warnink">
            {reorder.error.message}
          </p>
        )}
        <AddTask project={project} />
        <div className="flex">
          <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </dialog>
  );
}

function useSaveTask(onDone?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveTask,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tasksQuery.queryKey });
      onDone?.();
    },
  });
}

/**
 * Saves a project's task order, showing it at once and putting it back if it fails. Moves
 * may follow each other before the first is saved: each sends the whole list as shown, and
 * the tasks are read again only once the last one is done.
 */
function useReorder(projectId: string) {
  const queryClient = useQueryClient();
  const mutationKey = ["reorder-tasks", projectId];
  return useMutation({
    mutationKey,
    mutationFn: (ids: string[]) => reorderTasks(projectId, ids),
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: tasksQuery.queryKey });
      const before = queryClient.getQueryData(tasksQuery.queryKey);
      if (before) {
        queryClient.setQueryData(tasksQuery.queryKey, withOrder(before, projectId, ids));
      }
      return { before };
    },
    onError: (_error, _ids, context) => {
      if (context?.before) queryClient.setQueryData(tasksQuery.queryKey, context.before);
    },
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey }) === 1) {
        return queryClient.invalidateQueries({ queryKey: tasksQuery.queryKey });
      }
    },
  });
}

interface RowOrder {
  first: boolean;
  last: boolean;
  onMove: (dir: Direction) => void;
}

function TaskRow({ task, order }: { task: Task; order?: RowOrder | undefined }) {
  const [name, setName] = useState(task.name);
  const save = useSaveTask();
  const base = { id: task.id, projectId: task.projectId, name: task.name, archived: task.archived };

  return (
    <li className="flex flex-col gap-1.5">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ ...base, name });
        }}
      >
        {order && (
          <div className="flex shrink-0 gap-1">
            {(["up", "down"] as const).map((dir) => (
              <Button
                key={dir}
                data-move={`${task.id}:${dir}`}
                type="button"
                variant="secondary"
                className="w-11 px-0"
                aria-label={`Move ${task.name} ${dir}`}
                disabled={dir === "up" ? order.first : order.last}
                onClick={() => order.onMove(dir)}
              >
                <span aria-hidden="true">{dir === "up" ? "↑" : "↓"}</span>
              </Button>
            ))}
          </div>
        )}
        <Input
          aria-label={`Name of ${task.name}`}
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1"
        />
        <label className="flex items-center gap-1.5 text-[13px]">
          <input
            type="checkbox"
            checked={task.billable}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ ...base, billable: e.target.checked })}
            className="h-4 w-4"
          />
          Billable
          <span className="sr-only"> for {task.name}</span>
        </label>
        <Button
          type="submit"
          variant="secondary"
          className="h-11 shrink-0"
          disabled={save.isPending || name.trim() === task.name}
        >
          Rename
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11 shrink-0"
          aria-label={`${task.archived ? "Restore" : "Archive"} ${task.name}`}
          disabled={save.isPending}
          onClick={() => save.mutate({ ...base, archived: !task.archived })}
        >
          {task.archived ? "Restore" : "Archive"}
        </Button>
      </form>
      {task.archived && <span className="text-xs text-ink3">Archived</span>}
      {save.error && (
        <p role="alert" className="text-sm text-warnink">
          {save.error.message}
        </p>
      )}
    </li>
  );
}

function AddTask({ project }: { project: Project }) {
  const [name, setName] = useState("");
  const save = useSaveTask(() => setName(""));

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ id: null, projectId: project.id, name, archived: false });
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          aria-label="New task name"
          placeholder="New task name"
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" className="shrink-0" disabled={save.isPending}>
          Add task
        </Button>
      </div>
      <p className="text-xs text-ink3">
        New tasks are {project.billable ? "billable" : "not billable"}, like the project.
      </p>
      {save.error && (
        <p role="alert" className="text-sm text-warnink">
          {save.error.message}
        </p>
      )}
    </form>
  );
}
