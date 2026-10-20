// The right column of My data (#49): who viewed my captures (EMP-03) and my timesheet
// for the week of the day shown, with Submit (#43's submit) and the manager's edits
// with their reasons (EMP-02, TS-13).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { Button } from "../../components/ui/button";
import { initials } from "../../lib/nav";
import { viewerZone } from "../../lib/time";
import { projectsQuery } from "../projects/projectData";
import { SheetStatusChip } from "../timesheets/SheetStatusChip";
import { formatDuration, summarizeWeek } from "../timesheets/summary";
import {
  breakdownQuery,
  rebuildWeek,
  submitWeek,
  timesheetQuery,
  weekStartQuery,
} from "../timesheets/timesheetData";
import { weekDays, weekLabel, weekStartOf } from "../timesheets/weeks";
import { type CaptureView, minutesText, recentViews, viewerLabel, whenLabel } from "./helpers";
import { type MyEdit, myEditsQuery, unassignedQuery } from "./queries";

// Pages made by router.tsx's page() aren't in the typed route tree (same as the nav).
const myTimesheetPath: string = "/my-timesheet";

const card = "overflow-hidden rounded-xl border border-line bg-panel";

export function SidePanels({
  userId,
  zone,
  date,
  manager,
  views,
  now,
}: {
  userId: string;
  zone: string;
  date: string;
  manager: string | null;
  views: { data: CaptureView[] | undefined; error: Error | null; pending: boolean };
  now: number;
}) {
  return (
    <div className="flex flex-col gap-5">
      <CapturesViewed views={views} now={now} />
      <TimesheetCard userId={userId} zone={zone} date={date} manager={manager} />
    </div>
  );
}

function CapturesViewed({
  views,
  now,
}: {
  views: { data: CaptureView[] | undefined; error: Error | null; pending: boolean };
  now: number;
}) {
  const viewer = viewerZone();
  const recent = recentViews(views.data ?? [], 30, now);
  return (
    <section aria-labelledby="viewed-title" className={card}>
      <div className="border-b border-line px-[18px] py-4">
        <h2 id="viewed-title" className="text-[15px] font-semibold">
          Who viewed my captures
        </h2>
        <p className="mt-[3px] text-[12.5px] text-ink2">Every view is logged. Last 30 days.</p>
      </div>
      {views.error ? (
        <p role="alert" className="px-[18px] py-4 text-sm text-warnink">
          Couldn't load this: {views.error.message}
        </p>
      ) : recent.length === 0 ? (
        <p className="px-[18px] py-4 text-sm text-ink2">
          {views.pending ? "Loading…" : "No one has viewed your captures in the last 30 days."}
        </p>
      ) : (
        <ul>
          {recent.map((v) => (
            <li
              key={`${v.viewedAt}-${v.viewerId}-${v.checkinId}`}
              className="flex items-start gap-[11px] border-b border-line px-[18px] py-3 last:border-0"
            >
              <span
                aria-hidden
                className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border border-line bg-sunk text-[11px] font-semibold text-ink2"
              >
                {v.viewerName ? initials(v.viewerName) : "?"}
              </span>
              <div className="text-[13px] leading-[1.45]">
                <span className="font-medium">{viewerLabel(v)}</span>{" "}
                <span className="text-ink2">
                  viewed{" "}
                  {v.checkinAt
                    ? `${DateTime.fromISO(v.checkinAt, { zone: viewer }).toFormat("HH:mm")} check-in`
                    : "a check-in"}
                </span>
                <div className="font-mono text-xs text-ink3">
                  {whenLabel(v.viewedAt, viewer, now)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const editVerb: Record<MyEdit["kind"], string> = {
  exclude: "excluded",
  include: "put back",
  project: "moved",
  adjust: "adjusted",
};

function editText(e: MyEdit, zone: string, projectName: (id: string | null) => string): string {
  const start = DateTime.fromISO(e.startAt, { zone });
  const end = DateTime.fromISO(e.endAt, { zone });
  const when = `${start.toFormat("ccc d LLL")} · ${start.toFormat("HH:mm")}–${end.toFormat("HH:mm")} · ${minutesText(end.diff(start).as("seconds"))}`;
  switch (e.kind) {
    case "exclude":
      return `flagged time ${when}`;
    case "include":
      return `excluded time ${when}`;
    case "project":
      return `time ${when} to ${projectName(e.projectId)}`;
    case "adjust":
      return `time ${when}`;
  }
}

function TimesheetCard({
  userId,
  zone,
  date,
  manager,
}: {
  userId: string;
  zone: string;
  date: string;
  manager: string | null;
}) {
  const queryClient = useQueryClient();
  const startDay = useQuery(weekStartQuery);
  const week = startDay.data ? weekStartOf(date, startDay.data) : "";
  const ready = week !== "";
  const sheet = useQuery({ ...timesheetQuery(userId, week), enabled: ready });
  // The week's segments are rebuilt when it opens, so the numbers are current.
  const rebuild = useQuery({
    queryKey: ["my-data", "rebuild", userId, week],
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
  const weekFrom = week ? DateTime.fromISO(week, { zone }) : null;
  const unassigned = useQuery({
    ...unassignedQuery(
      userId,
      weekFrom?.toUTC().toISO() ?? "",
      weekFrom?.plus({ days: 7 }).toUTC().toISO() ?? "",
    ),
    enabled: fresh,
  });
  const edits = useQuery(myEditsQuery(userId));
  const projects = useQuery(projectsQuery);
  const projectName = (id: string | null) =>
    id ? ((projects.data ?? []).find((p) => p.id === id)?.name ?? "Project") : "Unassigned";

  const submit = useMutation({
    mutationFn: async () => {
      if (sheet.data) await submitWeek(sheet.data, zone);
    },
    onSuccess: () =>
      Promise.all(
        [
          ["timesheet", userId],
          ["timesheet-breakdown", userId],
          ["timesheet-mine"],
          ["timesheet-list"],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
  });

  const viewer = viewerZone();
  const total = week ? summarizeWeek(breakdown.data ?? [], weekDays(week)).total.worked : 0;
  const status = sheet.data?.status;
  const canSubmit = status === "draft" || status === "returned";
  const open = (unassigned.data ?? []).slice(0, 5);
  const more = (unassigned.data ?? []).length - open.length;
  const error = sheet.error ?? breakdown.error ?? unassigned.error ?? submit.error;
  const recentEdits = (edits.data ?? []).slice(0, 5);

  return (
    <section aria-labelledby="timesheet-title" className={card}>
      <div className="flex items-baseline gap-2 border-b border-line px-[18px] py-4">
        <h2 id="timesheet-title" className="text-[15px] font-semibold">
          My timesheet
        </h2>
        <span className="text-[12.5px] text-ink2">{week ? weekLabel(week) : ""}</span>
        <span className="ml-auto font-mono text-[13px]">
          {breakdown.data ? formatDuration(total) : "…"}
        </span>
      </div>
      <div className="flex flex-col gap-2.5 px-[18px] py-3.5">
        <span className="text-[12.5px] font-medium text-ink2">Unassigned time</span>
        {open.length === 0 ? (
          <p className="text-[13px] text-ink3">
            {unassigned.isPending && fresh ? "Loading…" : "None this week."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {open.map((u) => {
              const start = DateTime.fromISO(u.start, { zone: viewer });
              const end = DateTime.fromISO(u.end, { zone: viewer });
              return (
                <li key={u.start} className="flex flex-col gap-px">
                  <span className="font-mono text-[12.5px]">
                    {start.toFormat("ccc d")} · {start.toFormat("HH:mm")}–{end.toFormat("HH:mm")}
                  </span>
                  <span className="text-xs text-ink3">
                    {minutesText(end.diff(start).as("seconds"))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {more > 0 && <p className="text-xs text-ink3">and {more} more</p>}
        {/* Nothing until the week is known, so the button never flips from disabled to enabled. */}
        {sheet.data && !canSubmit && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <SheetStatusChip sheet={sheet.data} withTime />
          </div>
        )}
        {sheet.data && canSubmit && (
          <Button className="mt-1" disabled={submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? "Submitting…" : "Submit week"}
          </Button>
        )}
        {status === "returned" && sheet.data?.comment && (
          <p className="rounded-lg bg-sunk px-3 py-2 text-[13px] text-ink2">
            Returned: “{sheet.data.comment}”
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-warnink">
            {error.message}
          </p>
        )}
        <p className="text-xs leading-[1.45] text-ink3">
          {manager ?? "Your manager"} reviews it. You'll see any change they make, with their
          reason.
        </p>
        <Link to={myTimesheetPath} className="self-start text-[13px] text-acctext">
          All my timesheets
        </Link>
      </div>
      <div className="flex flex-col gap-2.5 border-t border-line px-[18px] py-3.5">
        <h3 className="text-[12.5px] font-medium text-ink2">Manager edits</h3>
        {edits.error ? (
          <p role="alert" className="text-sm text-warnink">
            Couldn't load edits: {edits.error.message}
          </p>
        ) : recentEdits.length === 0 ? (
          <p className="text-[13px] text-ink3">
            {edits.isPending ? "Loading…" : "No edits to your time yet."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {recentEdits.map((e) => (
              <li
                key={e.id}
                className="flex flex-col gap-1 rounded-lg bg-sunk px-3 py-2.5 text-[13px] leading-[1.45]"
              >
                <span>
                  <span className="font-medium">
                    {e.editorName ?? "Your manager"} {editVerb[e.kind]}
                  </span>{" "}
                  <span className="text-ink2">{editText(e, viewer, projectName)}</span>
                </span>
                {e.reason && <span className="text-ink2">Reason: “{e.reason}”</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
