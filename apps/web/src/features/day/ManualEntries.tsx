// Manual entries on the day page (#42, TS-07..09): time the employee asks to have
// added. Pending entries are shown but not counted; the direct manager approves or
// rejects them (or their active delegate does), and the employee can withdraw a pending one.
// An entry can carry a task of its project and a "work done" note (#254, PRJ-05, TS-24).
import { ManualEntryRequest } from "@ai-proctor/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Time } from "../../lib/time";
import { assignmentLabel, projectsQuery, tasksQuery } from "../projects/projectData";
import { TaskSelect } from "../projects/TaskSelect";
import {
  cancelEntry,
  dayEntriesQuery,
  decideEntry,
  type EntryStatus,
  type ManualEntry,
  requestEntry,
} from "./entryData";

const statusStyle: Record<EntryStatus, { label: string; className: string }> = {
  pending: {
    label: "Pending, not counted",
    className: "border border-warnline bg-warnbg text-warnink",
  },
  approved: { label: "Approved", className: "bg-accsoft text-acctext" },
  rejected: { label: "Rejected", className: "bg-sunk text-ink2" },
};

function durationText(entry: ManualEntry): string {
  const minutes = Math.floor((Date.parse(entry.endAt) - Date.parse(entry.startAt)) / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

export function ManualEntries({
  userId,
  zone,
  date,
  dayStart,
  dayEnd,
  isSelf,
  canDecide,
}: {
  userId: string;
  zone: string;
  date: string;
  /** The employee's local day, in epoch milliseconds. */
  dayStart: number;
  dayEnd: number;
  /** The viewer is the employee: they can request and withdraw. */
  isSelf: boolean;
  /** The viewer is the employee's direct manager or active delegate: they can decide. */
  canDecide: boolean;
}) {
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const entries = useQuery(
    dayEntriesQuery(userId, new Date(dayStart).toISOString(), new Date(dayEnd).toISOString()),
  );
  const projects = useQuery(projectsQuery);
  const tasks = useQuery(tasksQuery);
  const projectName = new Map((projects.data ?? []).map((p) => [p.id, p.name]));
  const taskName = new Map((tasks.data ?? []).map((t) => [t.id, t.name]));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["manual-entries", userId] });

  return (
    <section
      aria-labelledby="manual-entries-title"
      className="overflow-hidden rounded-xl border border-line bg-panel"
    >
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <h2 id="manual-entries-title" className="text-sm font-semibold">
          Manual entries
        </h2>
        {isSelf && (
          <Button
            variant="secondary"
            className="ml-auto h-9"
            onClick={() => dialogRef.current?.showModal()}
          >
            Request manual time
          </Button>
        )}
      </div>
      {entries.error ? (
        <p role="alert" className="px-5 py-4 text-sm text-warnink">
          Couldn't load manual entries: {entries.error.message}
        </p>
      ) : entries.isPending ? (
        <p className="px-5 py-4 text-sm text-ink2">Loading…</p>
      ) : entries.data.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink2">No manual entries on this day.</p>
      ) : (
        <ul>
          {entries.data.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              zone={zone}
              projectName={
                e.projectId
                  ? assignmentLabel(
                      projectName.get(e.projectId) ?? "Project",
                      e.taskId ? taskName.get(e.taskId) : null,
                    )
                  : "Unassigned"
              }
              canCancel={isSelf}
              canDecide={canDecide}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}
      {isSelf && (
        <RequestDialog
          dialogRef={dialogRef}
          userId={userId}
          zone={zone}
          date={date}
          onRequested={refresh}
        />
      )}
    </section>
  );
}

function EntryRow({
  entry,
  zone,
  projectName,
  canCancel,
  canDecide,
  onChanged,
}: {
  entry: ManualEntry;
  zone: string;
  projectName: string;
  canCancel: boolean;
  canDecide: boolean;
  onChanged: () => void;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const { label, className } = statusStyle[entry.status];
  const decide = useMutation({
    mutationFn: (approve: boolean) => decideEntry(entry.id, approve, note),
    onSuccess: onChanged,
  });
  const cancel = useMutation({ mutationFn: () => cancelEntry(entry.id), onSuccess: onChanged });
  const pending = entry.status === "pending";
  const error = decide.error ?? cancel.error;

  return (
    <li className="flex flex-col gap-2 border-b border-line px-5 py-3 text-[13.5px] last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <Time iso={entry.startAt} employeeZone={zone} />–
          <Time iso={entry.endAt} employeeZone={zone} />
        </span>
        <span className="text-ink3">{durationText(entry)}</span>
        <span>{projectName}</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
          {label}
        </span>
      </div>
      <p className="text-ink2">{entry.reason}</p>
      {entry.note && <p className="text-ink2">Work done: {entry.note}</p>}
      {entry.decisionNote && <p className="text-ink3">Manager's note: {entry.decisionNote}</p>}
      {pending && canDecide && (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={noteId} className="sr-only">
            Note for the decision (optional)
          </Label>
          <Input
            id={noteId}
            value={note}
            maxLength={500}
            placeholder="Note (optional)"
            onChange={(ev) => setNote(ev.target.value)}
            className="h-9 w-64"
          />
          <Button className="h-9" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
            Approve
          </Button>
          <Button
            variant="secondary"
            className="h-9"
            disabled={decide.isPending}
            onClick={() => decide.mutate(false)}
          >
            Reject
          </Button>
        </div>
      )}
      {pending && canCancel && (
        <Button
          variant="secondary"
          className="h-9 self-start"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          Cancel request
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-warnink">
          {error.message}
        </p>
      )}
    </li>
  );
}

function RequestDialog({
  dialogRef,
  userId,
  zone,
  date,
  onRequested,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  userId: string;
  zone: string;
  date: string;
  onRequested: () => void;
}) {
  const projects = useQuery(projectsQuery);
  const tasks = useQuery(tasksQuery).data ?? [];
  const mine = (projects.data ?? []).filter((p) => !p.archived && p.memberIds.includes(userId));
  const blank = { day: date, start: "", end: "", projectId: "", taskId: "", reason: "", note: "" };
  const [form, setForm] = useState(blank);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<typeof blank>) => setForm((f) => ({ ...f, ...patch }));

  const send = useMutation({
    mutationFn: requestEntry,
    onSuccess: () => {
      onRequested();
      setForm({ ...blank, day: form.day });
      dialogRef.current?.close();
    },
  });

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
      setProblem("The entry can't end in the future.");
      return;
    }
    const parsed = ManualEntryRequest.safeParse({
      start_at: start.toISO(),
      end_at: end.toISO(),
      project_id: form.projectId || null,
      task_id: (form.projectId && form.taskId) || null,
      reason: form.reason,
      note: form.note,
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
      aria-labelledby="manual-entry-title"
      className="m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 id="manual-entry-title" className="text-lg font-semibold">
          Request manual time
        </h2>
        <p className="text-[13px] text-ink2">
          For work that wasn't captured. Your manager approves it, and it can't overlap time you
          were clocked in. Times are in {zone}.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-day">Date</Label>
          <Input
            id="manual-day"
            type="date"
            required
            value={form.day}
            max={DateTime.now().setZone(zone).toISODate() ?? undefined}
            onChange={(e) => set({ day: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-start">Start</Label>
            <Input
              id="manual-start"
              type="time"
              required
              value={form.start}
              onChange={(e) => set({ start: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-end">End</Label>
            <Input
              id="manual-end"
              type="time"
              required
              value={form.end}
              onChange={(e) => set({ end: e.target.value })}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-project">Project</Label>
          <select
            id="manual-project"
            value={form.projectId}
            onChange={(e) => set({ projectId: e.target.value, taskId: "" })}
            className="h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink"
          >
            <option value="">Unassigned</option>
            {mine.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <TaskSelect
          id="manual-task"
          tasks={tasks}
          projectId={form.projectId || null}
          value={form.taskId}
          onChange={(taskId) => set({ taskId })}
          className="h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink"
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-reason">Reason</Label>
          <textarea
            id="manual-reason"
            rows={3}
            required
            maxLength={500}
            value={form.reason}
            onChange={(e) => set({ reason: e.target.value })}
            className="rounded-[9px] border border-line2 bg-panel p-3 text-sm text-ink"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-note">Work done (optional)</Label>
          <textarea
            id="manual-note"
            rows={3}
            maxLength={2000}
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
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            className="ml-auto"
            onClick={() => {
              setProblem(null);
              send.reset();
              dialogRef.current?.close();
            }}
          >
            Close
          </Button>
          <Button type="submit" disabled={send.isPending}>
            {send.isPending ? "Sending…" : "Send request"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
