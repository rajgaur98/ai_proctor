// My data (#49; EMP-02, EMP-03, EMP-04, ACT-05), from the Claude Design MyData screen:
// everything the app has collected about the signed-in person, for any role: the day
// as a bar with its legend, missed check-ins with reasons, check-ins with their
// captures and who viewed them, the apps and sites seen, who viewed their captures,
// their week's timesheet and the manager's edits to it. "Export my data" downloads a
// ZIP of all of it (export-my-data).
import { windowsBetween } from "@ai-proctor/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext, useSearch } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Time, viewerZone } from "../../lib/time";
import { CaptureViewer } from "../day/CaptureViewer";
import { Marker, outcomeLabel } from "../day/DayPage";
import { barSpan, deferralLabel, localDay, ticks } from "../day/timeline";
import { shiftsQuery } from "../people/ShiftEditor";
import { projectsQuery } from "../projects/projectData";
import { exportMyData } from "./exportData";
import {
  appLabel,
  asPeriods,
  filesOf,
  imagesExpired,
  type MissReasonKind,
  minutesText,
  missReasonLabel,
  missReasons,
  placeSegments,
  segmentStyle,
  typeTotals,
  viewedBy,
  workedSeconds,
} from "./helpers";
import {
  activityQuery,
  appsAtCheckinsQuery,
  capturesViewedQuery,
  checkinsQuery,
  type MyCheckin,
  myManagerQuery,
  retentionQuery,
  segmentsQuery,
  setMissReason,
} from "./queries";
import { SidePanels } from "./SidePanels";

const card = "overflow-hidden rounded-xl border border-line bg-panel";
const cardHead = "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-4";

export function MyData() {
  const { profile } = useRouteContext({ from: "/_app" });
  const search = useSearch({ from: "/_app/me" });
  const navigate = useNavigate();
  const zone = profile.timezone;
  const viewer = viewerZone();
  const today = DateTime.now().setZone(zone).toISODate() ?? "";
  const date = search.date ?? today;
  const isToday = date === today;
  const day = useMemo(() => localDay(date, zone), [date, zone]);
  const from = new Date(day.start).toISOString();
  const to = new Date(day.end).toISOString();
  const live = isToday ? 30_000 : false;
  const now = Date.now();

  const manager = useQuery(myManagerQuery(profile.id));
  const retention = useQuery(retentionQuery);
  const shifts = useQuery(shiftsQuery(profile.id));
  const segments = useQuery({ ...segmentsQuery(profile.id, from, to), refetchInterval: live });
  const checkins = useQuery({ ...checkinsQuery(profile.id, from, to), refetchInterval: live });
  const views = useQuery(capturesViewedQuery(profile.id));
  const apps = useQuery(appsAtCheckinsQuery(profile.id, checkins.data ?? []));
  const activity = useQuery({ ...activityQuery(profile.id, from, to), refetchInterval: live });
  const projects = useQuery(projectsQuery);

  const go = (d: string) => navigate({ to: "/me", search: { date: d } });
  const shift = (days: number) => go(DateTime.fromISO(date).plus({ days }).toISODate() ?? date);

  const exported = useMutation({ mutationFn: exportMyData });

  const segs = segments.data ?? [];
  const list = checkins.data ?? [];
  const span = barSpan(day, zone, shifts.data ?? [], asPeriods(segs), list, now);
  const placed = placeSegments(span, segs);
  const legend = typeTotals(span, segs);
  const shiftWindow = windowsBetween(shifts.data ?? [], new Date(day.start), new Date(day.end))[0];
  const misses = list.filter((c) => c.outcome === "miss");
  const others = list.filter((c) => c.outcome !== "miss");
  const projectName = (id: string | null) =>
    id ? ((projects.data ?? []).find((p) => p.id === id)?.name ?? "Project") : "No project";
  const dayTitle = DateTime.fromISO(date).toFormat("ccc d LLL");
  const managerName = manager.data ?? null;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div className="max-w-[640px]">
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">My data</h1>
          <p className="mt-1 text-[13.5px] leading-normal text-ink2">
            Everything AI Proctor has collected about you. Only you,{" "}
            {managerName ? `${managerName} (your manager) and ` : ""}workspace admins can see it.
            Images are deleted after {retention.data ?? 30} days.
          </p>
        </div>
        <div className="ml-auto flex flex-col items-end gap-2">
          <Button
            variant="secondary"
            disabled={exported.isPending}
            onClick={() => exported.mutate()}
          >
            {exported.isPending ? "Preparing your export…" : "Export my data"}
          </Button>
          {exported.isSuccess && (
            <p role="status" className="text-[12.5px] text-ink2">
              Your download has started.
            </p>
          )}
          {exported.error && (
            <p role="alert" className="max-w-[360px] text-right text-[12.5px] text-warnink">
              {exported.error.message}
            </p>
          )}
        </div>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          <section aria-labelledby="my-day-title" className={`${card} flex flex-col gap-3 p-5`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 id="my-day-title" className="text-[15px] font-semibold">
                {isToday ? `Today · ${dayTitle}` : dayTitle}
              </h2>
              <span className="text-[13px] text-ink2">
                <span className="font-mono text-ink">{minutesText(workedSeconds(segs))}</span>{" "}
                worked{isToday ? " so far" : ""}
                {shiftWindow && (
                  <>
                    {" "}
                    · shift{" "}
                    {DateTime.fromJSDate(shiftWindow.start, { zone: viewer }).toFormat("HH:mm")}–
                    {DateTime.fromJSDate(shiftWindow.end, { zone: viewer }).toFormat("HH:mm")}
                  </>
                )}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button variant="secondary" className="h-10" onClick={() => shift(-1)}>
                  Previous day
                </Button>
                <input
                  type="date"
                  aria-label="Day"
                  value={date}
                  max={today}
                  onChange={(e) => e.target.value && go(e.target.value)}
                  className="h-10 rounded-[9px] border border-line2 bg-panel px-3 text-[13.5px]"
                />
                <Button
                  variant="secondary"
                  className="h-10"
                  disabled={isToday}
                  onClick={() => shift(1)}
                >
                  Next day
                </Button>
              </div>
            </div>
            {segments.error ? (
              <p role="alert" className="text-sm text-warnink">
                Couldn't load the day: {segments.error.message}
              </p>
            ) : (
              <>
                <div aria-hidden className="relative h-4 font-mono text-[11px] text-ink3">
                  {ticks(span, viewer).map((t) => (
                    <span
                      key={t.label}
                      className="absolute -translate-x-1/2"
                      style={{ left: `${t.left}%` }}
                    >
                      {t.label}
                    </span>
                  ))}
                </div>
                <div
                  role="img"
                  aria-label={
                    legend.length
                      ? `Your day: ${legend
                          .map((t) => `${segmentStyle[t.type].label} ${minutesText(t.seconds)}`)
                          .join(", ")}`
                      : "No activity recorded on this day"
                  }
                  className="relative h-8 overflow-hidden rounded-[7px] bg-sunk"
                >
                  {placed.map((s) => (
                    <span
                      key={`${s.type}-${s.start}`}
                      title={`${segmentStyle[s.type].label}, ${DateTime.fromISO(s.start, { zone: viewer }).toFormat("HH:mm")}–${DateTime.fromISO(s.end, { zone: viewer }).toFormat("HH:mm")}`}
                      className="absolute inset-y-0"
                      style={{
                        left: `${s.left}%`,
                        width: `${s.width}%`,
                        background: segmentStyle[s.type].background,
                      }}
                    />
                  ))}
                </div>
                <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink2">
                  {legend.map((t) => (
                    <li key={t.type} className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="block h-[9px] w-4 rounded-sm"
                        style={{ background: segmentStyle[t.type].background }}
                      />
                      {segmentStyle[t.type].label} · {minutesText(t.seconds)}
                    </li>
                  ))}
                  <li className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="block h-[9px] w-4 rounded-sm border border-line2 bg-sunk"
                    />
                    Not recorded
                  </li>
                </ul>
                {isToday && <p className="text-xs text-ink3">Updates every 30 seconds.</p>}
              </>
            )}
          </section>

          <section aria-labelledby="misses-title" className={card}>
            <div className={cardHead}>
              <h2 id="misses-title" className="text-[15px] font-semibold">
                Missed check-ins
              </h2>
              <span className="text-[12.5px] text-ink2">
                Add a reason so your timesheet is clear.
              </span>
            </div>
            {checkins.error ? (
              <p role="alert" className="p-5 text-sm text-warnink">
                Couldn't load check-ins: {checkins.error.message}
              </p>
            ) : misses.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink2">
                {checkins.isPending ? "Loading…" : "No missed check-ins on this day."}
              </p>
            ) : (
              <ul>
                {misses.map((c) => (
                  <MissRow key={c.id} c={c} zone={zone} manager={managerName} userId={profile.id} />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="checkins-title" className={card}>
            <div className={cardHead}>
              <h2 id="checkins-title" className="text-[15px] font-semibold">
                {isToday ? "Today's check-ins" : "Check-ins"}
              </h2>
              <span className="ml-auto text-[12.5px] text-ink3">
                {others.length} shown · captures are taken only when you pass
              </span>
            </div>
            {others.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink2">
                {checkins.isPending ? "Loading…" : "No check-ins on this day."}
              </p>
            ) : (
              <ul>
                {others.map((c) => (
                  <CheckinRow
                    key={c.id}
                    c={c}
                    zone={zone}
                    viewer={viewer}
                    now={now}
                    retentionDays={retention.data ?? 30}
                    app={appLabel(apps.data?.get(c.id) ?? [])}
                    project={projectName(c.projectId)}
                    viewed={
                      views.isPending
                        ? "Checking…"
                        : views.error
                          ? "Couldn't check"
                          : viewedBy(views.data ?? [], c.id, viewer, now)
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="activity-title" className={card}>
            <div className={cardHead}>
              <h2 id="activity-title" className="text-[15px] font-semibold">
                Apps and sites
              </h2>
              <span className="text-[12.5px] text-ink2">
                What was in front while you were clocked in. Window titles appear only if your
                workspace records them.
              </span>
            </div>
            {activity.error ? (
              <p role="alert" className="p-5 text-sm text-warnink">
                Couldn't load activity: {activity.error.message}
              </p>
            ) : (activity.data ?? []).length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink2">
                {activity.isPending ? "Loading…" : "No app activity recorded on this day."}
              </p>
            ) : (
              <ul>
                {(activity.data ?? []).slice(0, 15).map((a) => (
                  <li
                    key={`${a.appName}|${a.domain ?? ""}`}
                    className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line px-5 py-3 text-[13px] last:border-0"
                  >
                    <span className="font-medium">
                      {a.appName}
                      {a.domain && <span className="font-normal text-ink2"> · {a.domain}</span>}
                    </span>
                    {a.titles.length > 0 && (
                      <span className="min-w-0 flex-1 truncate text-ink3">
                        {a.titles.join(" · ")}
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[12.5px]">
                      {minutesText(a.seconds)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <SidePanels
          userId={profile.id}
          zone={zone}
          date={date}
          manager={managerName}
          views={{ data: views.data, error: views.error, pending: views.isPending }}
          now={now}
        />
      </div>
    </section>
  );
}

function MissRow({
  c,
  zone,
  manager,
  userId,
}: {
  c: MyCheckin;
  zone: string;
  manager: string | null;
  userId: string;
}) {
  const queryClient = useQueryClient();
  const pick = useMutation({
    mutationFn: (kind: MissReasonKind) => setMissReason(c.id, kind, c.missedReason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["my-data", "checkins", userId] }),
  });
  const chosen = missReasonLabel(c.missedReasonKind);
  const reason = [chosen, c.missedReason].filter(Boolean).join(": ");
  const detail = [
    c.idleSAtShow === null ? null : `Idle ${minutesText(c.idleSAtShow)} when shown`,
    c.deviceState ? `Device ${c.deviceState}` : null,
  ].filter(Boolean);

  return (
    <li className="flex flex-col gap-3 border-b border-line px-5 py-4 last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Marker outcome="miss" />
        <Time iso={c.shownAt ?? c.scheduledAt} employeeZone={zone} />
        <span className="text-[13.5px] font-medium">Missed</span>
        {detail.length > 0 && <span className="text-[12.5px] text-ink2">{detail.join(" · ")}</span>}
        <span className="ml-auto text-[12.5px] font-medium text-ink2">
          {reason
            ? `Reason: ${reason}${manager ? ` · visible to ${manager}` : ""}`
            : "No reason yet"}
        </span>
      </div>
      <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0">
        <legend className="sr-only">Add a reason</legend>
        <span aria-hidden className="mr-1 text-[12.5px] text-ink3">
          Add reason
        </span>
        {missReasons.map((r) => (
          <button
            key={r.kind}
            type="button"
            aria-pressed={c.missedReasonKind === r.kind}
            disabled={pick.isPending}
            onClick={() => pick.mutate(r.kind)}
            className={`h-11 rounded-[9px] px-3.5 text-[13.5px] font-medium text-ink disabled:opacity-45 ${
              c.missedReasonKind === r.kind
                ? "border-[1.5px] border-acc bg-accsoft"
                : "border border-line2 bg-panel"
            }`}
          >
            {r.label}
          </button>
        ))}
      </fieldset>
      {pick.error && (
        <p role="alert" className="text-sm text-warnink">
          {pick.error.message}
        </p>
      )}
    </li>
  );
}

function CheckinRow({
  c,
  zone,
  viewer,
  now,
  retentionDays,
  app,
  project,
  viewed,
}: {
  c: MyCheckin;
  zone: string;
  viewer: string;
  now: number;
  retentionDays: number;
  app: string | null;
  project: string;
  viewed: string;
}) {
  const [open, setOpen] = useState(false);
  const files = filesOf(c.objectKeys);
  const hasCaptures = c.outcome === "pass" && c.objectKeys.length > 0;
  const expired = imagesExpired(c.scheduledAt, retentionDays, now);
  const time = DateTime.fromISO(c.shownAt ?? c.scheduledAt, { zone: viewer }).toFormat("HH:mm");
  const seen = viewed.startsWith("Viewed");

  return (
    <li className="border-b border-line last:border-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3">
        <div className="flex w-[170px] items-center gap-2.5">
          <Marker outcome={c.outcome} />
          <Time iso={c.shownAt ?? c.scheduledAt} employeeZone={zone} />
          <span className="text-[13px] font-medium">
            {c.outcome === "pass"
              ? "Passed"
              : c.outcome === "deferred"
                ? "Deferred"
                : outcomeLabel[c.outcome]}
          </span>
        </div>
        {hasCaptures ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "View"} the captures of the ${time} check-in`}
            onClick={() => setOpen(!open)}
            className="flex gap-1.5 rounded-md"
          >
            <Thumb
              label={
                expired
                  ? "deleted"
                  : files.screens > 1
                    ? `screenshots ×${files.screens}`
                    : "screenshot"
              }
              wide
              present={files.screens > 0}
            />
            <Thumb label={expired ? "deleted" : "webcam"} present={files.webcam} />
          </button>
        ) : (
          <span className="text-[12.5px] text-ink3">
            {c.outcome === "deferred"
              ? (deferralLabel[c.deferralReason ?? ""] ?? "Held back")
              : "No captures"}
          </span>
        )}
        <div className="flex min-w-[140px] flex-col gap-0.5 text-[12.5px] text-ink2">
          <span className="font-medium text-ink">{app ?? "App not recorded"}</span>
          <span>{project}</span>
        </div>
        {hasCaptures && (
          <span
            className={`ml-auto text-[12.5px] ${
              seen ? "rounded-full bg-accsoft px-[9px] py-[3px] font-medium text-ink" : "text-ink3"
            }`}
          >
            {viewed}
          </span>
        )}
      </div>
      {open && (
        <div className="border-t border-line bg-sunk px-5 py-4">
          <CaptureViewer checkinId={c.id} zone={zone} />
        </div>
      )}
    </li>
  );
}

/** A stand-in for one capture file, until the person opens it (opening is logged). */
function Thumb({
  label,
  wide = false,
  present,
}: {
  label: string;
  wide?: boolean;
  present: boolean;
}) {
  return (
    <span
      className={`box-border flex h-[60px] items-end rounded-md px-[5px] py-1 font-mono text-[9.5px] text-ink3 ${
        wide ? "w-24" : "w-[60px]"
      } ${present ? "border border-line" : "items-center justify-center border-[1.5px] border-dashed border-line2 text-center"}`}
      style={
        present
          ? {
              background:
                "repeating-linear-gradient(135deg, var(--sunk) 0 5px, var(--panel) 5px 10px)",
            }
          : undefined
      }
    >
      {present ? label : "none"}
    </span>
  );
}
