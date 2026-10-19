// One employee's day (#33, DSH-03/05): a bar across the shift coloured by status,
// check-in markers, and the details of a missed check-in. Today refreshes live.
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouteContext, useSearch } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useMemo, useRef, useState } from "react";
import { StatusChip, statusStyle } from "../../components/StatusChip";
import { Button } from "../../components/ui/button";
import { supabase } from "../../lib/supabase";
import { Time, viewerZone } from "../../lib/time";
import { ShiftEditor, shiftsQuery } from "../people/ShiftEditor";
import {
  barSpan,
  type Checkin,
  localDay,
  markerLeft,
  type Outcome,
  type Period,
  segments,
  ticks,
  totals,
} from "./timeline";

interface CheckinRow extends Checkin {
  respondedAt: string | null;
  responseMs: number | null;
  wrongClicks: number;
  idleSAtShow: number | null;
  deviceState: string | null;
  missedReason: string | null;
  captures: number;
}

// Pages made by router.tsx's page() aren't in the typed route tree (same as the nav).
const teamPath: string = "/team";

const outcomeLabel: Record<Outcome, string> = {
  pass: "Passed check-in",
  miss: "Missed check-in",
  failed: "Failed check-in",
};

function minutesText(m: number): string {
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

export function DayPage() {
  const { userId } = useParams({ from: "/_app/team/$userId" });
  const search = useSearch({ from: "/_app/team/$userId" });
  const navigate = useNavigate();
  const { profile } = useRouteContext({ from: "/_app" });
  const scheduleRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const person = useQuery({
    queryKey: ["person", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("users")
        .select("id, full_name, timezone, manager_id, presence(status)")
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

  const shifts = useQuery({ ...shiftsQuery(userId), enabled: !!person.data });
  const activity = useQuery({
    queryKey: ["day", userId, date, zone],
    enabled: !!person.data,
    refetchInterval: isToday ? 30_000 : false,
    queryFn: async () => {
      const from = new Date(day.start).toISOString();
      const to = new Date(day.end).toISOString();
      const [periods, checkins] = await Promise.all([
        supabase
          .from("status_periods")
          .select("status, start_at, end_at")
          .eq("user_id", userId)
          .lt("start_at", to)
          .or(`end_at.is.null,end_at.gt.${from}`)
          .order("start_at"),
        supabase
          .from("checkin_events")
          .select(
            "id, scheduled_at, shown_at, responded_at, outcome, response_ms, wrong_clicks, idle_s_at_show, device_state, missed_reason, object_keys",
          )
          .eq("user_id", userId)
          .gte("scheduled_at", from)
          .lt("scheduled_at", to)
          .order("scheduled_at"),
      ]);
      if (periods.error) throw periods.error;
      if (checkins.error) throw checkins.error;
      return {
        now: Date.now(),
        periods: periods.data.map(
          (p): Period => ({ status: p.status, start: p.start_at, end: p.end_at }),
        ),
        checkins: checkins.data.map(
          (c): CheckinRow => ({
            id: c.id,
            scheduledAt: c.scheduled_at,
            shownAt: c.shown_at,
            respondedAt: c.responded_at,
            outcome: c.outcome,
            responseMs: c.response_ms,
            wrongClicks: c.wrong_clicks,
            idleSAtShow: c.idle_s_at_show,
            deviceState: c.device_state,
            missedReason: c.missed_reason,
            captures: c.object_keys.length,
          }),
        ),
      };
    },
  });

  const now = activity.data?.now ?? Date.now();
  const periods = activity.data?.periods ?? [];
  const checkins = activity.data?.checkins ?? [];
  const span = barSpan(day, zone, shifts.data ?? [], periods, checkins, now);
  const segs = segments(span, periods, now);
  const viewer = viewerZone();
  const chosen = checkins.find((c) => c.id === selected) ?? null;
  const canSchedule =
    profile.role === "owner" || profile.role === "admin" || person.data?.manager_id === profile.id;

  const go = (d: string) =>
    navigate({ to: "/team/$userId", params: { userId }, search: { date: d } });
  const shift = (days: number) => go(DateTime.fromISO(date).plus({ days }).toISODate() ?? date);

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
  const status = person.data.presence?.status;

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Link to={teamPath} className="text-[13px] text-acctext">
            Live team
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.025em]">
            {person.data.full_name}
          </h1>
          <p className="mt-1 text-[13.5px] text-ink2">
            {DateTime.fromISO(date).toFormat("cccc d LLLL yyyy")} · their time zone {zone}
          </p>
        </div>
        {status && isToday && <StatusChip status={status} />}
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
          <Button variant="secondary" className="h-10" disabled={isToday} onClick={() => shift(1)}>
            Next day
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
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-5">
        {activity.error ? (
          <p role="alert" className="text-sm text-warnink">
            Couldn't load the day: {activity.error.message}
          </p>
        ) : (
          <>
            <div className="relative pt-7 pb-6">
              <div
                role="img"
                aria-label={
                  segs.length
                    ? `Status over the day: ${totals(segs)
                        .map((t) => `${statusStyle[t.status].label} ${minutesText(t.minutes)}`)
                        .join(", ")}`
                    : "No activity recorded on this day"
                }
                className="relative h-8 overflow-hidden rounded-md bg-sunk"
              >
                {segs.map((s) => (
                  <span
                    key={`${s.status}-${s.start}`}
                    title={`${statusStyle[s.status].label}, ${DateTime.fromMillis(s.start, { zone: viewer }).toFormat("HH:mm")}–${DateTime.fromMillis(s.end, { zone: viewer }).toFormat("HH:mm")}`}
                    className="absolute inset-y-0"
                    style={{
                      left: `${s.left}%`,
                      width: `${s.width}%`,
                      background: statusStyle[s.status].color,
                    }}
                  />
                ))}
              </div>
              {checkins.map((c) => {
                const left = markerLeft(span, c);
                if (left === null) return null;
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={selected === c.id}
                    aria-label={`${outcomeLabel[c.outcome]} at ${DateTime.fromISO(c.shownAt ?? c.scheduledAt, { zone: viewer }).toFormat("HH:mm")}`}
                    onClick={() => setSelected(selected === c.id ? null : c.id)}
                    className="absolute top-0 grid h-6 w-6 -translate-x-1/2 place-items-center rounded-full"
                    style={{ left: `${left}%` }}
                  >
                    <Marker outcome={c.outcome} />
                  </button>
                );
              })}
              {ticks(span, viewer).map((t) => (
                <span
                  key={t.label}
                  aria-hidden
                  className="absolute bottom-0 -translate-x-1/2 font-mono text-[11px] text-ink3"
                  style={{ left: `${t.left}%` }}
                >
                  {t.label}
                </span>
              ))}
            </div>

            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-ink2">
              {totals(segs).map((t) => (
                <li key={t.status} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ background: statusStyle[t.status].color }}
                  />
                  {statusStyle[t.status].label} · {minutesText(t.minutes)}
                </li>
              ))}
              <li className="flex items-center gap-4 text-ink3">
                <span className="flex items-center gap-1.5">
                  <Marker outcome="pass" /> passed
                </span>
                <span className="flex items-center gap-1.5">
                  <Marker outcome="miss" /> missed
                </span>
                <span className="flex items-center gap-1.5">
                  <Marker outcome="failed" /> failed
                </span>
              </li>
            </ul>
            {isToday && <p className="text-xs text-ink3">Updates every 30 seconds.</p>}
          </>
        )}
      </div>

      {chosen && <CheckinDetails c={chosen} zone={zone} />}

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <h2 className="border-b border-line px-5 py-3 text-sm font-semibold">Check-ins</h2>
        {checkins.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink2">No check-ins on this day.</p>
        ) : (
          <ul>
            {checkins.map((c) => (
              <li key={c.id} className="border-b border-line last:border-0">
                <button
                  type="button"
                  onClick={() => setSelected(c.id)}
                  className="flex w-full items-center gap-3 px-5 py-3 text-left text-[13.5px]"
                >
                  <Marker outcome={c.outcome} />
                  <Time iso={c.shownAt ?? c.scheduledAt} employeeZone={zone} />
                  <span>{outcomeLabel[c.outcome]}</span>
                  {c.outcome === "pass" && c.responseMs !== null && (
                    <span className="text-ink3">in {Math.round(c.responseMs / 1000)} s</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {canSchedule && (
        <dialog
          ref={scheduleRef}
          aria-labelledby="schedule-title"
          className="m-auto w-[min(560px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
        >
          <h2 id="schedule-title" className="mb-4 text-lg font-semibold">
            {person.data.full_name}'s schedule
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

function Marker({ outcome }: { outcome: Outcome }) {
  if (outcome === "pass") {
    return (
      <span aria-hidden className="h-3 w-3 rounded-full" style={{ background: "var(--sactive)" }} />
    );
  }
  if (outcome === "miss") {
    return (
      <span
        aria-hidden
        className="h-3 w-3 rounded-full bg-panel"
        style={{ border: "2px solid var(--saway)" }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="grid h-3 w-3 place-items-center text-[13px] leading-none font-bold"
      style={{ color: "var(--stamper)" }}
    >
      ×
    </span>
  );
}

function CheckinDetails({ c, zone }: { c: CheckinRow; zone: string }) {
  const rows: [string, React.ReactNode][] = [
    ["Scheduled", <Time key="s" iso={c.scheduledAt} employeeZone={zone} />],
  ];
  if (c.shownAt) rows.push(["Shown", <Time key="sh" iso={c.shownAt} employeeZone={zone} />]);
  if (c.outcome === "miss") {
    rows.push(
      [
        "Idle when shown",
        c.idleSAtShow === null ? "—" : minutesText(Math.round(c.idleSAtShow / 60)),
      ],
      ["Device", c.deviceState ?? "—"],
      ["Reason", c.missedReason ?? "No reason given yet"],
    );
  } else {
    if (c.respondedAt)
      rows.push(["Answered", <Time key="r" iso={c.respondedAt} employeeZone={zone} />]);
    if (c.responseMs !== null)
      rows.push(["Response time", `${(c.responseMs / 1000).toFixed(1)} s`]);
    rows.push(["Wrong clicks", String(c.wrongClicks)]);
    if (c.outcome === "pass") rows.push(["Captures", c.captures ? `${c.captures} files` : "None"]);
  }
  return (
    <section aria-labelledby="checkin-title" className="rounded-xl border border-line bg-panel p-5">
      <h2 id="checkin-title" className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Marker outcome={c.outcome} />
        {outcomeLabel[c.outcome]}
      </h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[13.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink3">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
