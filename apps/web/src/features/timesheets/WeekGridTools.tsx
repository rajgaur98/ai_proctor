// The week grid's shortcuts (#264, TS-34): quick add, and copying last week. Quick add is
// a compact form on the grid for manual time with a start and end the employee picks: the
// same request, under the same rules, as the request dialog (TS-07..09, TS-24), not a
// different kind of entry. "Copy last week" copies last week's rows as empty rows and, if
// asked, its manual entries to the same days and times as new requests, then says what was
// copied and what was skipped and why.
import { useMutation, useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { cn } from "../../lib/cn";
import { useFocusAfter } from "../../lib/focus";
import { Time } from "../../lib/time";
import { dayEntriesQuery, requestEntry } from "../day/entryData";
import { type ManualRequestForm, manualRequest } from "../day/manualRequest";
import type { Project, Task } from "../projects/projectData";
import { TaskSelect } from "../projects/TaskSelect";
import { type CopyOutcome, copyOutcomes, copyPlan, lastWeekRows, skipText } from "./copyWeek";
import { localDay } from "./dayList";
import { copyWeekEntries } from "./gridData";
import { breakdownQuery } from "./timesheetData";
import type { GridAssignment } from "./weekGridModel";
import { addWeeks, dayLabel, weekDays } from "./weeks";

const fieldClass = "h-10 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink";
const dialogClass =
  "m-auto w-[min(560px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30";

/** Quick add: manual time with a day, start and end, project, task, reason and note. */
export function QuickAdd({
  zone,
  days,
  projects,
  tasks,
  onAdded,
}: {
  zone: string;
  /** The week's days the employee can add time to (up to today). */
  days: string[];
  /** Projects the employee can log to. */
  projects: Project[];
  tasks: Task[];
  onAdded: () => Promise<void>;
}) {
  const blank: ManualRequestForm = {
    day: days.at(-1) ?? "",
    start: "",
    end: "",
    projectId: "",
    taskId: "",
    reason: "",
    note: "",
  };
  const [form, setForm] = useState(blank);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const set = (patch: Partial<ManualRequestForm>) => setForm((f) => ({ ...f, ...patch }));
  const send = useMutation({
    mutationFn: requestEntry,
    onSuccess: async () => {
      setDone(`Asked for ${form.start}–${form.end} on ${dayLabel(form.day)}.`);
      // Keep the day, project and task for the next one.
      setForm((f) => ({ ...f, start: "", end: "", reason: "", note: "" }));
      await onAdded();
    },
  });

  // Sending disables Add time; the focus goes back to it, for the next one.
  useFocusAfter(send.isPending, () =>
    document.querySelector<HTMLElement>('#week-grid-quick-add button[type="submit"]'),
  );

  return (
    <section
      id="week-grid-quick-add"
      aria-labelledby="week-grid-quick-add-title"
      className="rounded-[10px] border border-line bg-sunk p-4"
    >
      <h3 id="week-grid-quick-add-title" className="text-[13.5px] font-semibold">
        Quick add
      </h3>
      <p className="mb-3 text-[12.5px] text-ink2">
        Manual time with a start and end, like any request: your manager approves it, and it can't
        overlap time you were clocked in. Times are in {zone}.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setProblem(null);
          setDone(null);
          const checked = manualRequest(form, zone, DateTime.now());
          if ("problem" in checked) {
            setProblem(checked.problem);
            return;
          }
          send.mutate(checked.request);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.6fr)]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-add-day">Day</Label>
            <select
              id="quick-add-day"
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-add-start">Start</Label>
            <Input
              id="quick-add-start"
              type="time"
              required
              value={form.start}
              onChange={(e) => set({ start: e.target.value })}
              className="h-10"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-add-end">End</Label>
            <Input
              id="quick-add-end"
              type="time"
              required
              value={form.end}
              onChange={(e) => set({ end: e.target.value })}
              className="h-10"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-add-project">Project</Label>
            <select
              id="quick-add-project"
              value={form.projectId}
              onChange={(e) => set({ projectId: e.target.value, taskId: "" })}
              className={fieldClass}
            >
              <option value="">Unassigned</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <TaskSelect
            id="quick-add-task"
            tasks={tasks}
            projectId={form.projectId || null}
            value={form.taskId}
            onChange={(taskId) => set({ taskId })}
            className={fieldClass}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-add-reason">Reason</Label>
            <Input
              id="quick-add-reason"
              required
              maxLength={500}
              value={form.reason}
              onChange={(e) => set({ reason: e.target.value })}
              className="h-10"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-add-note">Work done (optional)</Label>
            <Input
              id="quick-add-note"
              maxLength={2000}
              value={form.note}
              onChange={(e) => set({ note: e.target.value })}
              className="h-10"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {(problem || send.error) && (
            <p role="alert" className="text-sm text-warnink">
              {problem ?? send.error?.message}
            </p>
          )}
          <p role="status" className="text-[13px] text-ink2">
            {done}
          </p>
          <Button type="submit" className="ml-auto h-10" disabled={send.isPending}>
            {send.isPending ? "Sending…" : "Add time"}
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * "Copy last week": last week's rows into `week` as empty rows (`onCopyRows`), and with
 * "include hours" its manual entries as new requests. `open` is true while it's shown.
 */
export function CopyWeekDialog({
  dialogRef,
  open,
  userId,
  week,
  zone,
  lastWeekAdded,
  label,
  canLog,
  onCopyRows,
  onChanged,
  onClose,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  open: boolean;
  userId: string;
  week: string;
  zone: string;
  /** Rows added to last week's grid in this visit. */
  lastWeekAdded: GridAssignment[];
  label: (a: GridAssignment) => string;
  canLog: (a: GridAssignment) => boolean;
  onCopyRows: (rows: GridAssignment[]) => void;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const lastWeek = addWeeks(week, -1);
  const days = weekDays(lastWeek);
  const from = DateTime.fromISO(lastWeek, { zone });
  const breakdown = useQuery({ ...breakdownQuery(userId, lastWeek), enabled: open });
  const entries = useQuery({
    ...dayEntriesQuery(
      userId,
      from.toUTC().toISO() ?? "",
      from.plus({ days: 7 }).toUTC().toISO() ?? "",
    ),
    enabled: open,
  });
  const [withHours, setWithHours] = useState(false);
  const [summary, setSummary] = useState<{
    rows: GridAssignment[];
    outcomes: CopyOutcome[] | null;
  } | null>(null);

  // The summary replaces the form and its Copy button, which had the focus: move the focus
  // to Done, so it isn't lost to the page (#267).
  useEffect(() => {
    if (summary) dialogRef.current?.querySelector<HTMLElement>("#week-grid-copy-close")?.focus();
  }, [summary, dialogRef]);

  const rows = lastWeekRows(
    days,
    breakdown.data ?? [],
    entries.data ?? [],
    zone,
    lastWeekAdded,
    canLog,
  );
  const plan = copyPlan(entries.data ?? [], days, zone, DateTime.now(), canLog);
  const loading = breakdown.isPending || entries.isPending;
  const loadError = breakdown.error ?? entries.error;

  const copy = useMutation({
    mutationFn: async () => {
      onCopyRows(rows);
      if (!withHours || plan.length === 0) return { rows, outcomes: null };
      const results = await copyWeekEntries(
        week,
        plan.map((p) => p.entry.id),
      );
      await onChanged();
      return { rows, outcomes: copyOutcomes(plan, results) };
    },
    onSuccess: setSummary,
  });
  const nothing = rows.length === 0 && (!withHours || plan.length === 0);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="week-grid-copy-title"
      className={dialogClass}
      onClose={() => {
        setWithHours(false);
        setSummary(null);
        copy.reset();
        onClose();
      }}
    >
      <div className="flex flex-col gap-4">
        <h2 id="week-grid-copy-title" className="text-lg font-semibold">
          Copy last week
        </h2>
        {summary ? (
          <CopySummary summary={summary} label={label} zone={zone} />
        ) : (
          <>
            <p className="text-[13px] text-ink2">
              Adds last week's rows ({dayLabel(lastWeek)} to {dayLabel(days[6] ?? lastWeek)}) to
              this week, without their time. Tracked time is never copied.
            </p>
            {loadError ? (
              <p role="alert" className="text-sm text-warnink">
                Couldn't load last week: {loadError.message}
              </p>
            ) : loading ? (
              <p className="text-sm text-ink2">Loading…</p>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <h3 className="text-[13.5px] font-semibold">Rows</h3>
                  {rows.length === 0 ? (
                    <p className="text-[13px] text-ink3">No rows to copy.</p>
                  ) : (
                    <ul className="text-[13px]">
                      {rows.map((r) => (
                        <li key={`${r.projectId}:${r.taskId}`}>{label(r)}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex items-start gap-2">
                  <input
                    id="week-grid-copy-hours"
                    type="checkbox"
                    checked={withHours}
                    onChange={(e) => setWithHours(e.target.checked)}
                    aria-describedby="week-grid-copy-hours-help"
                    className="mt-0.5 h-4 w-4 flex-none accent-acc"
                  />
                  <div className="flex flex-col gap-0.5">
                    <Label htmlFor="week-grid-copy-hours">Include hours</Label>
                    <span id="week-grid-copy-hours-help" className="text-[12.5px] text-ink2">
                      Also asks for last week's manual entries again, on the same days and times
                      this week. Each is a new request your manager approves; any that can't be
                      copied are skipped.
                    </span>
                  </div>
                </div>
                {withHours &&
                  (plan.length === 0 ? (
                    <p className="text-[13px] text-ink3">No manual entries last week.</p>
                  ) : (
                    <ul aria-label="Entries to copy" className="text-[13px]">
                      {plan.map((p) => (
                        <EntryLine
                          key={p.entry.id}
                          startAt={p.startAt}
                          endAt={p.endAt}
                          zone={zone}
                          name={label({ projectId: p.entry.projectId, taskId: p.entry.taskId })}
                          outcome={p.expected ? `Will be skipped: ${skipText(p.expected)}` : null}
                          skipped={!!p.expected}
                        />
                      ))}
                    </ul>
                  ))}
              </>
            )}
            {copy.error && (
              <p role="alert" className="text-sm text-warnink">
                {copy.error.message}
              </p>
            )}
          </>
        )}
        <div className="flex gap-2">
          <Button
            id="week-grid-copy-close"
            type="button"
            variant="secondary"
            className="ml-auto"
            onClick={() => dialogRef.current?.close()}
          >
            {summary ? "Done" : "Cancel"}
          </Button>
          {!summary && (
            <Button
              type="button"
              disabled={loading || !!loadError || nothing || copy.isPending}
              onClick={() => copy.mutate()}
            >
              {copy.isPending ? "Copying…" : "Copy"}
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}

function CopySummary({
  summary,
  label,
  zone,
}: {
  summary: { rows: GridAssignment[]; outcomes: CopyOutcome[] | null };
  label: (a: GridAssignment) => string;
  zone: string;
}) {
  const { rows, outcomes } = summary;
  const copied = outcomes?.filter((o) => o.skipped === null).length ?? 0;
  const skipped = (outcomes?.length ?? 0) - copied;
  return (
    <div role="status" className="flex flex-col gap-3 text-[13.5px]">
      <p>
        {rows.length === 0
          ? "No rows to add."
          : `Added ${rows.length} ${rows.length === 1 ? "row" : "rows"}: ${rows.map(label).join(", ")}.`}
      </p>
      {outcomes && (
        <>
          <p>
            Copied {copied} of {outcomes.length} manual{" "}
            {outcomes.length === 1 ? "entry" : "entries"}
            {skipped > 0 && `; ${skipped} skipped`}. Each copy is a new request.
          </p>
          <ul aria-label="Copied entries">
            {outcomes.map((o) => (
              <EntryLine
                key={o.entry.id}
                startAt={o.startAt}
                endAt={o.endAt}
                zone={zone}
                name={label({ projectId: o.entry.projectId, taskId: o.entry.taskId })}
                outcome={o.skipped ? `Skipped: ${skipText(o.skipped)}` : "Copied"}
                skipped={!!o.skipped}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function EntryLine({
  startAt,
  endAt,
  zone,
  name,
  outcome,
  skipped,
}: {
  startAt: string;
  endAt: string;
  zone: string;
  name: string;
  outcome: string | null;
  skipped: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-line py-1.5 last:border-0">
      <span>{dayLabel(localDay(startAt, zone))}</span>
      <span className="font-mono text-[13px]">
        <Time iso={startAt} employeeZone={zone} />–
        <Time iso={endAt} employeeZone={zone} />
      </span>
      <span>{name}</span>
      {outcome && (
        <span className={cn("text-xs font-medium", skipped ? "text-warnink" : "text-ink2")}>
          {outcome}
        </span>
      )}
    </li>
  );
}
