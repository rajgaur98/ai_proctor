// The Timesheets tab (#43, DSH-06): the timesheets of the people the viewer manages
// (or, for admins, everyone), by week and status; open one to review, edit, approve
// or return it, and the Delegation section (#44). Employees get their own weeks with
// Submit (MyTimesheets). #266: each timesheet's billable and non-billable time, and
// totals by client, project and task for the timesheets shown, with overtime (TS-29).
import {
  billingCatalog,
  EXPORT_FORMATS,
  type ExportFormat,
  isOver,
  thresholdLabel,
  workTotals,
} from "@ai-proctor/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useRef, useState } from "react";
import { ExportButton } from "../../components/ExportButton";
import { Button } from "../../components/ui/button";
import { supabase } from "../../lib/supabase";
import { Delegation } from "../delegation/Delegation";
import { clientsQuery, projectsQuery, tasksQuery } from "../projects/projectData";
import { ExportDialog } from "./ExportDialog";
import { downloadExport, exportFormatLabel } from "./exportData";
import { OvertimeNote, WorkedTime } from "./Overtime";
import { LateDataBadge, SheetStatusChip } from "./SheetStatusChip";
import { sheetListTable } from "./sheetExport";
import { formatDuration } from "./summary";
import { OvertimeChips, TotalsPanel, totalsNames } from "./Totals";
import {
  ensureAndSubmit,
  overtimeQuery,
  type SheetStatus,
  sheetColumns,
  statusLabel,
  type Timesheet,
  toTimesheet,
  weekListQuery,
  weekStartQuery,
} from "./timesheetData";
import { addWeeks, recentWeeks, weekDays, weekLabel, weekStartOf } from "./weeks";

const statuses: SheetStatus[] = ["submitted", "returned", "approved", "draft"];

export function Timesheets() {
  const { profile } = useRouteContext({ from: "/_app" });
  const startDay = useQuery(weekStartQuery);
  const currentWeek = weekStartOf(
    DateTime.now().setZone(profile.timezone).toISODate() ?? "",
    startDay.data ?? 1,
  );
  const [picked, setPicked] = useState<string | null>(null);
  const week = picked ?? currentWeek;
  const [status, setStatus] = useState<SheetStatus | "all">("all");
  const exportRef = useRef<HTMLDialogElement>(null);
  const overtime = useQuery(overtimeQuery).data;
  const projects = useQuery(projectsQuery);
  const tasks = useQuery(tasksQuery);
  const clients = useQuery(clientsQuery);

  const list = useQuery({ ...weekListQuery(week), enabled: startDay.isSuccess });
  const rows = (list.data ?? [])
    .filter((r) => status === "all" || r.status === status)
    // Waiting for a decision first.
    .sort(
      (a, b) =>
        statuses.indexOf(a.status) - statuses.indexOf(b.status) ||
        a.fullName.localeCompare(b.fullName),
    );
  // Billable needs the projects' and tasks' flags; until they load it shows as loading.
  const catalog = projects.data && tasks.data ? billingCatalog(projects.data, tasks.data) : null;
  const shownTotals = workTotals(
    rows.flatMap((r) => r.assigned),
    catalog ?? billingCatalog([], []),
  );
  const weeklyHours = overtime?.weeklyHours ?? null;
  const over = weeklyHours ? rows.filter((r) => isOver(r.workedS, weeklyHours)).length : 0;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">Timesheets</h1>
          <p className="mt-1 text-[13.5px] text-ink2">{profile.orgName}</p>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <Link
            to="/timesheets/$userId"
            params={{ userId: profile.id }}
            className="text-[13.5px] text-acctext"
          >
            Open my own week
          </Link>
          <Button
            variant="secondary"
            className="h-10"
            onClick={() => exportRef.current?.showModal()}
          >
            Export
          </Button>
        </div>
      </div>
      <ExportDialog
        key={week}
        dialogRef={exportRef}
        defaultFrom={week}
        defaultTo={weekDays(week)[6] ?? week}
      />

      <Delegation />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" className="h-10" onClick={() => setPicked(addWeeks(week, -1))}>
          Previous week
        </Button>
        <span className="min-w-28 text-center text-[13.5px] font-medium" aria-live="polite">
          {weekLabel(week)}
        </span>
        <Button
          variant="secondary"
          className="h-10"
          disabled={week >= currentWeek}
          onClick={() => setPicked(addWeeks(week, 1))}
        >
          Next week
        </Button>
        <label className="ml-auto flex h-10 items-center gap-2 rounded-[9px] border border-line2 bg-panel px-3 text-[13.5px]">
          <span className="text-ink3">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as SheetStatus | "all")}
            className="bg-transparent font-medium"
          >
            <option value="all">All</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {statusLabel[s]}
              </option>
            ))}
          </select>
        </label>
        {/* #255: the rows below as shown (the Export above is the timesheet export). */}
        <ExportButton
          title="Timesheet list"
          className="h-10"
          ready={list.isSuccess && !!catalog}
          spec={{
            page: "timesheets",
            filters: { week, status: status === "all" ? "" : statusLabel[status] },
            table: () =>
              sheetListTable(
                rows,
                week,
                catalog ?? billingCatalog([], []),
                weeklyHours,
                statusLabel,
              ),
          }}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {list.error ? (
          <p role="alert" className="p-6 text-sm text-warnink">
            Couldn't load timesheets: {list.error.message}
          </p>
        ) : list.isPending ? (
          <p className="p-6 text-sm text-ink2">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <p className="text-base font-semibold">No timesheets here</p>
            <p className="max-w-[380px] text-[13.5px] text-ink2">
              A week appears once the person opens or submits it.
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse text-[13.5px]">
            <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
              <tr className="h-10 border-b border-line">
                <th className="px-5 font-medium">Person</th>
                <th className="font-medium">Status</th>
                <th className="font-medium">Worked</th>
                <th className="font-medium">Billable</th>
                <th className="font-medium">Non-billable</th>
                <th className="font-medium">Flagged</th>
                <th className="pr-5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const split = catalog ? workTotals(r.assigned, catalog) : null;
                return (
                  <tr
                    key={r.id}
                    className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:h-14 md:p-0"
                  >
                    <td className="md:px-5">
                      <Link
                        to="/timesheets/$userId"
                        params={{ userId: r.userId }}
                        search={{ week }}
                        className="font-medium"
                      >
                        {r.fullName}
                      </Link>
                    </td>
                    <td>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <SheetStatusChip sheet={r} />
                        <LateDataBadge sheet={r} />
                      </span>
                    </td>
                    <td className="font-mono text-[13px]">
                      <WorkedTime
                        seconds={r.workedS}
                        thresholdHours={overtime?.weeklyHours ?? null}
                        period="weekly"
                      />
                    </td>
                    <td className="font-mono text-[13px]">
                      <span className="font-sans text-ink3 md:hidden">Billable </span>
                      {split ? formatDuration(split.billable) : "…"}
                    </td>
                    <td className="font-mono text-[13px]">
                      <span className="font-sans text-ink3 md:hidden">Non-billable </span>
                      {split ? formatDuration(split.nonBillable) : "…"}
                    </td>
                    <td className="font-mono text-[13px]">
                      {r.flaggedS > 0 ? formatDuration(r.flaggedS) : "—"}
                    </td>
                    <td className="md:pr-5 md:text-right">
                      <Link
                        to="/timesheets/$userId"
                        params={{ userId: r.userId }}
                        search={{ week }}
                        aria-label={`${r.status === "submitted" ? "Review" : "Open"} ${r.fullName}'s timesheet`}
                        className="text-acctext"
                      >
                        {r.status === "submitted" ? "Review" : "Open"}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {!list.error && !list.isPending && rows.length > 0 && (
        <TotalsPanel
          id="list-totals"
          title="Totals"
          description={`The ${rows.length} ${rows.length > 1 ? "timesheets" : "timesheet"} shown, ${weekLabel(week)}.`}
          totals={shownTotals}
          names={totalsNames(clients.data ?? [], projects.data ?? [], tasks.data ?? [])}
          overtime={
            <OvertimeChips
              items={
                over > 0 && weeklyHours
                  ? [
                      `${over} ${over > 1 ? "people" : "person"} above the ${thresholdLabel(weeklyHours)} weekly threshold`,
                    ]
                  : []
              }
            />
          }
          loading={!catalog || clients.isPending}
          exportAs={{
            page: "timesheet-totals",
            filters: { week, status: status === "all" ? "" : statusLabel[status] },
          }}
        />
      )}
      <OvertimeNote overtime={overtime} weeklyOnly />
    </section>
  );
}

/** An employee's own recent weeks, each with its status and Submit (TS-11). */
export function MyTimesheets() {
  const { profile } = useRouteContext({ from: "/_app" });
  const queryClient = useQueryClient();
  const startDay = useQuery(weekStartQuery);
  const today = DateTime.now().setZone(profile.timezone).toISODate() ?? "";
  const weeks = recentWeeks(today, startDay.data ?? 1, 8);
  const oldest = weeks.at(-1) ?? today;

  const mine = useQuery({
    queryKey: ["timesheet-mine", profile.id, oldest],
    enabled: startDay.isSuccess,
    queryFn: async (): Promise<Map<string, Timesheet>> => {
      const { data, error } = await supabase
        .from("timesheets")
        .select(sheetColumns)
        .eq("user_id", profile.id)
        .gte("period_start", oldest);
      if (error) throw error;
      return new Map(data.map((r) => [r.period_start, toTimesheet(r)]));
    },
  });
  const submit = useMutation({
    mutationFn: (week: string) => ensureAndSubmit(profile.id, week, profile.timezone),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["timesheet-mine", profile.id] }),
  });
  // Employees can export their own time (TS-20, EMP-04); the function checks and logs it.
  const exportWeek = useMutation({
    mutationFn: ({ week, format }: { week: string; format: ExportFormat }) =>
      downloadExport({
        view: "daily",
        format,
        from: week,
        to: weekDays(week).at(-1) ?? week,
        userId: profile.id,
        teamId: "",
        clientId: "",
        projectId: "",
        status: "",
      }),
  });

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-[-0.025em]">My timesheet</h1>
        <p className="mt-1 text-[13.5px] text-ink2">
          Submit a week when it's done. Your manager reviews it and any edits they make show here
          with their reasons.
        </p>
      </div>
      {(mine.error || submit.error || exportWeek.error) && (
        <p role="alert" className="text-sm text-warnink">
          {(mine.error ?? submit.error ?? exportWeek.error)?.message}
        </p>
      )}
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <ul>
          {weeks.map((w) => {
            const sheet: Timesheet = mine.data?.get(w) ?? {
              id: "",
              userId: profile.id,
              periodStart: w,
              status: "draft",
              submittedAt: null,
              approvedAt: null,
              returnedAt: null,
              comment: null,
              lateDataAt: null,
              lateDataLastAt: null,
              lateDataCount: 0,
            };
            const canSubmit = sheet.status === "draft" || sheet.status === "returned";
            return (
              <li
                key={w}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3 text-[13.5px] last:border-0"
              >
                <Link
                  to="/timesheets/$userId"
                  params={{ userId: profile.id }}
                  search={{ week: w }}
                  className="min-w-32 font-medium"
                >
                  {weekLabel(w)}
                </Link>
                <SheetStatusChip sheet={sheet} />
                {sheet.status === "returned" && sheet.comment && (
                  <span className="text-ink2">“{sheet.comment}”</span>
                )}
                <span className="ml-auto flex gap-2">
                  {EXPORT_FORMATS.map((format) => (
                    <Button
                      key={format}
                      variant="ghost"
                      className="h-9"
                      aria-label={`Download ${weekLabel(w)} as ${exportFormatLabel[format]}`}
                      disabled={exportWeek.isPending}
                      onClick={() => exportWeek.mutate({ week: w, format })}
                    >
                      {exportFormatLabel[format]}
                    </Button>
                  ))}
                  {canSubmit && (
                    <Button
                      variant="secondary"
                      className="h-9"
                      aria-label={`Submit ${weekLabel(w)}`}
                      disabled={submit.isPending}
                      onClick={() => submit.mutate(w)}
                    >
                      Submit
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
