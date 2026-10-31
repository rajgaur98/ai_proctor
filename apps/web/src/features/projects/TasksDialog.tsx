// Add, rename and archive a project's tasks (#254, PRJ-05). A new task is billable when
// the project is; its flag can be changed per task. Tasks are archived, never deleted, so
// time already logged keeps its task.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { type Project, saveTask, type Task, tasksQuery } from "./projectData";

export function TasksDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const id = useId();
  const { data, error, isPending } = useQuery(tasksQuery);
  // Active tasks first, each group in the project's order.
  const tasks = (data ?? [])
    .filter((t) => t.projectId === project.id)
    .sort((a, b) => Number(a.archived) - Number(b.archived));

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
          <ul className="flex flex-col gap-3">
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </ul>
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

function TaskRow({ task }: { task: Task }) {
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
