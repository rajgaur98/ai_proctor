// One person's week (#43, TS-10..13, TS-18, DSH-06), from the Claude Design Timesheet
// screen. The manager (or delegate) reviews flagged time, decides on manual entries,
// edits with reasons, then approves or returns it; the employee sees the same week
// read-only with the manager's edits and reasons, and submits it. While the week is a
// draft (or returned) the employee also tags Unassigned time and changes the project of
// a day (#139, PRJ-04); the manager sees those as the employee's edits.
import { ReturnComment, TimesheetReason } from "@ai-proctor/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouteContext, useSearch } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { supabase } from "../../lib/supabase";
import { viewerZone } from "../../lib/time";
import { dayEntriesQuery, type ManualEntry } from "../day/entryData";
import { projectsQuery } from "../projects/projectData";
import {
  AdjustDialog,
  type AdjustTarget,
  NoteDialog,
  ProjectDialog,
  ReassignDialog,
  type ReassignTarget,
} from "./dialogs";
import { FlaggedSegments } from "./FlaggedSegments";
import { ProjectTime } from "./ProjectTime";
import { allowedProjects, canReassignWeek, unassignedSpans } from "./reassign";
import { EditsList, WeekEntries } from "./SheetPanels";
import { SheetStatusChip } from "./SheetStatusChip";
import { formatDuration, projectSplit, summarizeWeek } from "./summary";
import {
  adjustTime,
  approveWeek,
  breakdownQuery,
  canDecideQuery,
  canReopenQuery,
  editSegment,
  editsQuery,
  type FlaggedSegment,
  flaggedQuery,
  reassignMyTime,
  rebuildWeek,
  reopenWeek,
  returnWeek,
  segmentsQuery,
  submitWeek,
  timesheetQuery,
  weekStartQuery,
} from "./timesheetData";
import { addWeeks, weekDays, weekLabel, weekStartOf } from "./weeks";

// Pages made by router.tsx's page() aren't in the typed route tree (same as the nav).
const timesheetsPath: string = "/timesheets";
const myTimesheetPath: string = "/my-timesheet";

const mono = "font-mono text-[13px]";

/** Shades for the project split bar, in order of worked time. */
const palette = [
  "var(--ink2)",
  "color-mix(in oklch, var(--ink3) 60%, transparent)",
  "var(--line2)",
  "var(--acc)",
];

export function TimesheetPage() {
  const { userId } = useParams({ from: "/_app/timesheets/$userId" });
  const search = useSearch({ from: "/_app/timesheets/$userId" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile } = useRouteContext({ from: "/_app" });
  const returnRef = useRef<HTMLDialogElement>(null);
  const reopenRef = useRef<HTMLDialogElement>(null);
  const projectRef = useRef<HTMLDialogElement>(null);
  const adjustRef = useRef<HTMLDialogElement>(null);
  const reassignRef = useRef<HTMLDialogElement>(null);
  const [projectTarget, setProjectTarget] = useState<FlaggedSegment | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<AdjustTarget | null>(null);
  const [reassignTarget, setReassignTarget] = useState<ReassignTarget | null>(null);
  // A target is set while its dialog is open (the dialogs clear it when they close), and
  // the dialog opens once the target is rendered into it.
  useEffect(() => {
    if (projectTarget && !projectRef.current?.open) projectRef.current?.showModal();
  }, [projectTarget]);
  useEffect(() => {
    if (adjustTarget && !adjustRef.current?.open) adjustRef.current?.showModal();
  }, [adjustTarget]);
  useEffect(() => {
    if (reassignTarget && !reassignRef.current?.open) reassignRef.current?.showModal();
  }, [reassignTarget]);

  const person = useQuery({
    queryKey: ["timesheet-person", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("users")
        .select("id, full_name, timezone, manager_id")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const startDay = useQuery(weekStartQuery);
  const zone = person.data?.timezone ?? viewerZone();
  const today = DateTime.now().setZone(zone).toISODate() ?? "";
  const currentWeek = startDay.data ? weekStartOf(today, startDay.data) : null;
  const week = search.week ?? currentWeek ?? "";
  const ready = !!person.data && !!week;

  const sheet = useQuery({ ...timesheetQuery(userId, week), enabled: ready });
  // The week's segments are rebuilt when the page opens (LLD section 6), so what the
  // manager reviews is current; the numbers load once that has finished.
  const rebuild = useQuery({
    queryKey: ["timesheet-rebuild", userId, week],
    enabled: ready,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      await rebuildWeek(userId, week, zone);
      return true;
    },
  });
  const fresh = ready && rebuild.status !== "pending";
  const breakdown = useQuery({ ...breakdownQuery(userId, week), enabled: fresh });
  const flagged = useQuery({ ...flaggedQuery(userId, week), enabled: fresh });
  const isSelfView = userId === profile.id;
  const segments = useQuery({
    ...segmentsQuery(userId, week),
    enabled: fresh && isSelfView,
  });
  const edits = useQuery({ ...editsQuery(sheet.data?.id ?? ""), enabled: !!sheet.data });
  const canDecideQ = useQuery(canDecideQuery(userId));
  const canReopenQ = useQuery(canReopenQuery(userId));
  const weekFrom = week ? DateTime.fromISO(week, { zone }) : null;
  const entries = useQuery({
    ...dayEntriesQuery(
      userId,
      weekFrom?.toUTC().toISO() ?? "",
      weekFrom?.plus({ days: 7 }).toUTC().toISO() ?? "",
    ),
    enabled: ready,
  });
  const projects = useQuery(projectsQuery);
  const editorIds = [...new Set((edits.data ?? []).map((e) => e.editorId).filter((id) => !!id))];
  const editors = useQuery({
    queryKey: ["timesheet-editors", editorIds],
    enabled: editorIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("users")
        .select("id, full_name")
        .in("id", editorIds as string[]);
      if (error) throw error;
      return new Map(data.map((u) => [u.id, u.full_name]));
    },
  });

  const refresh = async () => {
    await Promise.all(
      [
        ["timesheet", userId],
        ["timesheet-breakdown", userId],
        ["timesheet-flagged", userId],
        ["timesheet-segments", userId],
        ["timesheet-edits"],
        ["manual-entries", userId],
        ["timesheet-list"],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  };
  const refreshAfterRebuild = async () => {
    // Project edits and reopened weeks only show once their days are rebuilt.
    await rebuildWeek(userId, week, zone).catch(() => undefined);
    await refresh();
  };

  const submit = useMutation({
    mutationFn: async () => {
      if (sheet.data) await submitWeek(sheet.data, zone);
    },
    onSuccess: refresh,
  });
  const approve = useMutation({
    mutationFn: async () => {
      if (sheet.data) await approveWeek(sheet.data.id);
    },
    onSuccess: refresh,
  });

  const go = (w: string) =>
    navigate({ to: "/timesheets/$userId", params: { userId }, search: { week: w } });

  if (person.isPending) return <p className="text-sm text-ink2">Loading…</p>;
  if (!person.data) {
    return (
      <p role="alert" className="text-sm text-ink2">
        This person isn't in your team.{" "}
        <Link to={timesheetsPath} className="text-acctext">
          Back to timesheets
        </Link>
      </p>
    );
  }

  const name = person.data.full_name;
  const first = name.split(" ")[0] ?? name;
  const isSelf = userId === profile.id;
  const canDecide = canDecideQ.data === true;
  const canReopen = canReopenQ.data === true;
  const status = sheet.data?.status;
  const days = weekDays(week);
  const summary = summarizeWeek(breakdown.data ?? [], days);
  const split = projectSplit(summary.total.byProject);
  const color = new Map(split.map((p, i) => [p.projectId, palette[i % palette.length] ?? ""]));
  color.set(null, "var(--line2)");
  const projectName = (id: string | null) =>
    id ? ((projects.data ?? []).find((p) => p.id === id)?.name ?? "Project") : "Unassigned";
  const editorName = (id: string | null) =>
    id === userId
      ? isSelf
        ? "You"
        : name
      : (id && editors.data?.get(id)) || (isSelf ? "Your manager" : "A manager");

  const flaggedList = flagged.data ?? [];
  const entryList = entries.data ?? [];
  const undecided = flaggedList.filter((f) => f.decision === null).length;
  const pendingEntries = entryList.filter((e) => e.status === "pending").length;
  const blockers = [
    undecided ? `${undecided} flagged segment${undecided > 1 ? "s" : ""}` : null,
    pendingEntries ? `${pendingEntries} manual ${pendingEntries > 1 ? "entries" : "entry"}` : null,
  ].filter((b) => !!b);
  const readyToApprove = blockers.length === 0 && !flagged.isPending && !entries.isPending;
  const pendingText = readyToApprove
    ? "Ready to approve"
    : `Decide on ${blockers.join(" and ")} first`;
  const editable = canDecide && status !== undefined && status !== "approved";
  const loadError = sheet.error ?? breakdown.error ?? flagged.error ?? entries.error;
  const canSubmit = isSelf && (status === "draft" || status === "returned") && week <= today;
  const listPath = profile.role === "employee" ? myTimesheetPath : timesheetsPath;
  const canReassign = canReassignWeek(isSelf, status);
  const myProjects = allowedProjects(projects.data ?? [], profile.id);

  const openReassign = setReassignTarget;
  const openAdjust = setAdjustTarget;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-3.5">
        <nav aria-label="Breadcrumb" className="flex gap-1.5 text-[13px] text-ink3">
          <Link to={listPath} className="text-acctext">
            {profile.role === "employee" ? "My timesheet" : "Timesheets"}
          </Link>
          <span aria-hidden>/</span>
          <span className="text-ink2">{name}</span>
        </nav>
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
                {name} · {weekLabel(week)}
              </h1>
              {sheet.data && <SheetStatusChip sheet={sheet.data} withTime />}
            </div>
            <p className="flex flex-wrap items-baseline gap-2 text-[15px]">
              <span className="font-mono font-medium">{formatDuration(summary.total.worked)}</span>
              <span className="text-ink2">worked</span>
              <span className="text-ink3">·</span>
              <span className="font-mono font-medium">{formatDuration(summary.total.flagged)}</span>
              <span className="text-ink2">flagged</span>
              {summary.total.excluded > 0 && (
                <>
                  <span className="text-ink3">·</span>
                  <span className="font-mono font-medium">
                    {formatDuration(summary.total.excluded)}
                  </span>
                  <span className="text-ink2">excluded</span>
                </>
              )}
            </p>
          </div>
          <div className="ml-auto flex flex-col items-end gap-2">
            <div className="flex flex-wrap justify-end gap-2">
              {canDecide && status === "submitted" && (
                <>
                  <Button variant="secondary" onClick={() => returnRef.current?.showModal()}>
                    Return with comment
                  </Button>
                  <Button
                    aria-describedby="approve-note"
                    disabled={!readyToApprove || approve.isPending}
                    onClick={() => approve.mutate()}
                  >
                    Approve week
                  </Button>
                </>
              )}
              {canReopen && status === "approved" && (
                <Button variant="secondary" onClick={() => reopenRef.current?.showModal()}>
                  Reopen week
                </Button>
              )}
              {canSubmit && (
                <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
                  {submit.isPending
                    ? "Submitting…"
                    : status === "returned"
                      ? "Submit again"
                      : "Submit week"}
                </Button>
              )}
            </div>
            <span id="approve-note" className="text-[12.5px] text-ink2">
              {canDecide && status === "submitted"
                ? pendingText
                : canReopen && status === "approved"
                  ? "Approved weeks are locked until reopened."
                  : canDecide
                    ? `Waiting for ${first} to submit.`
                    : canSubmit
                      ? "Your manager reviews the week after you submit it."
                      : !isSelf
                        ? "View only."
                        : ""}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" className="h-10" onClick={() => go(addWeeks(week, -1))}>
            Previous week
          </Button>
          <Button
            variant="secondary"
            className="h-10"
            disabled={!currentWeek || week >= currentWeek}
            onClick={() => go(addWeeks(week, 1))}
          >
            Next week
          </Button>
          {rebuild.isPending && ready && (
            <span className="text-[12.5px] text-ink3" aria-live="polite">
              Refreshing the week…
            </span>
          )}
        </div>
      </div>

      {status === "returned" && sheet.data?.comment && (
        <p
          role="status"
          className="rounded-xl border border-warnline bg-warnbg px-5 py-3 text-[13.5px] text-warnink"
        >
          Returned with a comment: “{sheet.data.comment}”
        </p>
      )}
      {(loadError || submit.error || approve.error) && (
        <p role="alert" className="text-sm text-warnink">
          {(submit.error ?? approve.error ?? loadError)?.message}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-line bg-panel">
        <table className="w-full min-w-[760px] border-collapse text-[13.5px]">
          <thead className="bg-sunk text-left text-xs font-medium text-ink3">
            <tr className="h-10 border-b border-line">
              <th scope="col" className="px-5 font-medium">
                Day
              </th>
              <th scope="col" className="font-medium">
                Worked
              </th>
              <th scope="col" className="font-medium">
                Flagged
              </th>
              <th scope="col" className="font-medium">
                Break
              </th>
              <th scope="col" className="font-medium">
                Manual
              </th>
              <th scope="col" className="pr-5 font-medium">
                Project split
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.days.map((d) => {
              const parts = projectSplit(d.byProject);
              const total = parts.reduce((a, p) => a + p.seconds, 0);
              return (
                <tr key={d.day} className="min-h-14 border-b border-line align-middle">
                  <th scope="row" className="px-5 py-3 text-left font-medium whitespace-nowrap">
                    {d.label}
                  </th>
                  <td className={mono}>{d.worked > 0 ? formatDuration(d.worked) : "—"}</td>
                  <td className={`${mono} ${d.flagged > 0 ? "font-semibold" : "text-ink3"}`}>
                    {d.flagged > 0 ? formatDuration(d.flagged) : "—"}
                  </td>
                  <td className={`${mono} text-ink2`}>
                    {d.breakTime > 0 ? formatDuration(d.breakTime) : "—"}
                  </td>
                  <td className="text-[13px] text-ink2">
                    {d.manual > 0 ? formatDuration(d.manual) : "—"}
                  </td>
                  <td className="py-2 pr-5">
                    {total > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <div
                          aria-hidden
                          className="flex h-1.5 gap-0.5 overflow-hidden rounded-[3px]"
                        >
                          {parts.map((p) => (
                            <span
                              key={p.projectId ?? "none"}
                              className="block"
                              style={{
                                flex: p.seconds / total,
                                background: color.get(p.projectId),
                              }}
                            />
                          ))}
                        </div>
                        <span className="text-xs text-ink2">
                          {parts
                            .map((p) => `${projectName(p.projectId)} ${formatDuration(p.seconds)}`)
                            .join(" · ")}
                        </span>
                        {canReassign && (
                          <Button
                            variant="secondary"
                            className="h-8 self-start px-3 text-[12.5px]"
                            aria-label={`Change project for ${d.label}`}
                            onClick={() => openReassign({ kind: "day", day: d.day })}
                          >
                            Change project
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-sunk font-semibold">
            <tr className="min-h-14">
              <th scope="row" className="px-5 py-3 text-left">
                Total
              </th>
              <td className={mono}>{formatDuration(summary.total.worked)}</td>
              <td className={mono}>{formatDuration(summary.total.flagged)}</td>
              <td className={mono}>{formatDuration(summary.total.breakTime)}</td>
              <td className={mono}>{formatDuration(summary.total.manual)}</td>
              <td className="py-3 pr-5">
                <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px] font-medium">
                  {split.map((p) => (
                    <li key={p.projectId ?? "none"} className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="block h-2.5 w-2.5 rounded-sm"
                        style={{ background: color.get(p.projectId) }}
                      />
                      {projectName(p.projectId)} {formatDuration(p.seconds)}
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        {canDecide ? (
          <FlaggedSegments
            timesheetId={sheet.data?.id ?? ""}
            employeeName={name}
            zone={zone}
            segments={flaggedList}
            projectName={projectName}
            editable={editable}
            onChanged={refresh}
            onChangeProject={setProjectTarget}
          />
        ) : (
          <div className="flex flex-col gap-5">
            {canReassign && (
              <ProjectTime
                spans={unassignedSpans(segments.data ?? [])}
                zone={zone}
                loading={!fresh || segments.isPending}
                hasProjects={myProjects.length > 0}
                onTag={(s) => openReassign({ kind: "span", startAt: s.startAt, endAt: s.endAt })}
              />
            )}
            <EditsList
              heading={isSelf ? "Edits to your time" : "Edits this week"}
              edits={edits.data ?? []}
              zone={zone}
              editorName={editorName}
              projectName={projectName}
              viewerIsEmployee={isSelf}
            />
          </div>
        )}
        <div className="flex flex-col gap-5">
          <WeekEntries
            entries={entryList}
            zone={zone}
            employeeName={name}
            projectName={projectName}
            canDecide={canDecide && status !== "approved"}
            canAdjust={editable}
            onChanged={refresh}
            onAdd={() => {
              const day = DateTime.fromISO(days.includes(today) ? today : (days[0] ?? week), {
                zone,
              });
              openAdjust({
                entryId: null,
                start: day.set({ hour: 9 }).toISO() ?? "",
                end: day.set({ hour: 10 }).toISO() ?? "",
                projectId: null,
              });
            }}
            onAdjust={(e: ManualEntry) =>
              openAdjust({ entryId: e.id, start: e.startAt, end: e.endAt, projectId: e.projectId })
            }
          />
          {canDecide && (
            <EditsList
              heading="Edits so far"
              edits={edits.data ?? []}
              zone={zone}
              editorName={editorName}
              projectName={projectName}
            />
          )}
          {canDecide && (
            <section className="flex flex-col gap-2.5 rounded-xl border border-line bg-panel p-[18px] text-[13px] leading-normal text-ink2">
              <h2 className="text-sm font-semibold text-ink">What {first} will see</h2>
              <p>
                Each exclusion with your reason, your decision on the manual entry, and any comment
                you add when returning the week.
              </p>
            </section>
          )}
        </div>
      </div>

      {canReopen && sheet.data && (
        <NoteDialog
          dialogRef={reopenRef}
          id="reopen"
          title="Reopen week"
          description={
            isSelf
              ? "Unlocks your auto-approved week for changes. It goes back to draft, to submit again, and the reopening is audit-logged."
              : `Unlocks the approved week for changes. It goes back to submitted, the reopening is audit-logged, and ${first} is notified.`
          }
          label="Reason"
          submitLabel="Reopen week"
          schema={TimesheetReason}
          onSubmit={async (text) => {
            await reopenWeek(sheet.data.id, text);
            await refreshAfterRebuild();
          }}
        />
      )}

      {canReassign && (
        <ReassignDialog
          dialogRef={reassignRef}
          zone={zone}
          projects={myProjects}
          target={reassignTarget}
          onClose={() => setReassignTarget(null)}
          onSubmit={async (r) => {
            await reassignMyTime({
              startAt: r.startAt,
              endAt: r.endAt,
              projectId: r.projectId,
              reason: r.note,
            });
            await refreshAfterRebuild();
          }}
        />
      )}

      {canDecide && sheet.data && (
        <>
          <NoteDialog
            dialogRef={returnRef}
            id="return"
            title="Return with comment"
            description={`Sends the week back to ${first} to change and submit again. They see your comment.`}
            label="Comment"
            submitLabel="Return week"
            schema={ReturnComment}
            onSubmit={async (text) => {
              await returnWeek(sheet.data.id, text);
              await refreshAfterRebuild();
            }}
          />
          <ProjectDialog
            dialogRef={projectRef}
            projects={projects.data ?? []}
            target={projectTarget}
            schema={TimesheetReason}
            onClose={() => setProjectTarget(null)}
            onSubmit={async (projectId, reason) => {
              if (!projectTarget) return;
              await editSegment({
                timesheetId: sheet.data.id,
                kind: "project",
                startAt: projectTarget.startAt,
                endAt: projectTarget.endAt,
                projectId,
                reason,
              });
              await refreshAfterRebuild();
            }}
          />
          <AdjustDialog
            dialogRef={adjustRef}
            zone={zone}
            days={days}
            target={adjustTarget}
            projects={projects.data ?? []}
            schema={TimesheetReason}
            onClose={() => setAdjustTarget(null)}
            onSubmit={async (r, entryId) => {
              await adjustTime(sheet.data.id, r, entryId);
              await refreshAfterRebuild();
            }}
          />
        </>
      )}
    </section>
  );
}
