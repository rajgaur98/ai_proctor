import { describe, expect, it } from "vitest";
import {
  applyPresence,
  filterRows,
  inTeam,
  since,
  sortRows,
  summarize,
  type TeamRow,
} from "./grid";

function row(name: string, status: TeamRow["status"], extra: Partial<TeamRow> = {}): TeamRow {
  return {
    user_id: name,
    org_id: "o",
    full_name: name,
    role: "employee",
    manager_id: "m",
    timezone: "UTC",
    status,
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

const rows = [
  row("Priya", "active", { last_checkin_at: "2026-10-19T09:21:00Z" }),
  row("Lucas", "away", { last_checkin_outcome: "miss", last_checkin_at: "2026-10-19T09:03:00Z" }),
  row("Emily", "offline"),
  row("Arjun", "paused"),
  row("Zoe", "off_shift", { scheduled_today: false }),
];

describe("summarize", () => {
  it("counts the design's summary tiles", () => {
    expect(summarize(rows)).toEqual({
      onShift: 4,
      scheduled: 4,
      active: 2,
      away: 1,
      missed: 1,
      onBreak: 0,
      offline: 1,
    });
  });
});

describe("sortRows", () => {
  it("puts what needs attention first when sorting by status", () => {
    expect(sortRows(rows, "status").map((r) => r.full_name)).toEqual([
      "Emily",
      "Lucas",
      "Arjun",
      "Priya",
      "Zoe",
    ]);
  });

  it("sorts by most recent check-in", () => {
    expect(
      sortRows(rows, "last_checkin")
        .map((r) => r.full_name)
        .slice(0, 2),
    ).toEqual(["Priya", "Lucas"]);
  });
});

describe("filterRows", () => {
  it("filters by status and name", () => {
    expect(filterRows(rows, "away", "").map((r) => r.full_name)).toEqual(["Lucas"]);
    expect(filterRows(rows, "all", "pri").map((r) => r.full_name)).toEqual(["Priya"]);
  });
});

describe("since", () => {
  it("formats time in status", () => {
    const now = new Date("2026-10-19T10:05:00Z");
    expect(since("2026-10-19T09:59:00Z", now)).toBe("6 min");
    expect(since("2026-10-19T09:00:00Z", now)).toBe("1 h 05 min");
  });
});

describe("applyPresence", () => {
  it("patches one person's live fields", () => {
    const next = applyPresence(rows, {
      user_id: "Lucas",
      status: "active",
      since: "2026-10-19T10:00:00Z",
    });
    expect(next.find((r) => r.user_id === "Lucas")?.status).toBe("active");
    expect(next.find((r) => r.user_id === "Priya")).toBe(rows[0]);
  });

  it("carries the Tamper reason, and clears it when the status moves on", () => {
    const blocked = applyPresence(rows, {
      user_id: "Emily",
      status: "tamper",
      tamper_reason: "capture_blocked",
    });
    expect(blocked.find((r) => r.user_id === "Emily")?.tamper_reason).toBe("capture_blocked");
    const back = applyPresence(blocked, {
      user_id: "Emily",
      status: "active",
      tamper_reason: null,
    });
    expect(back.find((r) => r.user_id === "Emily")?.tamper_reason).toBeNull();
  });
});

describe("inTeam", () => {
  it("keeps one team's rows, or everyone's", () => {
    const mixed = [
      row("Priya", "active", { team_id: "t1" }),
      row("Lucas", "away"),
      row("Emily", "offline", { team_id: "t2" }),
    ];
    expect(inTeam(mixed, "t1").map((r) => r.full_name)).toEqual(["Priya"]);
    expect(inTeam(mixed, "")).toHaveLength(3);
  });
});
