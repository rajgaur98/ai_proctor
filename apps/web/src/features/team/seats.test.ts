import { describe, expect, it } from "vitest";
import type { PresenceStatus } from "../../components/StatusChip";
import type { TeamRow } from "./grid";
import {
  CHAIR_SIZE,
  nextSeat,
  seatName,
  seatTables,
  seatTone,
  splitTables,
  spreadSeats,
  TABLE_RADIUS,
  TABLE_SEATS,
  TABLE_STRAIGHT,
  TABLE_VIEW,
  tableSeats,
} from "./seats";

function row(name: string, extra: Partial<TeamRow> = {}): TeamRow {
  return {
    user_id: name,
    org_id: "o",
    full_name: name,
    role: "employee",
    manager_id: "m",
    timezone: "UTC",
    status: "active",
    since: "2026-10-19T10:05:00Z",
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

const people = (n: number, extra: Partial<TeamRow> = {}) =>
  Array.from({ length: n }, (_, i) => row(`P${String(i).padStart(2, "0")}`, extra));

describe("tableSeats", () => {
  const seats = tableSeats();
  const cx = TABLE_VIEW.width / 2;
  const cy = TABLE_VIEW.height / 2;

  it("has 22 chairs: seven on each long side and four round each end", () => {
    expect(seats).toHaveLength(TABLE_SEATS);
    expect(seats.filter((s) => s.rotate === 0)).toHaveLength(7);
    expect(seats.filter((s) => s.rotate === 180)).toHaveLength(7);
    expect(seats.filter((s) => s.x > cx + TABLE_STRAIGHT / 2)).toHaveLength(4);
    expect(seats.filter((s) => s.x < cx - TABLE_STRAIGHT / 2)).toHaveLength(4);
  });

  it("keeps every chair inside the drawing and clear of the table and each other", () => {
    const half = CHAIR_SIZE / 2;
    for (const s of seats) {
      expect(s.x - half).toBeGreaterThanOrEqual(0);
      expect(s.x + half).toBeLessThanOrEqual(TABLE_VIEW.width);
      expect(s.y - half).toBeGreaterThanOrEqual(0);
      expect(s.y + half).toBeLessThanOrEqual(TABLE_VIEW.height);
      // Distance from the chair's centre to the table (a stadium shape).
      const nearestX = Math.min(Math.max(s.x, cx - TABLE_STRAIGHT / 2), cx + TABLE_STRAIGHT / 2);
      const toTable = Math.hypot(s.x - nearestX, s.y - cy) - TABLE_RADIUS;
      expect(toTable).toBeGreaterThan(half);
    }
    for (const [i, a] of seats.entries()) {
      for (const b of seats.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(CHAIR_SIZE);
      }
    }
  });

  it("goes clockwise from the top-left", () => {
    const angle = (s: { x: number; y: number }) =>
      (Math.atan2(s.y - cy, s.x - cx) + 2 * Math.PI + Math.PI / 2) % (2 * Math.PI);
    // Clockwise on screen (y down) from the top-left chair: the angle only grows.
    const first = seats[0];
    expect(first && first.x < cx && first.y < cy).toBe(true);
    const start = angle(first ?? { x: 0, y: 0 });
    const turned = seats.map((s) => (angle(s) - start + 2 * Math.PI) % (2 * Math.PI));
    expect(turned).toEqual([...turned].sort((a, b) => a - b));
  });

  it("turns every chair to face the table", () => {
    for (const s of seats) {
      const facing = ((s.rotate + 90) * Math.PI) / 180; // a chair drawn facing down
      const ahead = { x: s.x + 40 * Math.cos(facing), y: s.y + 40 * Math.sin(facing) };
      expect(Math.hypot(ahead.x - cx, ahead.y - cy)).toBeLessThan(Math.hypot(s.x - cx, s.y - cy));
    }
  });
});

describe("spreadSeats", () => {
  it("spreads a few people round the table and fills it when full", () => {
    expect(spreadSeats(0)).toEqual([]);
    expect(spreadSeats(1)).toEqual([0]);
    expect(spreadSeats(2)).toEqual([0, 11]);
    expect(spreadSeats(4)).toEqual([0, 5, 11, 16]);
    expect(spreadSeats(22)).toEqual(Array.from({ length: 22 }, (_, i) => i));
  });

  it("gives everyone their own chair", () => {
    for (let n = 1; n <= TABLE_SEATS; n++) {
      const s = spreadSeats(n);
      expect(new Set(s).size).toBe(n);
      expect(Math.max(...s)).toBeLessThan(TABLE_SEATS);
    }
  });
});

describe("splitTables", () => {
  it("uses as few tables as hold everyone, split evenly", () => {
    expect(splitTables(people(0))).toEqual([]);
    expect(splitTables(people(22)).map((t) => t.length)).toEqual([22]);
    expect(splitTables(people(23)).map((t) => t.length)).toEqual([12, 11]);
    expect(splitTables(people(45)).map((t) => t.length)).toEqual([15, 15, 15]);
    expect(splitTables(people(45)).flat()).toEqual(people(45));
  });
});

describe("seatTables", () => {
  const teams = [
    { id: "t1", name: "Design" },
    { id: "t2", name: "Support" },
    { id: "t3", name: "Empty" },
  ];
  const rows = [
    row("Zoe", { team_id: "t1" }),
    row("Arjun", { team_id: "t1" }),
    row("Priya", { team_id: "t2" }),
    row("Lucas"),
  ];

  it("gives each team its own table when every team is shown, then the people without one", () => {
    const tables = seatTables(rows, teams, "");
    expect(tables.map((t) => t.label)).toEqual(["Design", "Support", "No team"]);
    expect(tables[0]?.people.map((r) => r.full_name)).toEqual(["Arjun", "Zoe"]);
  });

  it("seats one picked team together, and everyone when the org has no teams", () => {
    expect(seatTables(rows.slice(0, 2), teams, "t1").map((t) => t.label)).toEqual(["Design"]);
    const all = seatTables(rows, [], "");
    expect(all.map((t) => t.label)).toEqual(["Everyone"]);
    expect(all[0]?.people.map((r) => r.full_name)).toEqual(["Arjun", "Lucas", "Priya", "Zoe"]);
  });

  it("opens more tables for a team bigger than one table", () => {
    const tables = seatTables(people(30, { team_id: "t2" }), teams, "");
    expect(tables.map((t) => [t.label, t.people.length])).toEqual([
      ["Support · table 1 of 2", 15],
      ["Support · table 2 of 2", 15],
    ]);
  });
});

describe("seatTone", () => {
  it("is green for Active only and red for everything else", () => {
    const red: (PresenceStatus | null)[] = [
      "idle",
      "away",
      "away_locked",
      "on_break",
      "paused",
      "in_meeting",
      "offline",
      "tamper",
      "off_shift",
      null,
    ];
    expect(seatTone("active")).toBe("active");
    for (const s of red) expect(seatTone(s)).toBe("inactive");
  });
});

describe("seatName", () => {
  it("names the person, the exact status and since when", () => {
    expect(seatName(row("Erin Employee", { status: "on_break" }), "UTC")).toBe(
      "Erin Employee, On break since 10:05",
    );
    expect(
      seatName(row("Erin Employee", { status: "tamper", tamper_reason: "agent_stopped" }), "UTC"),
    ).toBe("Erin Employee, Agent stopped since 10:05");
    expect(seatName(row("Erin Employee", { status: "off_shift", since: null }), "UTC")).toBe(
      "Erin Employee, Off shift",
    );
  });
});

describe("nextSeat", () => {
  it("moves round the table and wraps", () => {
    expect(nextSeat("ArrowRight", 0, 3)).toBe(1);
    expect(nextSeat("ArrowDown", 2, 3)).toBe(0);
    expect(nextSeat("ArrowLeft", 0, 3)).toBe(2);
    expect(nextSeat("ArrowUp", 1, 3)).toBe(0);
    expect(nextSeat("Home", 2, 3)).toBe(0);
    expect(nextSeat("End", 0, 3)).toBe(2);
    expect(nextSeat("Enter", 0, 3)).toBeNull();
    expect(nextSeat("ArrowRight", 0, 0)).toBeNull();
  });
});
