// Pure helpers for the live grid (DSH-01/02), kept out of the component so they
// can be unit-tested.
import type { Tables } from "@ai-proctor/contracts";
import type { PresenceStatus } from "../../components/StatusChip";

export type TeamRow = Tables<"team_live">;
export type SortKey = "name" | "status" | "last_checkin";

/** Display order: what needs a manager's eye first (PRD 4.6 priority). */
const statusRank: Record<PresenceStatus, number> = {
  tamper: 0,
  offline: 1,
  away: 2,
  away_locked: 3,
  idle: 4,
  in_meeting: 5,
  on_break: 6,
  paused: 7,
  active: 8,
  off_shift: 9,
};

export function onShift(rows: TeamRow[]): TeamRow[] {
  return rows.filter((r) => r.status && r.status !== "off_shift");
}

export function sortRows(rows: TeamRow[], key: SortKey): TeamRow[] {
  const byName = (a: TeamRow, b: TeamRow) => (a.full_name ?? "").localeCompare(b.full_name ?? "");
  const sorted = [...rows];
  switch (key) {
    case "name":
      return sorted.sort(byName);
    case "status":
      return sorted.sort(
        (a, b) =>
          statusRank[(a.status ?? "off_shift") as PresenceStatus] -
            statusRank[(b.status ?? "off_shift") as PresenceStatus] || byName(a, b),
      );
    case "last_checkin":
      return sorted.sort(
        (a, b) => (b.last_checkin_at ?? "").localeCompare(a.last_checkin_at ?? "") || byName(a, b),
      );
  }
}

export function filterRows(
  rows: TeamRow[],
  status: PresenceStatus | "all",
  search: string,
): TeamRow[] {
  const q = search.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (status === "all" || r.status === status) &&
      (!q || (r.full_name ?? "").toLowerCase().includes(q)),
  );
}

export interface Summary {
  onShift: number;
  scheduled: number;
  /** Working: active, in a meeting or paused (the design counts them together). */
  active: number;
  away: number;
  missed: number;
  onBreak: number;
  offline: number;
}

export function summarize(rows: TeamRow[]): Summary {
  const live = onShift(rows);
  const count = (...s: PresenceStatus[]) =>
    live.filter((r) => s.includes(r.status as PresenceStatus)).length;
  return {
    onShift: live.length,
    scheduled: rows.filter((r) => r.scheduled_today).length,
    active: count("active", "in_meeting", "paused", "idle"),
    away: count("away", "away_locked"),
    missed: live.filter(
      (r) => r.last_checkin_outcome === "miss" || r.last_checkin_outcome === "failed",
    ).length,
    onBreak: count("on_break"),
    offline: count("offline", "tamper"),
  };
}

/** "6 min", "1 h 05 min" — time in the current status. */
export function since(iso: string | null, now: Date): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Applies a Realtime presence change to the cached rows. */
export function applyPresence(
  rows: TeamRow[],
  change: Partial<Tables<"presence">> & { user_id: string },
): TeamRow[] {
  return rows.map((r) =>
    r.user_id === change.user_id
      ? {
          ...r,
          status: change.status ?? r.status,
          since: change.since ?? r.since,
          last_checkin_at: change.last_checkin_at ?? r.last_checkin_at,
          last_checkin_outcome: change.last_checkin_outcome ?? r.last_checkin_outcome,
          project_id: change.project_id === undefined ? r.project_id : change.project_id,
          tamper_reason:
            change.tamper_reason === undefined ? r.tamper_reason : change.tamper_reason,
        }
      : r,
  );
}
