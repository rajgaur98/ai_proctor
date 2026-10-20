// Dialogs of the timesheet page (#43): a note (return comment, reopen reason), a
// project change, and added or adjusted time. Each validates with Zod before it
// calls the database, which checks the rules again.
import { ManualEntryRequest } from "@ai-proctor/contracts";
import { useMutation } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import type { Project } from "../projects/projectData";
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

/** Moves a flagged segment's time to another project, with a reason (TS-13). */
export function ProjectDialog({
  dialogRef,
  projects,
  current,
  schema,
  onSubmit,
}: {
  dialogRef: Ref;
  projects: Project[];
  current: string | null;
  schema: TextSchema;
  onSubmit: (projectId: string | null, reason: string) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(current ?? "");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (v: { projectId: string | null; reason: string }) =>
      onSubmit(v.projectId, v.reason),
    onSuccess: () => {
      setReason("");
      dialogRef.current?.close();
    },
  });

  return (
    <dialog ref={dialogRef} aria-labelledby="project-edit-title" className={dialogClass}>
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
          send.mutate({ projectId: projectId || null, reason: parsed.data });
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
            onChange={(e) => setProjectId(e.target.value)}
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
}

/** Adds time on the employee's behalf, or changes a manual entry's times (TS-13). */
export function AdjustDialog({
  dialogRef,
  zone,
  days,
  target,
  projects,
  schema,
  onSubmit,
}: {
  dialogRef: Ref;
  zone: string;
  /** The week's days (employee-local). */
  days: string[];
  target: AdjustTarget | null;
  projects: Project[];
  schema: TextSchema;
  onSubmit: (r: ManualEntryRequest, entryId: string | null) => Promise<void>;
}) {
  const first = target ? DateTime.fromISO(target.start, { zone }) : null;
  const last = target ? DateTime.fromISO(target.end, { zone }) : null;
  const [form, setForm] = useState({
    day: first?.toISODate() ?? days[0] ?? "",
    start: first?.toFormat("HH:mm") ?? "",
    end: last?.toFormat("HH:mm") ?? "",
    projectId: target?.projectId ?? "",
    reason: "",
  });
  const [problem, setProblem] = useState<string | null>(null);
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
      reason: reason.data,
    });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? "Check the fields.");
      return;
    }
    send.mutate(parsed.data);
  }

  return (
    <dialog ref={dialogRef} aria-labelledby="adjust-title" className={dialogClass}>
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
            onChange={(e) => set({ projectId: e.target.value })}
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
