// The task picker that goes with a project picker (#254, PRJ-05): the project's active
// tasks, plus the one the time already has. Hidden while the project has none to offer.
import { Label } from "../../components/ui/label";
import { type Task, tasksFor } from "./projectData";

export function TaskSelect({
  id,
  tasks,
  projectId,
  value,
  keep,
  onChange,
  className,
}: {
  id: string;
  tasks: Task[];
  projectId: string | null;
  /** The chosen task id; "" is no task. */
  value: string;
  /** The task the time already has, offered even if archived. */
  keep?: string | null | undefined;
  onChange: (taskId: string) => void;
  className: string;
}) {
  const options = tasksFor(tasks, projectId, keep);
  if (options.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Task</Label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className}
      >
        <option value="">No task</option>
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {t.archived ? " (archived)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
