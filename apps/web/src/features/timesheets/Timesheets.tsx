// The Timesheets tab (#43, DSH-06): the timesheets of the people the viewer manages
// (or, for admins, everyone), by week and status; open one to review, edit, approve
// or return it, and the Delegation section (#44). Employees get their own weeks with
// Submit (MyTimesheets).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { supabase } from "../../lib/supabase";
import { Delegation } from "../delegation/Delegation";
import { ExportDialog } from "./ExportDialog";
import { SheetStatusChip } from "./SheetStatusChip";
import { formatDuration } from "./summary";
import {
  ensureAndSubmit,
  type SheetStatus,
  statusLabel,
  type Timesheet,
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

  const list = useQuery({ ...weekListQuery(week), enabled: startDay.isSuccess });
  const rows = (list.data ?? [])
    .filter((r) => status === "all" || r.status === status)
    // Waiting for a decision first.
    .sort(
      (a, b) =>
        statuses.indexOf(a.status) - statuses.indexOf(b.status) ||
        a.fullName.localeCompare(b.fullName),
    );

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
            Export CSV
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
                <th className="font-medium">Flagged</th>
                <th className="pr-5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
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
                    <SheetStatusChip sheet={r} />
                  </td>
                  <td className="font-mono text-[13px]">{formatDuration(r.workedS)}</td>
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
              ))}
            </tbody>
          </table>
        )}
      </div>
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
        .select(
          "id, user_id, period_start, status, submitted_at, approved_at, returned_at, comment",
        )
        .eq("user_id", profile.id)
        .gte("period_start", oldest);
      if (error) throw error;
      return new Map(
        data.map((r) => [
          r.period_start,
          {
            id: r.id,
            userId: r.user_id,
            periodStart: r.period_start,
            status: r.status as SheetStatus,
            submittedAt: r.submitted_at,
            approvedAt: r.approved_at,
            returnedAt: r.returned_at,
            comment: r.comment,
          },
        ]),
      );
    },
  });
  const submit = useMutation({
    mutationFn: (week: string) => ensureAndSubmit(profile.id, week, profile.timezone),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["timesheet-mine", profile.id] }),
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
      {(mine.error || submit.error) && (
        <p role="alert" className="text-sm text-warnink">
          {(mine.error ?? submit.error)?.message}
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
