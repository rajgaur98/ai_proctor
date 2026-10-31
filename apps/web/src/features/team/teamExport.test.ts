import { describe, expect, it } from "vitest";
import type { TeamRow } from "./grid";
import { LIVE_TEAM_HEADER, liveTeamTable } from "./teamExport";

function row(extra: Partial<TeamRow>): TeamRow {
  return {
    user_id: "u1",
    org_id: "o",
    full_name: "Erin Employee",
    role: "employee",
    manager_id: "m",
    timezone: "UTC",
    status: "active",
    since: "2026-10-19T09:00:00Z",
    last_checkin_at: null,
    last_checkin_outcome: null,
    project_id: null,
    checkins_shown_today: 0,
    checkins_passed_today: 0,
    scheduled_today: true,
    tamper_reason: null,
    team_id: null,
    ...extra,
  };
}

const teams = (id: string | null) => (id === "t1" ? "Support" : "");
const projects = (id: string | null) => (id === "p1" ? "Website" : "");

describe("liveTeamTable", () => {
  it("has one row per person in the page's order, times with the viewer's offset", () => {
    const table = liveTeamTable(
      [
        row({
          full_name: "Erin Employee",
          team_id: "t1",
          project_id: "p1",
          last_checkin_at: "2026-10-19T10:15:30Z",
          last_checkin_outcome: "pass",
          checkins_passed_today: 3,
          checkins_shown_today: 4,
        }),
        row({ full_name: "Ada Admin", status: "away_locked", last_checkin_outcome: "miss" }),
      ],
      teams,
      projects,
      "Asia/Kolkata",
    );
    expect(table.sheet).toBe("Live team");
    expect(table.header).toEqual(LIVE_TEAM_HEADER);
    expect(table.rows).toEqual([
      [
        "Erin Employee",
        "Support",
        "Active",
        "2026-10-19T14:30:00+05:30",
        "2026-10-19T15:45:30+05:30",
        "Passed",
        3,
        4,
        "Website",
      ],
      ["Ada Admin", "", "Away · locked", "2026-10-19T14:30:00+05:30", "", "Missed", 0, 0, ""],
    ]);
  });

  it("names a Tamper status by its reason and reads a missing status as off shift", () => {
    const table = liveTeamTable(
      [
        row({ status: "tamper", tamper_reason: "agent_stopped" }),
        row({ status: null, since: null, checkins_passed_today: null }),
      ],
      teams,
      projects,
      "UTC",
    );
    expect(table.rows.map((r) => r[2])).toEqual(["Agent stopped", "Off shift"]);
    expect(table.rows[1]?.[3]).toBe("");
    expect(table.rows[1]?.[6]).toBe(0);
  });
});
