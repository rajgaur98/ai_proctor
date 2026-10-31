// Dialogs of the timesheet page (#43): a note (return comment, reopen reason), a
// project change, and added or adjusted time; and (#139) the employee's own project
// change on a draft week. Each validates with Zod before it calls the database, which
// checks the rules again. #254: project pickers come with the project's tasks (PRJ-05),
// and the employee writes work notes for a day and for an entry (TS-24, TS-25).
import { ManualEntryRequest, WorkNote } from "@ai-proctor/contracts";
import { useMutation } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Time } from "../../lib/time";
import type { ManualEntry } from "../day/entryData";
import type { Project, Task } from "../projects/projectData";
import { TaskSelect } from "../projects/TaskSelect";
import { daySpan } from "./reassign";
import { dayLabel } from "./weeks";

const dialogClass =
  "m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30";
const fieldClass = "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink";

type Ref = React.RefObject<HTMLDialogElement | null>;

/** What a Zod string schema from the contracts package offers; the web app doesn't import Zod. */
export interface TextSchema {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: string }
    | { success: false; error: { issues: { message: string }[] } };
}

function Actions({
  dialogRef,
  busy,
  label,
  onClose,
}: {
  dialogRef: Ref;
  busy: boolean;
  label: string;
  onClose: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Button
        type="button"
        variant="secondary"
        className="ml-auto"
        onClick={() => {
          onClose();
          dialogRef.current?.close();
        }}
      >
        Cancel
      </Button>
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : label}
      </Button>
    </div>
  );
}

/** One required note: the comment that returns a week, or the reason it's reopened. */
export function NoteDialog({
  dialogRef,
  id,
  title,
  description,
  label,
  submitLabel,
  schema,
  onSubmit,
}: {
  dialogRef: Ref;
  id: string;
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  schema: TextSchema;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: onSubmit,
    onSuccess: () => {
      setText("");
      dialogRef.current?.close();
    },
  });
  const reset = () => {
    setProblem(null);
    send.reset();
  };

  return (
    <dialog ref={dialogRef} aria-labelledby={`${id}-title`} className={dialogClass}>
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setProblem(null);
          const parsed = schema.safeParse(text);
          if (!parsed.success) {
            setProblem(parsed.error.issues[0]?.message ?? "Check the text.");
            return;
          }
          send.mutate(parsed.data);
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-[13px] text-ink2">{description}</p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-text`}>{label}</Label>
          <textarea
            id={`${id}-text`}
            rows={4}
            maxLength={500}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="rounded-[9px] border border-line2 bg-panel p-3 text-sm text-ink"
          />
        </div>
        {(problem || send.error) && (
          <p role="alert" className="text-sm text-warnink">
            {problem ?? send.error?.message}
          </p>
        )}
        <Actions dialogRef={dialogRef} busy={send.isPending} label={submitLabel} onClose={reset} />
      </form>
    </dialog>
  );
}

/**
 * Moves a flagged segment's time to another project, with a reason (TS-13). The page
 * sets `target` and opens the dialog, and clears `target` from `onClose`. The dialog
 * isn't keyed on the target: a key change would swap the element that was just opened
 * for a closed one, so the form is reset here when the target changes instead.
 */
export function ProjectDialog({
  dialogRef,
  projects,
  tasks,
  target,
  schema,
  onSubmit,
  onClose,
}: {
  dialogRef: Ref;
  projects: Project[];
  tasks: Task[];
  target: { projectId: string | null } | null;
  schema: TextSchema;
  onSubmit: (projectId: string | null, taskId: string | null, reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [projectId, setProjectId] = useState(target?.projectId ?? "");
  const [taskId, setTaskId] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(target);
  if (shown !== target) {
    setShown(target);
    setProjectId(target?.projectId ?? "");
    setTaskId("");
    setReason("");
    setProblem(null);
  }
  const send = useMutation({
    mutationFn: (v: { projectId: string | null; taskId: string | null; reason: string }) =>
      onSubmit(v.projectId, v.taskId, v.reason),
    onSuccess: () => {
      setReason("");
      dialogRef.current?.close();
    },
  });

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="project-edit-title"
      className={dialogClass}
      onClose={() => {
        send.reset();
        onClose();
      }}
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setProblem(null);
          const parsed = schema.safeParse(reason);
          if (!parsed.success) {
            setProblem(parsed.error.issues[0]?.message ?? "Check the reason.");
            return;
          }
          send.mutate({
            projectId: projectId || null,
            taskId: (projectId && taskId) || null,
            reason: parsed.data,
          });
        }}
      >
        <h2 id="project-edit-title" className="text-lg font-semibold">
          Change project
        </h2>
        <p className="text-[13px] text-ink2">
          Moves this time to another project. The employee sees the change and your reason.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-edit-project">Project</Label>
          <select
            id="project-edit-project"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setTaskId("");
            }}
            className={fieldClass}
          >
            <option value="">Unassigned</option>
            {projects
              .filter((p) => !p.archived)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </div>
        <TaskSelect
          id="project-edit-task"
          tasks={tasks}
          projectId={projectId || null}
          value={taskId}
          onChange={setTaskId}
          className={fieldClass}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-edit-reason">Reason</Label>
          <textarea
            id="project-edit-reason"
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="rounded-[9px] border border-line2 bg-panel p-3 text-sm text-ink"
          />
        </div>
        {(problem || send.error) && (
          <p role="alert" className="text-sm text-warnink">
            {problem ?? send.error?.message}
          </p>
        )}
        <Actions
          dialogRef={dialogRef}
          busy={send.isPending}
          label="Change project"
          onClose={() => {
            setProblem(null);
            send.reset();
          }}
        />
      </form>
    </dialog>
  );
}

export interface AdjustTarget {
  /** Null adds new time; else the manual entry being changed. */
  entryId: string | null;
  start: string;
  end: string;
  projectId: string | null;
  /** The entry's task (#254); null is none. */
  taskId: string | null;
}

/**
 * Adds time on the employee's behalf, or changes a manual entry's times (TS-13). The
 * page sets `target` and opens the dialog, and clears `target` from `onClose`. Like
 * ProjectDialog it isn't keyed on the target: the form is reset when the target changes.
 */
export function AdjustDialog({
  dialogRef,
  zone,
  days,
  target,
  projects,
  tasks,
  schema,
  onSubmit,
  onClose,
}: {
  dialogRef: Ref;
  zone: string;
  /** The week's days (employee-local). */
  days: string[];
  target: AdjustTarget | null;
  projects: Project[];
  tasks: Task[];
  schema: TextSchema;
  onSubmit: (r: ManualEntryRequest, entryId: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const formFor = (t: AdjustTarget | null) => {
    const first = t ? DateTime.fromISO(t.start, { zone }) : null;
    const last = t ? DateTime.fromISO(t.end, { zone }) : null;
    return {
      day: first?.toISODate() ?? days[0] ?? "",
      start: first?.toFormat("HH:mm") ?? "",
      end: last?.toFormat("HH:mm") ?? "",
      projectId: t?.projectId ?? "",
      taskId: t?.taskId ?? "",
      reason: "",
    };
  };
  const [form, setForm] = useState(() => formFor(target));
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(target);
  if (shown !== target) {
    setShown(target);
    setForm(formFor(target));
    setProblem(null);
  }
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const send = useMutation({
    mutationFn: (r: ManualEntryRequest) => onSubmit(r, target?.entryId ?? null),
    onSuccess: () => {
      set({ reason: "" });
      dialogRef.current?.close();
    },
  });
  const adjusting = target?.entryId != null;

  function submit() {
    setProblem(null);
    const at = (time: string) => DateTime.fromISO(`${form.day}T${time}`, { zone });
    const start = at(form.start);
    const end = at(form.end);
    if (!start.isValid || !end.isValid) {
      setProblem("Choose a day, a start and an end.");
      return;
    }
    if (end > DateTime.now()) {
      setProblem("The time can't end in the future.");
      return;
    }
    const reason = schema.safeParse(form.reason);
    if (!reason.success) {
      setProblem(reason.error.issues[0]?.message ?? "Give a reason.");
      return;
    }
    const parsed = ManualEntryRequest.safeParse({
      start_at: start.toISO(),
      end_at: end.toISO(),
      project_id: form.projectId || null,
      task_id: (form.projectId && form.taskId) || null,
      reason: reason.data,
    });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? "Check the fields.");
      return;
    }
    send.mutate(parsed.data);
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="adjust-title"
      className={dialogClass}
      onClose={() => {
        send.reset();
        onClose();
      }}
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 id="adjust-title" className="text-lg font-semibold">
          {adjusting ? "Adjust manual entry" : "Add time"}
        </h2>
        <p className="text-[13px] text-ink2">
          {adjusting
            ? "Changes the times or project of this entry. "
            : "Adds approved time on the employee's behalf. "}
          It can't overlap time they were clocked in. The employee sees the change and your reason.
          Times are in {zone}.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="adjust-day">Day</Label>
          <select
            id="adjust-day"
            value={form.day}
            onChange={(e) => set({ day: e.target.value })}
            className={fieldClass}
          >
            {days.map((d) => (
              <option key={d} value={d}>
                {dayLabel(d)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adjust-start">Start</Label>
            <Input
              id="adjust-start"
              type="time"
              required
              value={form.start}
              onChange={(e) => set({ start: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adjust-end">End</Label>
            <Input
              id="adjust-end"
              type="time"
              required
              value={form.end}
              onChange={(e) => set({ end: e.target.value })}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="adjust-project">Project</Label>
          <select
            id="adjust-project"
            value={form.projectId}
            onChange={(e) => set({ projectId: e.target.value, taskId: "" })}
            className={fieldClass}
          >
            <option value="">Unassigned</option>
            {projects
              .filter((p) => !p.archived)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </div>
        <TaskSelect
          id="adjust-task"
          tasks={tasks}
          projectId={form.projectId || null}
          value={form.taskId}
          keep={target?.taskId}
          onChange={(taskId) => set({ taskId })}
          className={fieldClass}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="adjust-reason">Reason</Label>
          <textarea
            id="adjust-reason"
            rows={3}
            maxLength={500}
            value={form.reason}
            onChange={(e) => set({ reason: e.target.value })}
            className="rounded-[9px] border border-line2 bg-panel p-3 text-sm text-ink"
          />
        </div>
        {(problem || send.error) && (
          <p role="alert" className="text-sm text-warnink">
            {problem ?? send.error?.message}
          </p>
        )}
        <Actions
          dialogRef={dialogRef}
          busy={send.isPending}
          label={adjusting ? "Save changes" : "Add time"}
          onClose={() => {
            setProblem(null);
            send.reset();
          }}
        />
      </form>
    </dialog>
  );
}

const blankReassign = {
  projectId: "",
  taskId: "",
  part: false,
  start: "09:00",
  end: "17:00",
  note: "",
};

/** What the employee is re-assigning: an exact stretch of time, or a day (or part of it). */
export type ReassignTarget =
  | { kind: "span"; startAt: string; endAt: string }
  | { kind: "day"; day: string };

/**
 * PRJ-04: the employee moves their own time to a project they're on, while the week is
 * a draft. A stretch of Unassigned time is tagged as it is; a day can be moved whole or
 * between two times. The note is optional; nothing is sent to the manager, who sees the
 * change in the week's edits.
 */
export function ReassignDialog({
  dialogRef,
  zone,
  projects,
  tasks,
  target,
  onSubmit,
  onClose,
}: {
  dialogRef: Ref;
  zone: string;
  /** Projects the employee is assigned to. */
  projects: Project[];
  tasks: Task[];
  target: ReassignTarget | null;
  onSubmit: (r: {
    startAt: string;
    endAt: string;
    projectId: string | null;
    taskId: string | null;
    note: string;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const isDay = target?.kind === "day";
  const [form, setForm] = useState(blankReassign);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const send = useMutation({
    mutationFn: onSubmit,
    onSuccess: () => {
      set({ note: "" });
      dialogRef.current?.close();
    },
  });
  // A new target starts a fresh form. (Not a `key`: a remount would swap the opened dialog
  // for a closed one. The page sets the target, opens the dialog in an effect, and clears
  // the target from `onClose`.)
  const { reset } = send;
  useEffect(() => {
    if (!target) return;
    setForm(blankReassign);
    setProblem(null);
    reset();
  }, [target, reset]);

  function range(): { startAt: string; endAt: string } | null {
    if (!target) return null;
    if (target.kind === "span") return target;
    const whole = daySpan(target.day, zone);
    if (!whole || !form.part) return whole;
    const at = (time: string) => DateTime.fromISO(`${target.day}T${time}`, { zone });
    const start = at(form.start);
    const end = at(form.end);
    if (!start.isValid || !end.isValid || end <= start) {
      setProblem("The end must be after the start.");
      return null;
    }
    if (end > DateTime.now()) {
      setProblem("The time can't end in the future.");
      return null;
    }
    return { startAt: start.toUTC().toISO() ?? "", endAt: end.toUTC().toISO() ?? "" };
  }

  function submit() {
    setProblem(null);
    if (!isDay && !form.projectId) {
      setProblem("Choose a project.");
      return;
    }
    const r = range();
    if (!r) {
      setProblem((p) => p ?? "There's no time to move on that day yet.");
      return;
    }
    send.mutate({
      ...r,
      projectId: form.projectId || null,
      taskId: (form.projectId && form.taskId) || null,
      note: form.note,
    });
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="reassign-title"
      className={dialogClass}
      onClose={onClose}
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 id="reassign-title" className="text-lg font-semibold">
          {isDay ? "Change project" : "Tag a project"}
        </h2>
        <p className="text-[13px] text-ink2">
          {target?.kind === "span" ? (
            <>
              <span className="font-mono">
                {DateTime.fromISO(target.startAt, { zone: "local" }).toFormat("ccc d")} ·{" "}
                <Time iso={target.startAt} employeeZone={zone} />–
                <Time iso={target.endAt} employeeZone={zone} />
              </span>
              .{" "}
            </>
          ) : target ? (
            <>{dayLabel(target.day)}. </>
          ) : null}
          Moves your time to a project you're on. Your manager sees the change when they review the
          week. Flagged time stays flagged.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reassign-project">Project</Label>
          <select
            id="reassign-project"
            value={form.projectId}
            onChange={(e) => set({ projectId: e.target.value, taskId: "" })}
            className={fieldClass}
          >
            <option value="">{isDay ? "Unassigned" : "Choose a project"}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <TaskSelect
          id="reassign-task"
          tasks={tasks}
          projectId={form.projectId || null}
          value={form.taskId}
          onChange={(taskId) => set({ taskId })}
          className={fieldClass}
        />
        {isDay && (
          <>
            <label className="flex items-center gap-2 text-[13.5px]">
              <input
                type="checkbox"
                checked={form.part}
                onChange={(e) => set({ part: e.target.checked })}
              />
              Only part of the day
            </label>
            {form.part && (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reassign-start">From</Label>
                  <Input
                    id="reassign-start"
                    type="time"
                    required
                    value={form.start}
                    onChange={(e) => set({ start: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reassign-end">To</Label>
                  <Input
                    id="reassign-end"
                    type="time"
                    required
                    value={form.end}
                    onChange={(e) => set({ end: e.target.value })}
                  />
                </div>
              </div>
            )}
          </>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reassign-note">Note (optional)</Label>
          <textarea
            id="reassign-note"
            rows={2}
            maxLength={500}
            value={form.note}
            onChange={(e) => set({ note: e.target.value })}
            className="rounded-[9px] border border-line2 bg-panel p-3 text-sm text-ink"
          />
        </div>
        {(problem || send.error) && (
          <p role="alert" className="text-sm text-warnink">
            {problem ?? send.error?.message}
          </p>
        )}
        <Actions
          dialogRef={dialogRef}
          busy={send.isPending}
          label={isDay ? "Change project" : "Tag project"}
          onClose={() => {
            setProblem(null);
            send.reset();
          }}
        />
      </form>
    </dialog>
  );
}

/**
 * TS-25: the employee's note on what they did on a day. Empty clears it. The page sets
 * `target` and opens the dialog, and clears `target` from `onClose` (not keyed, like
 * ProjectDialog).
 */
export function DayNoteDialog({
  dialogRef,
  target,
  onSubmit,
  onClose,
}: {
  dialogRef: Ref;
  target: { day: string; note: string } | null;
  onSubmit: (day: string, note: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [note, setNote] = useState(target?.note ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(target);
  if (shown !== target) {
    setShown(target);
    setNote(target?.note ?? "");
    setProblem(null);
  }
  const send = useMutation({
    mutationFn: (v: { day: string; note: string | null }) => onSubmit(v.day, v.note),
    onSuccess: () => dialogRef.current?.close(),
  });

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="day-note-title"
      className={dialogClass}
      onClose={() => {
        send.reset();
        onClose();
      }}
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setProblem(null);
          if (!target) return;
          const parsed = WorkNote.safeParse(note);
          if (!parsed.success) {
            setProblem(parsed.error.issues[0]?.message ?? "Check the note.");
            return;
          }
          send.mutate({ day: target.day, note: parsed.data });
        }}
      >
        <h2 id="day-note-title" className="text-lg font-semibold">
          Work done{target ? ` · ${dayLabel(target.day)}` : ""}
        </h2>
        <p className="text-[13px] text-ink2">
          What you worked on this day. Your manager reads it when they review the week. Leave it
          empty to remove the note.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="day-note-text">Note</Label>
          <textarea
            id="day-note-text"
            rows={6}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="rounded-[9px] border border-line2 bg-panel p-3 text-sm text-ink"
          />
          <span className="text-xs text-ink3">{note.length} / 2,000</span>
        </div>
        {(problem || send.error) && (
          <p role="alert" className="text-sm text-warnink">
            {problem ?? send.error?.message}
          </p>
        )}
        <Actions
          dialogRef={dialogRef}
          busy={send.isPending}
          label="Save note"
          onClose={() => {
            setProblem(null);
            send.reset();
          }}
        />
      </form>
    </dialog>
  );
}

/**
 * TS-24 / PRJ-05: the employee changes the task and work note of one of their manual
 * entries (its times and project stay; those are a new request). Same pattern as
 * DayNoteDialog.
 */
export function EntryDetailsDialog({
  dialogRef,
  target,
  tasks,
  projectName,
  zone,
  onSubmit,
  onClose,
}: {
  dialogRef: Ref;
  target: ManualEntry | null;
  tasks: Task[];
  projectName: (id: string | null) => string;
  zone: string;
  onSubmit: (entry: ManualEntry, taskId: string | null, note: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [taskId, setTaskId] = useState(target?.taskId ?? "");
  const [note, setNote] = useState(target?.note ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(target);
  if (shown !== target) {
    setShown(target);
    setTaskId(target?.taskId ?? "");
    setNote(target?.note ?? "");
    setProblem(null);
  }
  const send = useMutation({
    mutationFn: (v: { entry: ManualEntry; taskId: string | null; note: string | null }) =>
      onSubmit(v.entry, v.taskId, v.note),
    onSuccess: () => dialogRef.current?.close(),
  });

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="entry-details-title"
      className={dialogClass}
      onClose={() => {
        send.reset();
        onClose();
      }}
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setProblem(null);
          if (!target) return;
          const parsed = WorkNote.safeParse(note);
          if (!parsed.success) {
            setProblem(parsed.error.issues[0]?.message ?? "Check the note.");
            return;
          }
          send.mutate({ entry: target, taskId: taskId || null, note: parsed.data });
        }}
      >
        <h2 id="entry-details-title" className="text-lg font-semibold">
          Entry details
        </h2>
        {target && (
          <p className="font-mono text-[13px] text-ink2">
            {DateTime.fromISO(target.startAt, { zone: "local" }).toFormat("ccc d")} ·{" "}
            <Time iso={target.startAt} employeeZone={zone} />–
            <Time iso={target.endAt} employeeZone={zone} /> · {projectName(target.projectId)}
          </p>
        )}
        <TaskSelect
          id="entry-details-task"
          tasks={tasks}
          projectId={target?.projectId ?? null}
          value={taskId}
          keep={target?.taskId}
          onChange={setTaskId}
          className={fieldClass}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="entry-details-note">Work done</Label>
          <textarea
            id="entry-details-note"
            rows={5}
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="rounded-[9px] border border-line2 bg-panel p-3 text-sm text-ink"
          />
        </div>
        {(problem || send.error) && (
          <p role="alert" className="text-sm text-warnink">
            {problem ?? send.error?.message}
          </p>
        )}
        <Actions
          dialogRef={dialogRef}
          busy={send.isPending}
          label="Save details"
          onClose={() => {
            setProblem(null);
            send.reset();
          }}
        />
      </form>
    </dialog>
  );
}
