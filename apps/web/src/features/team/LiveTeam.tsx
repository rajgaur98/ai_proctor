// DSH-01/02 live grid, from the Claude Design TeamGrid screen; DSH-09 seat view (#251).
import { useQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ExportButton } from "../../components/ExportButton";
import { type PresenceStatus, StatusChip, statusStyle } from "../../components/StatusChip";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { initials } from "../../lib/nav";
import { supabase } from "../../lib/supabase";
import { formatTime, viewerZone } from "../../lib/time";
import { projectsQuery } from "../projects/projectData";
import { teamsQuery } from "../teams/teamData";
import {
  filterRows,
  inTeam,
  onShift,
  type SortKey,
  since,
  sortRows,
  summarize,
  type TeamRow,
} from "./grid";
import { SeatMap } from "./SeatMap";
import { liveTeamTable } from "./teamExport";
import { useLivePresence } from "./useLivePresence";

const queryKey = ["team_live"];

type View = "list" | "seats";

/** The viewer's last view; storage can be missing or blocked, so it falls back to the list. */
function readView(key: string): View {
  try {
    return window.localStorage.getItem(key) === "seats" ? "seats" : "list";
  } catch {
    return "list";
  }
}

function saveView(key: string, view: View) {
  try {
    window.localStorage.setItem(key, view);
  } catch {
    // Not remembered this time; the choice still applies.
  }
}

function useNow(everyMs: number) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

export function LiveTeam() {
  const { profile } = useRouteContext({ from: "/_app" });
  const live = useLivePresence(queryKey);
  const now = useNow(30_000);
  const [status, setStatus] = useState<PresenceStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("status");
  const [team, setTeam] = useState("");
  const viewKey = `ai-proctor:team-view:${profile.id}`;
  const [view, setView] = useState<View>(() => readView(viewKey));
  const chooseView = (v: View) => {
    setView(v);
    saveView(viewKey, v);
  };
  const teams = useQuery(teamsQuery).data ?? [];

  const { data, error, isPending, dataUpdatedAt } = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await supabase.from("team_live").select("*");
      if (error) throw error;
      // The viewer's own row isn't part of their team view.
      return data.filter((r) => r.user_id !== profile.id);
    },
  });

  const projects = useQuery(projectsQuery).data;
  const projectName = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p.name])),
    [projects],
  );

  // DSH-02: a team narrows the summary and the rows alike.
  const rows = useMemo(() => inTeam(data ?? [], team), [data, team]);
  const summary = useMemo(() => summarize(rows), [rows]);
  const visible = useMemo(
    () => sortRows(filterRows(onShift(rows), status, search), sort),
    [rows, status, search, sort],
  );
  // Seats show everyone the viewer can see, off shift too (a red chair), in name order.
  const seated = useMemo(() => filterRows(rows, status, search), [rows, status, search]);
  const zone = viewerZone();
  const seats = view === "seats";

  const list = (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      {error ? (
        <p role="alert" className="p-6 text-sm text-warnink">
          Couldn't load the team: {error.message}
        </p>
      ) : isPending ? (
        <p className="p-6 text-sm text-ink2">Loading…</p>
      ) : visible.length === 0 ? (
        <Empty filtered={onShift(data ?? []).length > 0} />
      ) : (
        <table className="w-full border-collapse text-[13.5px]">
          <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
            <tr className="h-10 border-b border-line">
              <th className="px-5 font-medium">Person</th>
              <th className="font-medium">Status</th>
              <th className="font-medium">Last check-in</th>
              <th className="font-medium">Today</th>
              <th className="font-medium">Project</th>
              <th className="pr-5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <Row
                key={r.user_id}
                row={r}
                now={now}
                project={(r.project_id && projectName.get(r.project_id)) || null}
              />
            ))}
          </tbody>
        </table>
      )}
      <p className="px-5 py-3 text-xs text-ink3">
        "Today" is check-ins passed out of check-ins shown. Captures you open are logged and visible
        to the employee.
      </p>
    </div>
  );

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">Live team</h1>
          <p className="mt-1 text-[13.5px] text-ink2">{profile.orgName}</p>
        </div>
        <span className="ml-auto font-mono text-[12.5px] text-ink3" aria-live="polite">
          {live === "live" ? "Live" : live === "reconnecting" ? "Reconnecting…" : "Connecting…"}
          {dataUpdatedAt
            ? ` · updated ${formatTime(new Date(dataUpdatedAt).toISOString(), zone, zone)}`
            : ""}
        </span>
        <ExportButton
          title="Live team"
          ready={!!data}
          spec={{
            page: "live-team",
            filters: {
              view: seats ? "Seats" : "",
              status:
                status === "all" ? "" : status === "tamper" ? "Tamper" : statusStyle[status].label,
              team: team ? (teams.find((t) => t.id === team)?.name ?? team) : "",
              search: search.trim(),
            },
            // The snapshot on screen: the list's rows in its order, or the seats (off
            // shift too, in name order).
            table: () =>
              liveTeamTable(
                seats ? sortRows(seated, "name") : visible,
                (id) => (id ? (teams.find((t) => t.id === id)?.name ?? "") : ""),
                (id) => (id ? (projectName.get(id) ?? "") : ""),
                zone,
              ),
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-xl border border-line bg-panel p-4 md:grid-cols-5 md:p-5">
        <Tile label="On shift" n={summary.onShift} note={`of ${summary.scheduled} scheduled`} />
        <Tile label="Active" status="active" n={summary.active} />
        <Tile
          label="Away"
          status="away"
          n={summary.away}
          note={summary.missed ? `${summary.missed} missed check-in` : ""}
        />
        <Tile label="On break" status="on_break" n={summary.onBreak} />
        <Tile label="Offline" status="offline" n={summary.offline} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="m-0 hidden gap-2 border-0 p-0 md:flex">
          <legend className="sr-only">View</legend>
          {(["list", "seats"] as const).map((v) => (
            <Button
              key={v}
              variant="secondary"
              className={cn("h-10", view === v && "border-acc bg-accsoft text-acctext")}
              aria-pressed={view === v}
              onClick={() => chooseView(v)}
            >
              {v === "list" ? "List" : "Seats"}
            </Button>
          ))}
        </fieldset>
        <label className="flex h-10 items-center gap-2 rounded-[9px] border border-line2 bg-panel px-3 text-[13.5px]">
          <span className="text-ink3">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as PresenceStatus | "all")}
            className="bg-transparent font-medium"
          >
            <option value="all">All</option>
            {(Object.keys(statusStyle) as PresenceStatus[])
              .filter((s) => s !== "off_shift")
              .map((s) => (
                <option key={s} value={s}>
                  {s === "tamper" ? "Tamper" : statusStyle[s].label}
                </option>
              ))}
          </select>
        </label>
        {teams.length > 0 && (
          <label className="flex h-10 items-center gap-2 rounded-[9px] border border-line2 bg-panel px-3 text-[13.5px]">
            <span className="text-ink3">Team</span>
            <select
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              className="bg-transparent font-medium"
            >
              <option value="">All</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* Seats keep name order so nobody moves; sorting is for the list. */}
        <label
          className={cn(
            "flex h-10 items-center gap-2 rounded-[9px] border border-line2 bg-panel px-3 text-[13.5px]",
            seats && "md:hidden",
          )}
        >
          <span className="text-ink3">Sort</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="bg-transparent font-medium"
          >
            <option value="status">Status</option>
            <option value="name">Name</option>
            <option value="last_checkin">Last check-in</option>
          </select>
        </label>
        <input
          type="search"
          aria-label="Search people"
          placeholder="Search people"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-10 w-full rounded-[9px] border border-line2 bg-panel px-3 text-[13.5px] md:ml-auto md:w-[280px]"
        />
      </div>

      {seats ? (
        <>
          {/* Phones keep the list (#251); the seats need a laptop-width screen. */}
          <div className="md:hidden">{list}</div>
          <div className="hidden overflow-hidden rounded-xl border border-line bg-panel md:block">
            {error ? (
              <p role="alert" className="p-6 text-sm text-warnink">
                Couldn't load the team: {error.message}
              </p>
            ) : isPending ? (
              <p className="p-6 text-sm text-ink2">Loading…</p>
            ) : seated.length === 0 ? (
              <Empty filtered={rows.length > 0} />
            ) : (
              <SeatMap
                rows={seated}
                teams={teams}
                teamId={team}
                zone={zone}
                now={now}
                projectName={projectName}
              />
            )}
          </div>
        </>
      ) : (
        list
      )}
    </section>
  );
}

function Tile({
  label,
  n,
  note,
  status,
}: {
  label: string;
  n: number;
  note?: string;
  status?: PresenceStatus;
}) {
  return (
    <div className="flex flex-col gap-1 border-l border-line pl-3.5">
      <span className="flex items-center gap-[7px] text-[13px] text-ink2">
        {status ? (
          <StatusChipMark status={status} />
        ) : (
          <span className="h-2 w-2 rounded-full bg-ink" aria-hidden />
        )}
        {label}
      </span>
      <span className="font-mono text-[30px] leading-[1.1] font-medium tracking-[-0.04em]">
        {n}
      </span>
      <span className="min-h-4 text-xs text-ink3">{note}</span>
    </div>
  );
}

function StatusChipMark({ status }: { status: PresenceStatus }) {
  const { color, shape } = statusStyle[status];
  const round = shape === "square" ? "2px" : "50%";
  return shape === "ring" ? (
    <span aria-hidden className="h-2 w-2 rounded-full" style={{ border: `2px solid ${color}` }} />
  ) : (
    <span aria-hidden className="h-2 w-2" style={{ background: color, borderRadius: round }} />
  );
}

function Row({ row, now, project }: { row: TeamRow; now: Date; project: string | null }) {
  const zone = viewerZone();
  const missed = row.last_checkin_outcome === "miss" || row.last_checkin_outcome === "failed";
  return (
    <tr className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-b border-line px-4 py-3 hover:bg-sunk md:table-row md:p-0">
      <td className="row-span-3 md:py-3 md:pl-5">
        <div className="flex items-center gap-[11px]">
          <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full border border-line bg-sunk text-xs font-semibold text-ink2">
            {initials(row.full_name ?? "")}
          </span>
          <div className="hidden md:block">
            <div className="font-medium">{row.full_name}</div>
            <div className="mt-px text-xs text-ink3 capitalize">{row.role}</div>
          </div>
        </div>
      </td>
      <td className="font-medium md:hidden">{row.full_name}</td>
      <td>
        <span className="inline-flex items-center gap-1.5">
          <StatusChip
            status={(row.status ?? "off_shift") as PresenceStatus}
            reason={row.tamper_reason}
          />
          <span className="text-[12.5px] text-ink3">· {since(row.since, now)}</span>
        </span>
      </td>
      <td>
        {row.last_checkin_at ? (
          <span className="flex items-center gap-2">
            <time
              className="font-mono text-[12.5px]"
              dateTime={row.last_checkin_at}
              title={
                row.timezone
                  ? `${formatTime(row.last_checkin_at, row.timezone, zone)} employee's time`
                  : undefined
              }
            >
              {formatTime(row.last_checkin_at, zone, zone)}
            </time>
            <span
              className={
                missed
                  ? "rounded-full border border-dashed border-ink3 px-[7px] py-px text-xs font-semibold"
                  : "text-[12.5px] text-ink3"
              }
            >
              {row.last_checkin_outcome === "pass"
                ? "passed"
                : row.last_checkin_outcome === "miss"
                  ? "missed"
                  : "failed"}
            </span>
          </span>
        ) : (
          <span className="text-[12.5px] text-ink3">No check-in yet</span>
        )}
      </td>
      <td className="text-ink2 tabular-nums">
        {row.checkins_passed_today} of {row.checkins_shown_today}
      </td>
      <td className="truncate text-ink2">{project ?? "—"}</td>
      <td className="md:pr-5 md:text-right">
        <Link
          to="/team/$userId"
          params={{ userId: row.user_id ?? "" }}
          className="inline-block py-3 text-[13px] font-medium whitespace-nowrap text-acctext"
        >
          View day<span className="sr-only"> for {row.full_name}</span>
        </Link>
      </td>
    </tr>
  );
}

function Empty({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <span
        aria-hidden
        className="mb-1.5 h-10 w-10 rounded-full border-[1.5px] border-dashed border-line2"
      />
      <p className="text-base font-semibold">
        {filtered ? "No one matches these filters." : "No one is on shift right now."}
      </p>
      {!filtered && (
        <p className="max-w-[380px] text-[13.5px] text-ink2">
          People appear here as soon as they clock in.
        </p>
      )}
    </div>
  );
}
