// One employee's day (#33, #124, DSH-03/04/05), from the Claude Design DayView screen:
// totals and a bar of time_segments with check-in markers on top, the selected
// check-in on the left and the list of check-ins on the right. Today refreshes live.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouteContext, useSearch } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useMemo, useRef, useState } from "react";
import { StatusChip } from "../../components/StatusChip";
import { Button } from "../../components/ui/button";
import { supabase } from "../../lib/supabase";
import { Time, viewerZone } from "../../lib/time";
import { ShiftEditor, shiftsQuery } from "../people/ShiftEditor";
import { projectsQuery } from "../projects/projectData";
import { canDecideQuery, weekStartQuery } from "../timesheets/timesheetData";
import { weekStartOf } from "../timesheets/weeks";
import { CheckinDetails } from "./CheckinDetails";
import { deferralText, noFace, outcomeWord } from "./checkinText";
import { DayTimeline, Marker, StatsRow } from "./DayTimeline";
import {
  dayCheckinsQuery,
  daySegmentsQuery,
  dayTamperQuery,
  rebuildDay,
  responseWindowQuery,
} from "./dayData";
import { statCards } from "./dayStats";
import { flagCheckinIds } from "./flagText";
import { ManualEntries } from "./ManualEntries";
import { dayFlagsQuery, NeedsReviewBadge, NeedsReviewPanel, NoFaceBadge } from "./NeedsReview";
import { barSegments, barSpan, localDay, shiftText, ticks, withTamperReasons } from "./timeline";

// Pages made by router.tsx's page() aren't in the typed route tree (same as the nav).
const teamPath: string = "/team";

const roleLabel: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  employee: "Employee",
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

export function DayPage() {
  const { userId } = useParams({ from: "/_app/team/$userId" });
  const search = useSearch({ from: "/_app/team/$userId" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile } = useRouteContext({ from: "/_app" });
  const scheduleRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const person = useQuery({
    queryKey: ["person", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("users")
        .select("id, full_name, timezone, role, presence(status, tamper_reason)")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const zone = person.data?.timezone ?? viewerZone();
  const today = DateTime.now().setZone(zone).toISODate() ?? "";
  const date = search.date ?? today;
  const isToday = date === today;
  const day = useMemo(() => localDay(date, zone), [date, zone]);
  const live = isToday ? 30_000 : false;

  const shifts = useQuery({ ...shiftsQuery(userId), enabled: !!person.data });
  // The day's segments are rebuilt when the page opens (LLD section 6), then read; a
  // failed rebuild leaves what is stored. Today is rebuilt again every minute.
  const rebuild = useQuery({
    queryKey: ["day-rebuild", userId, date],
    enabled: !!person.data,
    staleTime: 60_000,
    retry: false,
    refetchInterval: isToday ? 60_000 : false,
    queryFn: async () => {
      const ok = await rebuildDay(userId, date);
      await queryClient.invalidateQueries({ queryKey: daySegmentsQuery(userId, date).queryKey });
      return ok;
    },
  });
  const segments = useQuery({
    ...daySegmentsQuery(userId, date),
    enabled: !!person.data && rebuild.status !== "pending",
    refetchInterval: live,
  });
  // time_segments don't keep why time was Tamper; the status periods do (#160).
  const tamperQ = useQuery({
    ...dayTamperQuery(userId, day, date),
    enabled: !!person.data,
    refetchInterval: live,
  });
  const checkinsQ = useQuery({
    ...dayCheckinsQuery(userId, day, date, zone),
    enabled: !!person.data,
    refetchInterval: live,
  });
  const responseWindow = useQuery(responseWindowQuery).data ?? 90;
  const projects = useQuery(projectsQuery).data;
  const startDay = useQuery(weekStartQuery).data;

  // ANT-08: anti-cheat flags for the day, shown as "needs review".
  const flagsQ = useQuery({
    ...dayFlagsQuery(userId, date),
    enabled: !!person.data,
    refetchInterval: live,
  });
  const flags = flagsQ.data ?? [];
  const unreviewed = flags.filter((f) => f.reviewedAt === null).length;
  const flaggedCheckins = new Set(
    flags.filter((f) => f.reviewedAt === null).flatMap((f) => flagCheckinIds(f.details)),
  );

  const viewer = viewerZone();
  const segs = segments.data ?? [];
  const checkins = checkinsQ.data ?? [];
  const span = barSpan(day, zone, shifts.data ?? [], segs, checkins);
  const bar = barSegments(span, withTamperReasons(segs, tamperQ.data ?? []));
  const cards = statCards(segs, checkins, (ms) =>
    DateTime.fromMillis(ms, { zone: viewer }).toFormat("HH:mm"),
  );
  // Without a pick, the latest check-in of the day is open.
  const selectedId =
    checkins.find((c) => c.id === selected)?.id ?? checkins[checkins.length - 1]?.id ?? null;
  const chosen = checkins.find((c) => c.id === selectedId) ?? null;
  const shown = checkins.filter((c) => c.outcome !== "deferred");
  const passed = shown.filter((c) => c.outcome === "pass").length;
  // Nobody reviews flags about themselves.
  const canReview = profile.id !== userId;
  // The server decides who is the person's manager or active delegate (TS-12, TS-14).
  const canDecide = useQuery(canDecideQuery(userId)).data === true;
  const canSchedule = profile.role === "owner" || profile.role === "admin" || canDecide;
  const isSelf = userId === profile.id;
  const week = weekStartOf(date, startDay ?? 1);

  const go = (d: string) =>
    navigate({ to: "/team/$userId", params: { userId }, search: { date: d } });
  const shift = (days: number) => go(DateTime.fromISO(date).plus({ days }).toISODate() ?? date);
  const dayName = (days: number, format: string) =>
    DateTime.fromISO(date).plus({ days }).toFormat(format);

  if (person.isPending) return <p className="text-sm text-ink2">Loading…</p>;
  if (!person.data) {
    return (
      <p role="alert" className="text-sm text-ink2">
        This person isn't in your team.{" "}
        <Link to={teamPath} className="text-acctext">
          Back to the team
        </Link>
      </p>
    );
  }
  const name = person.data.full_name;
  const status = person.data.presence?.status;
  const projectName = (id: string | null) =>
    id === null ? "Unassigned" : (projects?.find((p) => p.id === id)?.name ?? "Unknown project");

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-3.5">
        {profile.role !== "employee" && (
          <nav aria-label="Breadcrumb" className="flex gap-1.5 text-[13px] text-ink3">
            <Link to={teamPath} className="text-acctext">
              Live team
            </Link>
            <span aria-hidden>/</span>
            <span aria-current="page" className="text-ink2">
              {name}
            </span>
          </nav>
        )}
        <div className="flex flex-wrap items-center gap-3.5">
          <span
            aria-hidden
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full border border-line bg-sunk text-sm font-semibold text-ink2"
          >
            {initials(name)}
          </span>
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{name}</h1>
            <p className="mt-0.5 text-[13.5px] text-ink2">
              {dayName(0, "ccc d LLL")} · {shiftText(shifts.data ?? [], date, zone)} ·{" "}
              {roleLabel[person.data.role] ?? person.data.role}
            </p>
          </div>
          {status && isToday && (
            <StatusChip status={status} reason={person.data.presence?.tamper_reason} />
          )}
          {unreviewed > 0 && <NeedsReviewBadge />}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              className="h-10"
              aria-label={`Previous day, ${dayName(-1, "ccc d LLL")}`}
              onClick={() => shift(-1)}
            >
              ‹ {dayName(-1, "ccc d")}
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
              aria-label={`Next day, ${dayName(1, "ccc d LLL")}`}
              onClick={() => shift(1)}
            >
              {dayName(1, "ccc d")} ›
            </Button>
            {canSchedule && (
              <Button
                variant="secondary"
                className="h-10"
                onClick={() => scheduleRef.current?.showModal()}
              >
                Schedule
              </Button>
            )}
            <Link
              to="/timesheets/$userId"
              params={{ userId }}
              search={{ week }}
              className="inline-flex h-10 items-center rounded-[9px] bg-acc px-4 text-[13.5px] font-semibold text-accink"
            >
              Open timesheet
            </Link>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-[18px] rounded-xl border border-line bg-panel p-5">
        {segments.error || checkinsQ.error ? (
          <p role="alert" className="text-sm text-warnink">
            Couldn't load the day: {(segments.error ?? checkinsQ.error)?.message}
          </p>
        ) : segments.isPending ? (
          <p className="text-sm text-ink2">Loading the day…</p>
        ) : (
          <>
            <StatsRow cards={cards} />
            <DayTimeline
              segs={bar}
              span={span}
              ticks={ticks(span, viewer)}
              checkins={checkins}
              selectedId={selectedId}
              onSelect={setSelected}
              viewer={viewer}
            />
            {isToday && <p className="text-xs text-ink3">Updates every 30 seconds.</p>}
          </>
        )}
      </div>

      {flags.length > 0 && (
        <NeedsReviewPanel flags={flags} userId={userId} date={date} canReview={canReview} />
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        {chosen && (
          <CheckinDetails
            key={chosen.id}
            c={chosen}
            zone={zone}
            needsReview={flaggedCheckins.has(chosen.id)}
            projectName={projectName(chosen.projectId)}
            responseWindowS={responseWindow}
            userId={userId}
            week={week}
            isSelf={isSelf}
            personName={name}
          />
        )}
        <section
          aria-labelledby="checkins-title"
          className={`overflow-hidden rounded-xl border border-line bg-panel ${chosen ? "" : "lg:col-span-2"}`}
        >
          <div className="flex items-center border-b border-line px-4 py-3.5">
            <h2 id="checkins-title" className="text-sm font-semibold">
              Check-ins
            </h2>
            <span className="ml-auto text-[12.5px] text-ink3">
              {passed} of {shown.length} passed
            </span>
          </div>
          {checkins.length === 0 ? (
            <p className="px-4 py-4 text-sm text-ink2">No check-ins on this day.</p>
          ) : (
            <ul>
              {checkins.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={c.id === selectedId}
                    onClick={() => setSelected(c.id)}
                    className={`flex min-h-11 w-full items-center gap-2.5 border-b border-line px-4 py-2 text-left text-[13px] ${c.id === selectedId ? "bg-sunk shadow-[inset_2px_0_0_var(--ink)]" : ""}`}
                  >
                    <Marker outcome={c.outcome} size={9} />
                    <span className="w-11">
                      <Time iso={c.shownAt ?? c.scheduledAt} employeeZone={zone} />
                    </span>
                    <span className="font-medium">{outcomeWord[c.outcome]}</span>
                    {flaggedCheckins.has(c.id) && <NeedsReviewBadge />}
                    {noFace(c) && <NoFaceBadge />}
                    <span className="ml-auto text-[12.5px] text-ink3">
                      {c.outcome === "deferred" && deferralText(c.deferralReason)}
                      {c.outcome === "pass" &&
                        c.responseMs !== null &&
                        `in ${Math.round(c.responseMs / 1000)} s`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ManualEntries
        userId={userId}
        zone={zone}
        date={date}
        dayStart={day.start}
        dayEnd={day.end}
        isSelf={isSelf}
        canDecide={canDecide}
      />

      {canSchedule && (
        <dialog
          ref={scheduleRef}
          aria-labelledby="schedule-title"
          className="m-auto w-[min(560px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
        >
          <h2 id="schedule-title" className="mb-4 text-lg font-semibold">
            {name}'s schedule
          </h2>
          <ShiftEditor userId={userId} timezone={zone} />
          <Button variant="secondary" className="mt-4" onClick={() => scheduleRef.current?.close()}>
            Close
          </Button>
        </dialog>
      )}
    </section>
  );
}
