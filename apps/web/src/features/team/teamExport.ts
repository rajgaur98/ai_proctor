// The live grid's export (#255 part 2, TS-27/28): the snapshot the viewer is looking at,
// one row per person in the page's order, with the page's filters already applied.
// Pure, so the columns are unit-tested.
import { type PresenceStatus, statusLabel } from "../../components/StatusChip";
import { type ExportTable, exportTime } from "../../lib/exportFile";
import type { TeamRow } from "./grid";

const outcomeText: Record<string, string> = { pass: "Passed", miss: "Missed", failed: "Failed" };

export const LIVE_TEAM_HEADER = [
  "Name",
  "Team",
  "Status",
  "Since",
  "Last check-in",
  "Last check-in result",
  "Check-ins passed today",
  "Check-ins shown today",
  "Project",
];

/**
 * `rows` as the page shows them; `teamName` and `projectName` name the ids the viewer can
 * read ("" when there is none). Times are ISO 8601 with the viewer's offset (`zone`).
 */
export function liveTeamTable(
  rows: readonly TeamRow[],
  teamName: (id: string | null) => string,
  projectName: (id: string | null) => string,
  zone: string,
): ExportTable {
  return {
    sheet: "Live team",
    header: LIVE_TEAM_HEADER,
    rows: rows.map((r) => [
      r.full_name ?? "",
      teamName(r.team_id),
      statusLabel((r.status ?? "off_shift") as PresenceStatus, r.tamper_reason),
      exportTime(r.since, zone),
      exportTime(r.last_checkin_at, zone),
      r.last_checkin_outcome ? (outcomeText[r.last_checkin_outcome] ?? r.last_checkin_outcome) : "",
      r.checkins_passed_today ?? 0,
      r.checkins_shown_today ?? 0,
      projectName(r.project_id),
    ]),
  };
}
