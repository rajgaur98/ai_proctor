// Time off (#304, LV-01..03): everyone asks for time off and sees their own requests;
// the direct manager or their active delegate approves or declines (owners and admins who
// aren't the manager only read, TS-12); owners and admins also keep the leave types and
// the holiday calendar here. Who may decide or cancel each row comes from the database.
// #319 (LV-06): the requests are filtered by date range, status and, for anyone who sees
// other people, person and team; the export holds what the filters show (TS-28).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useId, useMemo, useState } from "react";
import { ExportButton } from "../../components/ExportButton";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { yesNo } from "../../lib/exportFile";
import { teamsQuery } from "../teams/teamData";
import { exportPeopleQuery } from "../timesheets/exportData";
import { HolidaysPanel, LeaveTypesPanel } from "./LeaveSettings";
import { leaveLength, leaveStatusLabel, leaveWhen, statusLabel } from "./leaveText";
import { RequestDialog } from "./RequestDialog";
import { TeamCalendar } from "./TeamCalendar";
import {
  cancelLeave,
  decideLeave,
  type LeaveFilters,
  type LeaveRequest,
  leaveRequestsQuery,
} from "./timeOffData";

type Tab = "requests" | "types" | "holidays";
const tabLabel: Record<Tab, string> = {
  requests: "Requests",
  types: "Leave types",
  holidays: "Holidays",
};

/** The list starts with requests whose last day is at most this many days back. */
const LOOK_BACK_DAYS = 60;

const selectClass = "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink";

export function TimeOff() {
  const { profile } = useRouteContext({ from: "/_app" });
  const admin = profile.role === "owner" || profile.role === "admin";
  const seesOthers = profile.role !== "employee";
  const [tab, setTab] = useState<Tab>("requests");
  const [asking, setAsking] = useState(false);
  const defaultFrom =
    DateTime.now().setZone(profile.timezone).minus({ days: LOOK_BACK_DAYS }).toISODate() ?? "";
  const [filters, setFilters] = useState<Required<LeaveFilters>>({
    from: defaultFrom,
    to: "",
    userId: "",
    teamId: "",
    status: "",
  });
  const set = (k: keyof LeaveFilters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const filtered =
    filters.from !== defaultFrom ||
    !!(filters.to || filters.userId || filters.teamId || filters.status);
  const badRange = !!filters.from && !!filters.to && filters.to < filters.from;
  const requests = useQuery({ ...leaveRequestsQuery(filters), enabled: !badRange });
  const people = useQuery({ ...exportPeopleQuery, enabled: seesOthers });
  const teams = useQuery({ ...teamsQuery, enabled: seesOthers });
  const rows = requests.data ?? [];
  const toDecide = rows.filter((r) => r.canDecide);
  const mine = rows.filter((r) => r.userId === profile.id);
  const others = rows.filter((r) => r.userId !== profile.id && !r.canDecide);
  const personName = (people.data ?? []).find((p) => p.id === filters.userId)?.full_name ?? "";
  const teamName = (teams.data ?? []).find((t) => t.id === filters.teamId)?.name ?? "";
  // Someone else picked: their requests, not the viewer's own list.
  const showMine = !filters.userId || filters.userId === profile.id;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">Time off</h1>
          <p className="mt-1 text-[13.5px] text-ink2">{profile.orgName}</p>
        </div>
        <div className="ml-auto flex gap-2">
          {tab === "requests" && (
            <ExportButton
              title="Time off"
              ready={!badRange && !requests.isPending && !requests.error}
              spec={{
                page: "time-off",
                filters: {
                  from: filters.from,
                  to: filters.to,
                  person: personName,
                  team: teamName,
                  status: filters.status ? statusLabel(filters.status) : "",
                },
                table: () => ({
                  sheet: "Time off",
                  header: [
                    "Person",
                    "Type",
                    "Paid",
                    "First day",
                    "Last day",
                    "When",
                    "Length",
                    "Status",
                    "Decided by",
                    "Note",
                  ],
                  rows: rows.map((r) => [
                    r.employeeName,
                    r.typeName,
                    yesNo(r.paid),
                    r.firstDay,
                    r.lastDay,
                    leaveWhen(r),
                    leaveLength(r),
                    statusLabel(r.status),
                    r.decidedByName ?? "",
                    r.note ?? "",
                  ]),
                }),
              }}
            />
          )}
          <Button onClick={() => setAsking(true)}>Request time off</Button>
        </div>
      </div>

      {admin && (
        <fieldset className="m-0 flex gap-2 border-0 p-0">
          <legend className="sr-only">Show</legend>
          {(Object.keys(tabLabel) as Tab[]).map((t) => (
            <Button
              key={t}
              variant={tab === t ? "primary" : "secondary"}
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
            >
              {tabLabel[t]}
            </Button>
          ))}
        </fieldset>
      )}

      {tab === "requests" && (
        <fieldset className="m-0 flex flex-wrap items-end gap-3 border-0 p-0">
          <legend className="sr-only">Filter requests</legend>
          <div className="flex w-40 flex-col gap-1.5">
            <Label htmlFor="leave-from">From</Label>
            <Input
              id="leave-from"
              type="date"
              value={filters.from}
              onChange={(e) => set("from")(e.target.value)}
            />
          </div>
          <div className="flex w-40 flex-col gap-1.5">
            <Label htmlFor="leave-to">To</Label>
            <Input
              id="leave-to"
              type="date"
              value={filters.to}
              onChange={(e) => set("to")(e.target.value)}
            />
          </div>
          {seesOthers && (
            <div className="flex w-52 flex-col gap-1.5">
              <Label htmlFor="leave-person">Person</Label>
              <select
                id="leave-person"
                value={filters.userId}
                onChange={(e) => set("userId")(e.target.value)}
                className={selectClass}
              >
                <option value="">Everyone I can see</option>
                {(people.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {seesOthers && (
            <div className="flex w-44 flex-col gap-1.5">
              <Label htmlFor="leave-team">Team</Label>
              <select
                id="leave-team"
                value={filters.teamId}
                onChange={(e) => set("teamId")(e.target.value)}
                className={selectClass}
              >
                <option value="">All teams</option>
                {(teams.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex w-40 flex-col gap-1.5">
            <Label htmlFor="leave-status">Status</Label>
            <select
              id="leave-status"
              value={filters.status}
              onChange={(e) => set("status")(e.target.value)}
              className={selectClass}
            >
              <option value="">Any status</option>
              {Object.entries(leaveStatusLabel).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {filtered && (
            <Button
              variant="secondary"
              className="h-11"
              onClick={() =>
                setFilters({ from: defaultFrom, to: "", userId: "", teamId: "", status: "" })
              }
            >
              Clear filters
            </Button>
          )}
          {badRange && (
            <p role="alert" className="basis-full text-sm text-warnink">
              The end date is before the start date.
            </p>
          )}
        </fieldset>
      )}

      {tab === "types" ? (
        <LeaveTypesPanel />
      ) : tab === "holidays" ? (
        <HolidaysPanel />
      ) : badRange ? null : requests.error ? (
        <p role="alert" className="rounded-xl border border-line bg-panel p-6 text-sm text-warnink">
          Couldn't load time off: {requests.error.message}
        </p>
      ) : requests.isPending ? (
        <p className="rounded-xl border border-line bg-panel p-6 text-sm text-ink2">Loading…</p>
      ) : (
        <>
          {toDecide.length > 0 && (
            <RequestTable
              title="To decide"
              note="Requests from your team waiting for you."
              rows={toDecide}
              showPerson
            />
          )}
          {seesOthers && <TeamCalendar zone={profile.timezone} />}
          {showMine && (
            <RequestTable
              title="Your time off"
              note={`Dates are your own (${profile.timezone}). A pending request, or an approved one that hasn't started, can be cancelled.`}
              rows={mine}
              empty={
                filtered
                  ? "None of your requests match the filters."
                  : "You haven't asked for time off yet."
              }
            />
          )}
          {(others.length > 0 || (filtered && !showMine)) && (
            <RequestTable
              title={admin ? "Everyone" : "Your team"}
              note="Time off of the people you can see. Only their manager or the manager's delegate decides."
              rows={others}
              showPerson
              empty="No requests match the filters."
            />
          )}
        </>
      )}

      {asking && <RequestDialog zone={profile.timezone} onClose={() => setAsking(false)} />}
    </section>
  );
}

function RequestTable({
  title,
  note,
  rows,
  showPerson = false,
  empty,
}: {
  title: string;
  note: string;
  rows: LeaveRequest[];
  showPerson?: boolean;
  empty?: string;
}) {
  const headingId = useId();
  const [declining, setDeclining] = useState<LeaveRequest | null>(null);
  const [cancelling, setCancelling] = useState<LeaveRequest | null>(null);
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["leave-requests"] });
  const approve = useMutation({
    mutationFn: (id: string) => decideLeave(id, true, ""),
    onSettled: refresh,
  });
  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [rows],
  );

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="px-5 pt-4 pb-3">
        <h2 id={headingId} className="text-base font-semibold">
          {title}
        </h2>
        <p className="mt-0.5 text-[12.5px] text-ink3">{note}</p>
      </div>
      {approve.error && (
        <p role="alert" className="px-5 pb-3 text-sm text-warnink">
          {approve.error.message}
        </p>
      )}
      {sorted.length === 0 ? (
        <p className="border-t border-line px-5 py-6 text-sm text-ink2">
          {empty ?? "Nothing here."}
        </p>
      ) : (
        <table aria-labelledby={headingId} className="w-full border-collapse text-[13.5px]">
          <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
            <tr className="h-10 border-y border-line">
              {showPerson && <th className="px-5 font-medium">Person</th>}
              <th className={`font-medium ${showPerson ? "" : "px-5"}`}>Type</th>
              <th className="font-medium">When</th>
              <th className="font-medium">Length</th>
              <th className="font-medium">Status</th>
              <th className="font-medium">Notes</th>
              <th className="pr-5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.id}
                className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:h-14 md:p-0"
              >
                {showPerson && <td className="font-medium md:px-5">{r.employeeName}</td>}
                <td className={showPerson ? "" : "font-medium md:px-5"}>
                  {r.typeName}
                  {r.paid ? "" : <span className="text-ink3"> · unpaid</span>}
                </td>
                <td>{leaveWhen(r)}</td>
                <td className="text-ink2 tabular-nums">{leaveLength(r)}</td>
                <td className={r.status === "pending" ? "font-medium" : "text-ink2"}>
                  {statusLabel(r.status)}
                  {r.decidedByName && r.status !== "pending" && r.status !== "cancelled" && (
                    <span className="block text-xs text-ink3">by {r.decidedByName}</span>
                  )}
                </td>
                <td className="max-w-[280px] text-ink2">
                  {r.note && <span className="block">{r.note}</span>}
                  {r.decisionNote && (
                    <span className="block text-xs text-ink3">Reply: {r.decisionNote}</span>
                  )}
                </td>
                <td className="flex gap-2 md:table-cell md:pr-5 md:text-right">
                  {r.canDecide && (
                    <>
                      <Button
                        className="h-9 md:mr-2"
                        disabled={approve.isPending}
                        aria-label={`Approve ${r.employeeName}'s ${r.typeName}, ${leaveWhen(r)}`}
                        onClick={() => approve.mutate(r.id)}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="secondary"
                        className="h-9"
                        aria-label={`Decline ${r.employeeName}'s ${r.typeName}, ${leaveWhen(r)}`}
                        onClick={() => setDeclining(r)}
                      >
                        Decline
                      </Button>
                    </>
                  )}
                  {r.canCancel && (
                    <Button
                      variant="secondary"
                      className="h-9"
                      aria-label={`Cancel ${r.typeName}, ${leaveWhen(r)}`}
                      onClick={() => setCancelling(r)}
                    >
                      Cancel
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {declining && (
        <ConfirmDialog
          title={`Decline ${declining.employeeName}'s time off?`}
          body={`${declining.typeName}, ${leaveWhen(declining)}. They are told, with your reason if you give one.`}
          noteLabel="Reason (optional)"
          confirmLabel="Decline"
          onConfirm={(note) => decideLeave(declining.id, false, note)}
          onClose={() => {
            setDeclining(null);
            refresh();
          }}
        />
      )}
      {cancelling && (
        <ConfirmDialog
          title="Cancel this request?"
          body={`${cancelling.typeName}, ${leaveWhen(cancelling)}. Your manager is told.`}
          confirmLabel="Cancel request"
          dismissLabel="Keep it"
          onConfirm={() => cancelLeave(cancelling.id)}
          onClose={() => {
            setCancelling(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  noteLabel,
  confirmLabel,
  dismissLabel = "Cancel",
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  /** With a label, the dialog asks for an optional note. */
  noteLabel?: string;
  confirmLabel: string;
  dismissLabel?: string;
  onConfirm: (note: string) => Promise<void>;
  onClose: () => void;
}) {
  const id = useId();
  const [note, setNote] = useState("");
  const send = useMutation({ mutationFn: () => onConfirm(note), onSuccess: onClose });
  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby={`${id}-title`}
      className="m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-[13px] text-ink2">{body}</p>
        {noteLabel && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-note`}>{noteLabel}</Label>
            <textarea
              id={`${id}-note`}
              rows={3}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="rounded-[9px] border border-line2 bg-panel p-3 text-sm text-ink"
            />
          </div>
        )}
        {send.error && (
          <p role="alert" className="text-sm text-warnink">
            {send.error.message}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
            {dismissLabel}
          </Button>
          <Button type="submit" disabled={send.isPending}>
            {send.isPending ? "Saving…" : confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
