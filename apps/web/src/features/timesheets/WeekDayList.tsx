// The week day by day (#263, #254 part 4, TS-30): every day's tracked time and manual
// entries with start and end, project and task, work note and billable. Tracked time is
// read-only here. On their own draft or returned week the employee edits a manual entry's
// times, task and note, splits it in two, merges it with the entry it runs into, or
// duplicates it to another day (a new request). The database checks every rule again:
// whose entry, the week's state, overlaps, and approval (TS-08). #265: each manual entry can
// carry extra content under it (the page puts the entry's comment thread there, TS-33).
import { ManualEntryRequest, WorkNote } from "@ai-proctor/contracts";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useEffect, useRef, useState } from "react";
import { ExportButton } from "../../components/ExportButton";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { supabase } from "../../lib/supabase";
import { formatTime, Time, viewerZone } from "../../lib/time";
import {
  type EntryStatus,
  editEntry,
  type ManualEntry,
  mergeEntries,
  requestEntry,
  splitEntry,
} from "../day/entryData";
import { assignmentLabel, projectsQuery, type Task, tasksQuery } from "../projects/projectData";
import { TaskSelect } from "../projects/TaskSelect";
import {
  type DayItem,
  editRange,
  isBillable,
  localDay,
  localTime,
  mergePartner,
  middleTime,
  onDay,
  splitPoint,
  type TrackedSegment,
  weekDayList,
} from "./dayList";
import { dayListTable } from "./sheetExport";
import { formatDuration } from "./summary";
import { dayLabel, weekDays } from "./weeks";

const dialogClass =
  "m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30";
const fieldClass = "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink";
const areaClass = "rounded-[9px] border border-line2 bg-panel p-3 text-sm text-ink";

type Ref = React.RefObject<HTMLDialogElement | null>;

const statusText: Record<EntryStatus, string> = {
  pending: "Manual · pending, not counted",
  approved: "Manual · approved",
  rejected: "Manual · rejected",
};

/** Counted time of the week as stored, every segment (the list joins them into runs). */
export const weekSegmentsQuery = (userId: string, week: string) =>
  queryOptions({
    // Under "timesheet-segments", so the page's refresh after an edit reloads it too.
    queryKey: ["timesheet-segments", userId, "day-list", week],
    queryFn: async (): Promise<TrackedSegment[]> => {
      const days = weekDays(week);
      const { data, error } = await supabase
        .from("time_segments")
        .select("day, type, start_at, end_at, project_id, task_id, flagged, excluded")
        .eq("user_id", userId)
        .gte("day", days[0] ?? week)
        .lte("day", days[6] ?? week)
        .eq("counted", true)
        .order("start_at");
      if (error) throw error;
      return data.map((s) => ({
        day: s.day,
        type: s.type,
        startAt: s.start_at,
        endAt: s.end_at,
        projectId: s.project_id,
        taskId: s.task_id,
        flagged: s.flagged,
        excluded: s.excluded,
      }));
    },
  });

/** "13:00–14:30 on Mon 2 Feb", in the viewer's zone like the times shown. */
function spanName(item: { startAt: string; endAt: string }, day: string): string {
  const viewer = viewerZone();
  return `${formatTime(item.startAt, viewer)}–${formatTime(item.endAt, viewer)} on ${dayLabel(day)}`;
}

export function WeekDayList({
  userId,
  week,
  zone,
  entries,
  enabled,
  canEdit,
  onChanged,
  personName,
  entryExtra,
}: {
  userId: string;
  week: string;
  /** Whose week, for the export's filters (#255). */
  personName: string;
  /** The employee's zone: days are theirs, and times are typed in it. */
  zone: string;
  /** The week's manual entries (the page already reads them). */
  entries: ManualEntry[];
  /** Read the segments once the page's rebuild has finished. */
  enabled: boolean;
  /** The viewer is the employee and the week is a draft or returned. */
  canEdit: boolean;
  onChanged: () => Promise<void>;
  /** Shown under each manual entry, given the entry and its name ("10:00–11:00 on Mon 2 Feb"). */
  entryExtra?: (entry: ManualEntry, name: string) => React.ReactNode;
}) {
  const segments = useQuery({ ...weekSegmentsQuery(userId, week), enabled });
  const projectsQ = useQuery(projectsQuery);
  const tasksQ = useQuery(tasksQuery);
  const projects = projectsQ.data ?? [];
  const tasks = tasksQ.data ?? [];
  const days = weekDays(week);
  const today = DateTime.now().setZone(zone).toISODate() ?? "";
  const list = weekDayList(days, segments.data ?? [], entries, zone);

  const editRef = useRef<HTMLDialogElement>(null);
  const splitRef = useRef<HTMLDialogElement>(null);
  const duplicateRef = useRef<HTMLDialogElement>(null);
  const [editTarget, setEditTarget] = useState<ManualEntry | null>(null);
  const [splitTarget, setSplitTarget] = useState<ManualEntry | null>(null);
  const [duplicateTarget, setDuplicateTarget] = useState<ManualEntry | null>(null);
  // A target is set while its dialog is open; the dialog opens once it's rendered.
  useEffect(() => {
    if (editTarget && !editRef.current?.open) editRef.current?.showModal();
  }, [editTarget]);
  useEffect(() => {
    if (splitTarget && !splitRef.current?.open) splitRef.current?.showModal();
  }, [splitTarget]);
  useEffect(() => {
    if (duplicateTarget && !duplicateRef.current?.open) duplicateRef.current?.showModal();
  }, [duplicateTarget]);

  const merge = useMutation({
    mutationFn: (pair: { first: string; second: string }) => mergeEntries(pair.first, pair.second),
    onSuccess: onChanged,
  });

  const projectName = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.name ?? "Project") : "Unassigned";
  const assignment = (projectId: string | null, taskId: string | null) =>
    projectId
      ? assignmentLabel(
          projectName(projectId),
          taskId ? (tasks.find((t) => t.id === taskId)?.name ?? "Task") : null,
        )
      : "Unassigned";

  return (
    <section
      aria-labelledby="day-list-title"
      className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-[18px]"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h2 id="day-list-title" className="text-[15px] font-semibold">
            Days
          </h2>
          <ExportButton
            title="Days"
            className="ml-auto h-9"
            ready={enabled && segments.isSuccess && projectsQ.isSuccess && tasksQ.isSuccess}
            spec={{
              page: "timesheet-days",
              filters: { person: personName, week },
              table: () =>
                dayListTable(
                  list,
                  projectName,
                  (id) => tasks.find((t) => t.id === id)?.name ?? "Task",
                  (projectId, taskId) => isBillable(projectId, taskId, projects, tasks),
                  viewerZone(),
                ),
            }}
          />
        </div>
        <p className="text-[13px] text-ink2">
          Tracked time is read-only.
          {canEdit &&
            " Edit, split, merge or duplicate your manual entries until you submit the week."}
        </p>
      </div>
      {segments.error && (
        <p role="alert" className="text-sm text-warnink">
          Couldn't load tracked time: {segments.error.message}
        </p>
      )}
      {merge.error && (
        <p role="alert" className="text-sm text-warnink">
          {merge.error.message}
        </p>
      )}
      {list.map(({ day, items }) => (
        <section key={day} aria-labelledby={`day-list-${day}`} className="flex flex-col">
          <h3
            id={`day-list-${day}`}
            className="border-b border-line pb-1.5 text-[13.5px] font-semibold"
          >
            {dayLabel(day)}
          </h3>
          {items.length === 0 ? (
            <p className="py-2.5 text-[13px] text-ink3">
              {!enabled || segments.isPending ? "Loading…" : "No time."}
            </p>
          ) : (
            <ul>
              {items.map((item) => (
                <ItemRow
                  key={item.kind === "manual" ? item.entry.id : `t-${item.startAt}`}
                  item={item}
                  day={day}
                  zone={zone}
                  assignment={assignment(
                    item.kind === "manual" ? item.entry.projectId : item.projectId,
                    item.kind === "manual" ? item.entry.taskId : item.taskId,
                  )}
                  billable={isBillable(
                    item.kind === "manual" ? item.entry.projectId : item.projectId,
                    item.kind === "manual" ? item.entry.taskId : item.taskId,
                    projects,
                    tasks,
                  )}
                  canEdit={canEdit && item.kind === "manual" && item.entry.status !== "rejected"}
                  mergeWith={
                    item.kind === "manual" && canEdit
                      ? mergePartner(item.entry, entries, zone)
                      : null
                  }
                  merging={merge.isPending}
                  onEdit={setEditTarget}
                  onSplit={setSplitTarget}
                  onDuplicate={setDuplicateTarget}
                  onMerge={(first, second) => merge.mutate({ first, second })}
                  extra={entryExtra}
                />
              ))}
            </ul>
          )}
        </section>
      ))}

      {canEdit && (
        <>
          <EditDialog
            dialogRef={editRef}
            target={editTarget}
            zone={zone}
            tasks={tasks}
            projectName={projectName}
            onClose={() => setEditTarget(null)}
            onSubmit={async (entry, v) => {
              await editEntry(entry.id, v);
              await onChanged();
            }}
          />
          <SplitDialog
            dialogRef={splitRef}
            target={splitTarget}
            zone={zone}
            onClose={() => setSplitTarget(null)}
            onSubmit={async (entry, at) => {
              await splitEntry(entry.id, at);
              await onChanged();
            }}
          />
          <DuplicateDialog
            dialogRef={duplicateRef}
            target={duplicateTarget}
            zone={zone}
            days={days}
            today={today}
            onClose={() => setDuplicateTarget(null)}
            onSubmit={async (r) => {
              await requestEntry(r);
              await onChanged();
            }}
          />
        </>
      )}
    </section>
  );
}

function ItemRow({
  item,
  day,
  zone,
  assignment,
  billable,
  canEdit,
  mergeWith,
  merging,
  onEdit,
  onSplit,
  onDuplicate,
  onMerge,
  extra,
}: {
  item: DayItem;
  day: string;
  zone: string;
  assignment: string;
  billable: boolean;
  canEdit: boolean;
  mergeWith: ManualEntry | null;
  merging: boolean;
  onEdit: (e: ManualEntry) => void;
  onSplit: (e: ManualEntry) => void;
  onDuplicate: (e: ManualEntry) => void;
  onMerge: (first: string, second: string) => void;
  extra?: ((entry: ManualEntry, name: string) => React.ReactNode) | undefined;
}) {
  const kind =
    item.kind === "manual"
      ? statusText[item.entry.status]
      : `Tracked${item.excluded ? " · excluded" : item.flagged ? " · flagged" : ""}`;
  const note = item.kind === "manual" ? item.entry.note : null;
  const name = spanName(item, day);

  return (
    <li className="flex flex-col gap-1.5 border-b border-line py-2.5 text-[13.5px] last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[13px]">
          <Time iso={item.startAt} employeeZone={zone} />–
          <Time iso={item.endAt} employeeZone={zone} />
        </span>
        <span className="font-mono text-[13px] text-ink2">{formatDuration(item.seconds)}</span>
        <span>{assignment}</span>
        <span className="text-xs text-ink2">{billable ? "Billable" : "Non-billable"}</span>
        <span
          className={`ml-auto text-xs font-medium ${
            item.kind === "manual" && item.entry.status === "pending" ? "text-warnink" : "text-ink2"
          }`}
        >
          {kind}
        </span>
      </div>
      {note && <p className="text-[13px] whitespace-pre-line text-ink2">{note}</p>}
      {canEdit && item.kind === "manual" && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            className="h-8 px-3 text-[12.5px]"
            aria-label={`Edit ${name}`}
            onClick={() => onEdit(item.entry)}
          >
            Edit
          </Button>
          <Button
            variant="secondary"
            className="h-8 px-3 text-[12.5px]"
            aria-label={`Split ${name}`}
            onClick={() => onSplit(item.entry)}
          >
            Split
          </Button>
          {mergeWith && (
            <Button
              variant="secondary"
              className="h-8 px-3 text-[12.5px]"
              aria-label={`Merge ${name} with the next entry`}
              disabled={merging}
              onClick={() => onMerge(item.entry.id, mergeWith.id)}
            >
              Merge with next
            </Button>
          )}
          <Button
            variant="secondary"
            className="h-8 px-3 text-[12.5px]"
            aria-label={`Duplicate ${name}`}
            onClick={() => onDuplicate(item.entry)}
          >
            Duplicate
          </Button>
        </div>
      )}
      {extra && item.kind === "manual" && extra(item.entry, name)}
    </li>
  );
}

function Actions({ dialogRef, busy, label }: { dialogRef: Ref; busy: boolean; label: string }) {
  return (
    <div className="flex gap-2">
      <Button
        type="button"
        variant="secondary"
        className="ml-auto"
        onClick={() => dialogRef.current?.close()}
      >
        Cancel
      </Button>
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : label}
      </Button>
    </div>
  );
}

function Problem({ text }: { text: string | null | undefined }) {
  return text ? (
    <p role="alert" className="text-sm text-warnink">
      {text}
    </p>
  ) : null;
}

/**
 * The entry's times, task and note. Times are on the entry's day in the employee's zone;
 * an end before the start is the next day. The page-level pattern: the target is set,
 * then the dialog opens; closing clears it. Not keyed on the target, so the form resets
 * when the target changes instead.
 */
export function EditDialog({
  dialogRef,
  target,
  zone,
  tasks,
  projectName,
  onSubmit,
  onClose,
}: {
  dialogRef: Ref;
  target: ManualEntry | null;
  zone: string;
  tasks: Task[];
  projectName: (id: string | null) => string;
  onSubmit: (
    entry: ManualEntry,
    v: { startAt: string; endAt: string; taskId: string | null; note: string | null },
  ) => Promise<void>;
  onClose: () => void;
}) {
  const blank = (e: ManualEntry | null) => ({
    start: e ? localTime(e.startAt, zone) : "",
    end: e ? localTime(e.endAt, zone) : "",
    taskId: e?.taskId ?? "",
    note: e?.note ?? "",
  });
  const [form, setForm] = useState(blank(target));
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(target);
  if (shown !== target) {
    setShown(target);
    setForm(blank(target));
    setProblem(null);
  }
  const send = useMutation({
    mutationFn: (v: Parameters<typeof onSubmit>) => onSubmit(...v),
    onSuccess: () => dialogRef.current?.close(),
  });

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="day-list-edit-title"
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
          const day = localDay(target.startAt, zone);
          const range = editRange(day, form.start, form.end, zone);
          if (!range) {
            setProblem("Choose a start and an end.");
            return;
          }
          // Keep the seconds of a time that wasn't changed, so nothing is rounded.
          const startAt =
            form.start === localTime(target.startAt, zone) ? target.startAt : range.startAt;
          const endAt =
            form.end === localTime(target.endAt, zone) &&
            localDay(range.endAt, zone) === localDay(target.endAt, zone)
              ? target.endAt
              : range.endAt;
          const note = WorkNote.safeParse(form.note);
          if (!note.success) {
            setProblem(note.error.issues[0]?.message ?? "Check the note.");
            return;
          }
          send.mutate([target, { startAt, endAt, taskId: form.taskId || null, note: note.data }]);
        }}
      >
        <h2 id="day-list-edit-title" className="text-lg font-semibold">
          Edit entry
        </h2>
        {target && (
          <p className="text-[13px] text-ink2">
            {dayLabel(localDay(target.startAt, zone))} · {projectName(target.projectId)}. Times are
            in {zone}.
            {target.status === "approved" &&
              " Changed times are approved again, like a new request."}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="day-list-edit-start">Start</Label>
            <Input
              id="day-list-edit-start"
              type="time"
              required
              value={form.start}
              onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="day-list-edit-end">End</Label>
            <Input
              id="day-list-edit-end"
              type="time"
              required
              value={form.end}
              onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))}
            />
          </div>
        </div>
        <TaskSelect
          id="day-list-edit-task"
          tasks={tasks}
          projectId={target?.projectId ?? null}
          value={form.taskId}
          keep={target?.taskId}
          onChange={(taskId) => setForm((f) => ({ ...f, taskId }))}
          className={fieldClass}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="day-list-edit-note">Work done</Label>
          <textarea
            id="day-list-edit-note"
            rows={4}
            maxLength={2000}
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            className={areaClass}
          />
        </div>
        <Problem text={problem ?? send.error?.message} />
        <Actions dialogRef={dialogRef} busy={send.isPending} label="Save entry" />
      </form>
    </dialog>
  );
}

/** Splits the entry at a time (in the employee's zone) into two entries. */
function SplitDialog({
  dialogRef,
  target,
  zone,
  onSubmit,
  onClose,
}: {
  dialogRef: Ref;
  target: ManualEntry | null;
  zone: string;
  onSubmit: (entry: ManualEntry, at: string) => Promise<void>;
  onClose: () => void;
}) {
  const [time, setTime] = useState(target ? middleTime(target, zone) : "");
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(target);
  if (shown !== target) {
    setShown(target);
    setTime(target ? middleTime(target, zone) : "");
    setProblem(null);
  }
  const send = useMutation({
    mutationFn: (v: { entry: ManualEntry; at: string }) => onSubmit(v.entry, v.at),
    onSuccess: () => dialogRef.current?.close(),
  });

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="day-list-split-title"
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
          const at = splitPoint(target, time, zone);
          if (!at) {
            setProblem(
              `Choose a time between ${localTime(target.startAt, zone)} and ${localTime(target.endAt, zone)}.`,
            );
            return;
          }
          send.mutate({ entry: target, at });
        }}
      >
        <h2 id="day-list-split-title" className="text-lg font-semibold">
          Split entry
        </h2>
        {target && (
          <p className="text-[13px] text-ink2">
            {dayLabel(localDay(target.startAt, zone))}, {localTime(target.startAt, zone)}–
            {localTime(target.endAt, zone)} ({zone}). Both parts keep the project, task, note and
            approval, and add up to the same time.
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="day-list-split-at">Split at</Label>
          <Input
            id="day-list-split-at"
            type="time"
            required
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>
        <Problem text={problem ?? send.error?.message} />
        <Actions dialogRef={dialogRef} busy={send.isPending} label="Split entry" />
      </form>
    </dialog>
  );
}

/**
 * Copies the entry to another day as a new request: the same local times, project, task,
 * note and (editable) reason. It needs approval like any request.
 */
function DuplicateDialog({
  dialogRef,
  target,
  zone,
  days,
  today,
  onSubmit,
  onClose,
}: {
  dialogRef: Ref;
  target: ManualEntry | null;
  zone: string;
  days: string[];
  today: string;
  onSubmit: (r: ManualEntryRequest) => Promise<void>;
  onClose: () => void;
}) {
  const defaultDay = (e: ManualEntry | null) => {
    if (!e) return "";
    const from = localDay(e.startAt, zone);
    const open = days.filter((d) => d !== from && d <= today);
    return open.find((d) => d > from) ?? open.at(-1) ?? from;
  };
  const [day, setDay] = useState(defaultDay(target));
  const [reason, setReason] = useState(target?.reason ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(target);
  if (shown !== target) {
    setShown(target);
    setDay(defaultDay(target));
    setReason(target?.reason ?? "");
    setProblem(null);
  }
  const send = useMutation({
    mutationFn: onSubmit,
    onSuccess: () => dialogRef.current?.close(),
  });

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="day-list-duplicate-title"
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
          const range = onDay(target, day, zone);
          if (!range) {
            setProblem("Choose a day.");
            return;
          }
          if (Date.parse(range.endAt) > Date.now()) {
            setProblem("The copy can't end in the future.");
            return;
          }
          const parsed = ManualEntryRequest.safeParse({
            start_at: range.startAt,
            end_at: range.endAt,
            project_id: target.projectId,
            task_id: target.taskId,
            reason,
            note: target.note,
          });
          if (!parsed.success) {
            setProblem(parsed.error.issues[0]?.message ?? "Check the fields.");
            return;
          }
          send.mutate(parsed.data);
        }}
      >
        <h2 id="day-list-duplicate-title" className="text-lg font-semibold">
          Duplicate entry
        </h2>
        {target && (
          <p className="text-[13px] text-ink2">
            A copy of {localTime(target.startAt, zone)}–{localTime(target.endAt, zone)} ({zone})
            with the same project, task and note, on the day you choose. It's a new request,
            approved like any other.
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="day-list-duplicate-day">Day</Label>
          <Input
            id="day-list-duplicate-day"
            type="date"
            required
            value={day}
            max={today}
            onChange={(e) => setDay(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="day-list-duplicate-reason">Reason</Label>
          <textarea
            id="day-list-duplicate-reason"
            rows={3}
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={areaClass}
          />
        </div>
        <Problem text={problem ?? send.error?.message} />
        <Actions dialogRef={dialogRef} busy={send.isPending} label="Duplicate" />
      </form>
    </dialog>
  );
}
