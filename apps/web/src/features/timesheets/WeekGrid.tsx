// The week as a grid (#262, TS-32): project/task rows by the week's days. Each cell shows
// the row's tracked and manual time that day apart; row, day and week totals add up raw
// seconds (TS-06). From a cell the employee adds manual time with a start and end they
// choose, or edits an entry, through the day page's request dialog and the day list's edit
// dialog, so the manual-entry rules apply (TS-07..09, TS-24): the database checks them all
// again. Tracked time is read-only. Editable while the week is a draft or returned (TS-30);
// everyone else sees it read-only. Keyboard: arrows move between cells, Enter or Space
// opens one, Escape closes it. #264 (TS-34): the employee pins rows from their header
// (favourites, kept server-side, so every week starts with them), and on a week they can
// change adds time with quick add or copies last week's rows, and its manual entries if
// they ask (WeekGridTools).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { cn } from "../../lib/cn";
import { formatTime, Time, viewerZone } from "../../lib/time";
import { type EntryStatus, editEntry, type ManualEntry } from "../day/entryData";
import { RequestDialog } from "../day/ManualEntries";
import {
  assignmentLabel,
  type Project,
  projectsQuery,
  type Task,
  tasksQuery,
} from "../projects/projectData";
import { TaskSelect } from "../projects/TaskSelect";
import { canLogTo, isFavourite, shownFavourites } from "./copyWeek";
import { trackedRuns } from "./dayList";
import { favouritesQuery, setFavourite } from "./gridData";
import { allowedProjects } from "./reassign";
import { type BreakdownRow, formatDuration } from "./summary";
import { EditDialog, weekSegmentsQuery } from "./WeekDayList";
import { CopyWeekDialog, QuickAdd } from "./WeekGridTools";
import {
  type GridAssignment,
  type GridPosition,
  type GridSums,
  moveInGrid,
  weekGrid,
} from "./weekGridModel";
import { addWeeks, dayLabel, weekDays } from "./weeks";

const dialogClass =
  "m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30";
const fieldClass = "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink";

type Ref = React.RefObject<HTMLDialogElement | null>;

const statusText: Record<EntryStatus, string> = {
  pending: "Pending, not counted",
  approved: "Approved",
  rejected: "Rejected",
};

/** "2 h 00 min tracked, 30 min manual": what a cell or total holds, for its accessible name. */
function sumsText(s: GridSums, withTracked: boolean): string {
  const parts = withTracked
    ? [`${formatDuration(s.tracked)} tracked`, `${formatDuration(s.manual)} manual`]
    : [`${formatDuration(s.total)}`];
  if (s.pending > 0) parts.push(`${formatDuration(s.pending)} pending`);
  return parts.join(", ");
}

export function WeekGrid({
  userId,
  week,
  zone,
  breakdown,
  entries,
  enabled,
  loading,
  canEdit,
  isSelf,
  onChanged,
}: {
  userId: string;
  week: string;
  /** The employee's zone: days are theirs, and times are typed in it. */
  zone: string;
  /** The week's seconds (the page already reads them, for its totals). */
  breakdown: BreakdownRow[];
  /** The week's manual entries (the page already reads them). */
  entries: ManualEntry[];
  /** Read the segments once the page's rebuild has finished. */
  enabled: boolean;
  loading: boolean;
  /** The viewer is the employee and the week is a draft or returned. */
  canEdit: boolean;
  /** The viewer is the employee: their pinned rows show, and they pin and unpin. */
  isSelf: boolean;
  onChanged: () => Promise<void>;
}) {
  const projectsQ = useQuery(projectsQuery);
  const tasksQ = useQuery(tasksQuery);
  const segments = useQuery({ ...weekSegmentsQuery(userId, week), enabled });
  const projects = projectsQ.data ?? [];
  const tasks = tasksQ.data ?? [];
  const days = weekDays(week);
  const today = DateTime.now().setZone(zone).toISODate() ?? "";
  const mine = allowedProjects(projects, userId);
  const queryClient = useQueryClient();
  const favouritesQ = useQuery({ ...favouritesQuery, enabled: isSelf });
  const favourites = isSelf ? (favouritesQ.data ?? []) : [];
  // A row the person can log new time to: a project of theirs and an active task of it.
  const loggable = (a: GridAssignment) => canLogTo(a, mine, tasks);
  const pinned = (a: GridAssignment) => isFavourite(favourites, a);
  const pin = useMutation({
    mutationFn: ({ a, on }: { a: GridAssignment; on: boolean }) => setFavourite(a, on),
    onSettled: () => queryClient.invalidateQueries({ queryKey: favouritesQuery.queryKey }),
  });

  // Rows the employee added, per week; they need no time yet, so they live here only.
  // Pinned rows are on every week.
  const [added, setAdded] = useState<Record<string, GridAssignment[]>>({});
  const extraRows = (rows: GridAssignment[]) => [...shownFavourites(favourites, loggable), ...rows];
  const label = (a: GridAssignment) =>
    a.projectId
      ? assignmentLabel(
          projects.find((p) => p.id === a.projectId)?.name ?? "Project",
          a.taskId ? (tasks.find((t) => t.id === a.taskId)?.name ?? "Task") : null,
        )
      : "Unassigned";
  const grid = weekGrid(days, breakdown, entries, zone, extraRows(added[week] ?? []), label);
  const canLog = (a: GridAssignment) =>
    a.projectId === null || mine.some((p) => p.id === a.projectId);

  // One cell is in the tab order (roving tabindex); arrows move it.
  const [active, setActive] = useState<GridPosition>({ row: 0, col: 0 });
  const at = {
    row: Math.min(active.row, grid.rows.length - 1),
    col: Math.min(active.col, days.length - 1),
  };
  const cells = useRef(new Map<string, HTMLTableCellElement>());
  const [focusNext, setFocusNext] = useState<GridPosition | null>(null);
  useEffect(() => {
    if (!focusNext) return;
    cells.current.get(`${focusNext.row}:${focusNext.col}`)?.focus();
    setFocusNext(null);
  }, [focusNext]);

  const cellRef = useRef<HTMLDialogElement>(null);
  const requestRef = useRef<HTMLDialogElement>(null);
  const editRef = useRef<HTMLDialogElement>(null);
  const addRowRef = useRef<HTMLDialogElement>(null);
  const copyRef = useRef<HTMLDialogElement>(null);
  const [copying, setCopying] = useState(false);
  const [quickAdd, setQuickAdd] = useState(false);
  const [open, setOpen] = useState<{ key: string; day: string } | null>(null);
  const [requestTarget, setRequestTarget] = useState<{
    day: string;
    projectId: string | null;
    taskId: string | null;
  } | null>(null);
  const [editTarget, setEditTarget] = useState<ManualEntry | null>(null);
  // A target is set while its dialog is open; the dialog opens once it's rendered.
  useEffect(() => {
    if (open && !cellRef.current?.open) cellRef.current?.showModal();
  }, [open]);
  useEffect(() => {
    if (requestTarget && !requestRef.current?.open) requestRef.current?.showModal();
  }, [requestTarget]);
  useEffect(() => {
    if (editTarget && !editRef.current?.open) editRef.current?.showModal();
  }, [editTarget]);
  useEffect(() => {
    if (copying && !copyRef.current?.open) copyRef.current?.showModal();
  }, [copying]);

  const openRow = open ? grid.rows.find((r) => r.key === open.key) : undefined;
  const openCell = openRow?.cells.find((c) => c.day === open?.day);

  function onKeyDown(e: React.KeyboardEvent, pos: GridPosition, key: string, day: string) {
    if (e.key === "Enter") {
      e.preventDefault();
      setOpen({ key, day });
      return;
    }
    // Space opens the cell when it's released, so the key can't also press a button of
    // the dialog that just took the focus.
    if (e.key === " ") {
      e.preventDefault();
      return;
    }
    const next = moveInGrid(pos, e.key, grid.rows.length, days.length);
    if (!next) return;
    e.preventDefault();
    setActive(next);
    cells.current.get(`${next.row}:${next.col}`)?.focus();
  }

  return (
    <section
      aria-labelledby="week-grid-title"
      className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-[18px]"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h2 id="week-grid-title" className="text-[15px] font-semibold">
            Week grid
          </h2>
          {canEdit && (
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                className="h-9"
                aria-expanded={quickAdd}
                aria-controls="week-grid-quick-add"
                disabled={days[0] === undefined || days[0] > today}
                onClick={() => setQuickAdd((q) => !q)}
              >
                Quick add
              </Button>
              <Button variant="secondary" className="h-9" onClick={() => setCopying(true)}>
                Copy last week
              </Button>
              <Button
                variant="secondary"
                className="h-9"
                disabled={mine.length === 0}
                onClick={() => addRowRef.current?.showModal()}
              >
                Add a row
              </Button>
            </div>
          )}
        </div>
        <p id="week-grid-help" className="text-[13px] text-ink2">
          Each cell shows tracked time, then manual time; pending time isn't counted until it's
          approved. Tracked time is read-only.
          {canEdit && " Open a cell to add manual time with a start and end, or to edit it."}
          {isSelf && " Pin a row to have it on every week."} Arrow keys move between cells and Enter
          opens one.
        </p>
      </div>
      {pin.error && (
        <p role="alert" className="text-sm text-warnink">
          {pin.error.message}
        </p>
      )}
      {canEdit && quickAdd && (
        <QuickAdd
          // A new week starts a new form, on one of its own days.
          key={week}
          zone={zone}
          days={days.filter((d) => d <= today)}
          projects={mine}
          tasks={tasks}
          onAdded={onChanged}
        />
      )}
      {loading ? (
        <p className="text-sm text-ink2">Loading…</p>
      ) : (
        <div className="overflow-x-auto">
          <table
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the ARIA grid pattern on a table; its cells move with the arrow keys
            role="grid"
            aria-labelledby="week-grid-title"
            aria-describedby="week-grid-help"
            className="w-full min-w-[960px] border-collapse text-[13.5px]"
          >
            <thead className="bg-sunk text-left text-xs font-medium text-ink3">
              <tr className="h-10 border-b border-line">
                <th scope="col" className="px-4 font-medium">
                  Project / task
                </th>
                {days.map((d) => (
                  <th key={d} scope="col" className="px-2 font-medium whitespace-nowrap">
                    {dayLabel(d)}
                  </th>
                ))}
                <th scope="col" className="px-4 font-medium">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row, r) => {
                const name = label(row);
                return (
                  <tr key={row.key} className="border-b border-line align-top">
                    <th
                      scope="row"
                      // Named by the row alone, not its pin button too.
                      aria-label={name}
                      className="px-4 py-2.5 text-left font-medium"
                    >
                      <div className="flex items-start gap-2">
                        <span className="mr-auto">{name}</span>
                        {isSelf && row.projectId !== null && (pinned(row) || loggable(row)) && (
                          <PinButton
                            name={name}
                            pinned={pinned(row)}
                            onClick={() =>
                              pin.mutate({
                                a: { projectId: row.projectId, taskId: row.taskId },
                                on: !pinned(row),
                              })
                            }
                          />
                        )}
                      </div>
                    </th>
                    {row.cells.map((cell, c) => (
                      <td
                        key={cell.day}
                        ref={(el) => {
                          if (el) cells.current.set(`${r}:${c}`, el);
                          else cells.current.delete(`${r}:${c}`);
                        }}
                        tabIndex={at.row === r && at.col === c ? 0 : -1}
                        aria-label={`${name}, ${dayLabel(cell.day)}: ${sumsText(cell, true)}`}
                        aria-haspopup="dialog"
                        className="cursor-pointer px-2 py-2.5 outline-none hover:bg-sunk focus-visible:bg-accsoft focus-visible:ring-2 focus-visible:ring-acc focus-visible:ring-inset"
                        onFocus={() => setActive({ row: r, col: c })}
                        onClick={() => setOpen({ key: row.key, day: cell.day })}
                        onKeyDown={(e) => onKeyDown(e, { row: r, col: c }, row.key, cell.day)}
                        onKeyUp={(e) => {
                          if (e.key === " ") setOpen({ key: row.key, day: cell.day });
                        }}
                      >
                        <Figures sums={cell} />
                      </td>
                    ))}
                    <td
                      className="px-4 py-2.5"
                      aria-label={`${name}, week: ${sumsText(row, false)}`}
                    >
                      <Total sums={row} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-sunk">
              <tr>
                <th scope="row" className="px-4 py-2.5 text-left font-semibold">
                  Total
                </th>
                {grid.dayTotals.map((d, i) => (
                  <td
                    key={days[i]}
                    className="px-2 py-2.5"
                    aria-label={`${dayLabel(days[i] ?? week)}: ${sumsText(d, false)}`}
                  >
                    <Total sums={d} />
                  </td>
                ))}
                <td className="px-4 py-2.5" aria-label={`Week: ${sumsText(grid.total, false)}`}>
                  <Total sums={grid.total} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <dialog
        ref={cellRef}
        aria-labelledby="week-grid-cell-title"
        className={dialogClass}
        onClose={() => setOpen(null)}
      >
        <h2 id="week-grid-cell-title" className="mb-4 text-lg font-semibold">
          {openRow && openCell ? `${label(openRow)} · ${dayLabel(openCell.day)}` : "Cell"}
        </h2>
        {openRow && openCell && (
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-ink2">
              {formatDuration(openCell.tracked)} tracked · {formatDuration(openCell.manual)} manual
              {openCell.pending > 0 &&
                ` · ${formatDuration(openCell.pending)} pending, not counted`}
              .
            </p>
            <section aria-labelledby="week-grid-cell-tracked" className="flex flex-col gap-1">
              <h3 id="week-grid-cell-tracked" className="text-[13.5px] font-semibold">
                Tracked
              </h3>
              {segments.error ? (
                <p role="alert" className="text-sm text-warnink">
                  Couldn't load tracked time: {segments.error.message}
                </p>
              ) : (
                <CellRuns
                  runs={trackedRuns(
                    (segments.data ?? []).filter(
                      (s) =>
                        s.day === openCell.day &&
                        s.projectId === openRow.projectId &&
                        (openRow.projectId === null || s.taskId === openRow.taskId),
                    ),
                  )}
                  zone={zone}
                  loading={!enabled || segments.isPending}
                />
              )}
            </section>
            <section aria-labelledby="week-grid-cell-manual" className="flex flex-col gap-1">
              <h3 id="week-grid-cell-manual" className="text-[13.5px] font-semibold">
                Manual entries
              </h3>
              {openCell.entries.length === 0 ? (
                <p className="text-[13px] text-ink3">No manual entries.</p>
              ) : (
                <ul>
                  {openCell.entries.map((e) => (
                    <li
                      key={e.id}
                      className="flex flex-col gap-1 border-b border-line py-2 text-[13.5px] last:border-0"
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-mono text-[13px]">
                          <Time iso={e.startAt} employeeZone={zone} />–
                          <Time iso={e.endAt} employeeZone={zone} />
                        </span>
                        <span className="font-mono text-[13px] text-ink2">
                          {formatDuration((Date.parse(e.endAt) - Date.parse(e.startAt)) / 1000)}
                        </span>
                        <span
                          className={cn(
                            "text-xs font-medium",
                            e.status === "pending" ? "text-warnink" : "text-ink2",
                          )}
                        >
                          {statusText[e.status]}
                        </span>
                        {canEdit && e.status !== "rejected" && (
                          <Button
                            variant="secondary"
                            className="ml-auto h-8 px-3 text-[12.5px]"
                            aria-label={`Edit ${formatTime(e.startAt, viewerZone())}–${formatTime(e.endAt, viewerZone())}`}
                            onClick={() => setEditTarget(e)}
                          >
                            Edit
                          </Button>
                        )}
                      </div>
                      {e.note && (
                        <p className="text-[13px] whitespace-pre-line text-ink2">{e.note}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {canEdit && openCell.day > today && (
              <p className="text-[13px] text-ink2">You can add time once the day has started.</p>
            )}
            {canEdit && !canLog(openRow) && (
              <p className="text-[13px] text-ink2">You can't log new time to this project.</p>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="ml-auto"
                onClick={() => cellRef.current?.close()}
              >
                Close
              </Button>
              {canEdit && openCell.day <= today && canLog(openRow) && (
                <Button
                  type="button"
                  onClick={() =>
                    setRequestTarget({
                      day: openCell.day,
                      projectId: openRow.projectId,
                      taskId: openRow.taskId,
                    })
                  }
                >
                  Add entry
                </Button>
              )}
            </div>
          </div>
        )}
      </dialog>

      {canEdit && (
        <>
          <RequestDialog
            dialogRef={requestRef}
            userId={userId}
            zone={zone}
            date={requestTarget?.day ?? today}
            target={requestTarget}
            onClose={() => setRequestTarget(null)}
            onRequested={onChanged}
          />
          <EditDialog
            dialogRef={editRef}
            target={editTarget}
            zone={zone}
            tasks={tasks}
            projectName={(id) => label({ projectId: id, taskId: null })}
            onClose={() => setEditTarget(null)}
            onSubmit={async (entry, v) => {
              await editEntry(entry.id, v);
              await onChanged();
            }}
          />
          <AddRowDialog
            dialogRef={addRowRef}
            projects={mine}
            tasks={tasks}
            onAdd={(a) => {
              const rows = [...(added[week] ?? []), a];
              setAdded((all) => ({ ...all, [week]: rows }));
              // Then focus the row's cell for today (or the week's first day).
              const row = weekGrid(
                days,
                breakdown,
                entries,
                zone,
                extraRows(rows),
                label,
              ).rows.findIndex((r) => r.projectId === a.projectId && r.taskId === a.taskId);
              const pos = { row, col: Math.max(days.indexOf(today), 0) };
              setActive(pos);
              setFocusNext(pos);
            }}
          />
          <CopyWeekDialog
            dialogRef={copyRef}
            open={copying}
            userId={userId}
            week={week}
            zone={zone}
            lastWeekAdded={added[addWeeks(week, -1)] ?? []}
            label={label}
            canLog={loggable}
            onCopyRows={(rows) =>
              setAdded((all) => ({ ...all, [week]: [...(all[week] ?? []), ...rows] }))
            }
            onChanged={onChanged}
            onClose={() => setCopying(false)}
          />
        </>
      )}
    </section>
  );
}

/** Pins or unpins a row: a star toggle, pressed (filled) while the row is pinned. */
function PinButton({
  name,
  pinned,
  onClick,
}: {
  name: string;
  pinned: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Pin ${name}`}
      aria-pressed={pinned}
      title={pinned ? "Pinned to every week: select to unpin" : "Pin to every week"}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 flex-none items-center justify-center rounded-md text-[15px] leading-none hover:bg-sunk",
        pinned ? "text-acctext before:content-['★']" : "text-ink3 before:content-['☆']",
      )}
    />
  );
}

/** A cell's figures: tracked time, then manual and pending time when there is any. */
function Figures({ sums }: { sums: GridSums }) {
  if (sums.tracked === 0 && sums.manual === 0 && sums.pending === 0) {
    return <span className="text-ink3">—</span>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {sums.tracked > 0 && (
        <span className="font-mono text-[13px]">{formatDuration(sums.tracked)}</span>
      )}
      {sums.manual > 0 && (
        <span className="text-xs text-ink2">{formatDuration(sums.manual)} manual</span>
      )}
      {sums.pending > 0 && (
        <span className="text-xs text-warnink">{formatDuration(sums.pending)} pending</span>
      )}
    </div>
  );
}

/** A total: the worked time, with pending time under it when there is any. */
function Total({ sums }: { sums: GridSums }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={cn("font-mono text-[13px] font-semibold", sums.total === 0 && "text-ink3")}>
        {sums.total > 0 ? formatDuration(sums.total) : "—"}
      </span>
      {sums.pending > 0 && (
        <span className="text-xs text-warnink">{formatDuration(sums.pending)} pending</span>
      )}
    </div>
  );
}

function CellRuns({
  runs,
  zone,
  loading,
}: {
  runs: ReturnType<typeof trackedRuns>;
  zone: string;
  loading: boolean;
}) {
  if (runs.length === 0) {
    return <p className="text-[13px] text-ink3">{loading ? "Loading…" : "No tracked time."}</p>;
  }
  return (
    <ul>
      {runs.map((run) => (
        <li
          key={run.startAt}
          className="flex flex-wrap items-center gap-x-3 border-b border-line py-2 text-[13.5px] last:border-0"
        >
          <span className="font-mono text-[13px]">
            <Time iso={run.startAt} employeeZone={zone} />–
            <Time iso={run.endAt} employeeZone={zone} />
          </span>
          <span className="font-mono text-[13px] text-ink2">{formatDuration(run.seconds)}</span>
          <span className="ml-auto text-xs font-medium text-ink2">
            {run.excluded ? "Excluded" : run.flagged ? "Flagged" : "Tracked"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "Add a row": a project the employee can log to, and one of its tasks. */
function AddRowDialog({
  dialogRef,
  projects,
  tasks,
  onAdd,
}: {
  dialogRef: Ref;
  projects: Project[];
  tasks: Task[];
  onAdd: (a: GridAssignment) => void;
}) {
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="week-grid-row-title"
      className={dialogClass}
      onClose={() => {
        setProjectId("");
        setTaskId("");
        setProblem(null);
      }}
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!projectId) {
            setProblem("Choose a project.");
            return;
          }
          onAdd({ projectId, taskId: taskId || null });
          dialogRef.current?.close();
        }}
      >
        <h2 id="week-grid-row-title" className="text-lg font-semibold">
          Add a row
        </h2>
        <p className="text-[13px] text-ink2">
          A project you can log time to, and a task of it. The row stays empty until you add time in
          it.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="week-grid-row-project">Project</Label>
          <select
            id="week-grid-row-project"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setTaskId("");
            }}
            className={fieldClass}
          >
            <option value="">Choose a project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <TaskSelect
          id="week-grid-row-task"
          tasks={tasks}
          projectId={projectId || null}
          value={taskId}
          onChange={setTaskId}
          className={fieldClass}
        />
        {problem && (
          <p role="alert" className="text-sm text-warnink">
            {problem}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            className="ml-auto"
            onClick={() => dialogRef.current?.close()}
          >
            Cancel
          </Button>
          <Button type="submit">Add row</Button>
        </div>
      </form>
    </dialog>
  );
}
