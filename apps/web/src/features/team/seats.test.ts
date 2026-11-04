import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type PresenceStatus, statusStyle } from "../../components/StatusChip";
import type { TeamRow } from "./grid";
import {
  CHAIR_SIZE,
  findSeats,
  inactiveLabels,
  LABEL_BAND,
  layoutKey,
  layoutSeats,
  MAX_SEATS,
  nextSeat,
  PER_END,
  seatGroups,
  seatName,
  seatTone,
  splitTables,
  TABLE_RADIUS,
  tableBody,
  tableLabel,
  tableSeats,
  tableShape,
  tablesBox,
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

const people = (n: number, extra: Partial<TeamRow> = {}, prefix = "P") =>
  Array.from({ length: n }, (_, i) => row(`${prefix}${String(i).padStart(4, "0")}`, extra));

const seatsFor = fc.integer({ min: 1, max: MAX_SEATS });

describe("tableShape", () => {
  it("has a chair for everyone and no empty ones", () => {
    fc.assert(
      fc.property(seatsFor, (n) => {
        const s = tableShape(n);
        expect(s.top + s.right + s.bottom + s.left).toBe(n);
        expect(tableSeats(n)).toHaveLength(n);
      }),
    );
  });

  it("keeps the ends' chairs and grows the long sides with the team", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2 * PER_END + 2, max: MAX_SEATS }), (n) => {
        const s = tableShape(n);
        expect(s.left).toBe(PER_END);
        expect(s.right).toBe(PER_END);
        expect(Math.abs(s.top - s.bottom)).toBeLessThanOrEqual(1);
      }),
    );
    // A bigger team never gets a shorter table.
    for (let n = 1; n < MAX_SEATS; n++) {
      expect(tableShape(n + 1).width).toBeGreaterThanOrEqual(tableShape(n).width);
    }
    expect(tableShape(3).width).toBeLessThan(tableShape(40).width);
  });

  it("is a small table for a team of 3 and a long one for 40", () => {
    expect(tableShape(3)).toMatchObject({ top: 1, right: 1, bottom: 1, left: 0 });
    expect(tableShape(40)).toMatchObject({ top: 18, right: 2, bottom: 18, left: 2 });
  });
});

describe("tableSeats", () => {
  it("keeps every chair inside the box and clear of the table and each other", () => {
    fc.assert(
      fc.property(seatsFor, (n) => {
        const shape = tableShape(n);
        const b = tableBody(shape);
        const seats = tableSeats(n);
        const half = CHAIR_SIZE / 2;
        for (const s of seats) {
          expect(s.x - half).toBeGreaterThanOrEqual(0);
          expect(s.x + half).toBeLessThanOrEqual(shape.width);
          expect(s.y - half).toBeGreaterThanOrEqual(LABEL_BAND);
          expect(s.y + half).toBeLessThanOrEqual(shape.height);
          // Distance from the chair's centre to the table (a stadium shape).
          const nearestX = Math.min(Math.max(s.x, b.left), b.right);
          expect(Math.hypot(s.x - nearestX, s.y - b.cy) - TABLE_RADIUS).toBeGreaterThan(half);
        }
        for (const [i, a] of seats.entries()) {
          for (const c of seats.slice(i + 1)) {
            expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeGreaterThan(CHAIR_SIZE);
          }
        }
      }),
    );
  });

  it("goes clockwise from the top-left", () => {
    fc.assert(
      fc.property(seatsFor, (n) => {
        const shape = tableShape(n);
        const { cx, cy } = tableBody(shape);
        const seats = tableSeats(n);
        // Clockwise on screen (y down), measured from straight up: the angle only grows.
        const angle = (s: { x: number; y: number }) =>
          (Math.atan2(s.y - cy, s.x - cx) + 2 * Math.PI + Math.PI / 2) % (2 * Math.PI);
        const start = angle(seats[0] ?? { x: 0, y: 0 });
        const turned = seats.map((s) => (angle(s) - start + 2 * Math.PI) % (2 * Math.PI));
        expect(turned).toEqual([...turned].sort((a, b) => a - b));
      }),
    );
  });

  it("turns every chair to face the table", () => {
    fc.assert(
      fc.property(seatsFor, (n) => {
        const { cy, left, right } = tableBody(tableShape(n));
        // Distance to the table's straight middle line: facing it means a step ahead gets closer.
        const near = (p: { x: number; y: number }) =>
          Math.hypot(p.x - Math.min(Math.max(p.x, left), right), p.y - cy);
        for (const s of tableSeats(n)) {
          const facing = ((s.rotate + 90) * Math.PI) / 180; // a chair drawn facing down
          const ahead = { x: s.x + 20 * Math.cos(facing), y: s.y + 20 * Math.sin(facing) };
          expect(near(ahead)).toBeLessThan(near(s));
        }
      }),
    );
  });
});

describe("splitTables", () => {
  it("uses as few tables as hold everyone, split evenly, in order", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), (n) => {
        const list = Array.from({ length: n }, (_, i) => i);
        const tables = splitTables(list);
        expect(tables).toHaveLength(Math.ceil(n / MAX_SEATS));
        expect(tables.flat()).toEqual(list);
        const sizes = tables.map((t) => t.length);
        if (sizes.length) {
          expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_SEATS);
          expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
        }
      }),
    );
    expect(splitTables(people(61)).map((t) => t.length)).toEqual([31, 30]);
  });
});

describe("seatGroups and layoutSeats", () => {
  const teams = [
    { id: "t2", name: "Support" },
    { id: "t1", name: "Design" },
    { id: "t3", name: "Empty" },
  ];
  const rows = [
    row("Zoe", { team_id: "t1" }),
    row("Arjun", { team_id: "t1" }),
    row("Priya", { team_id: "t2" }),
    row("Lucas"),
  ];

  it("groups by team in name order, people by name, then those without a team", () => {
    const groups = seatGroups(rows, teams);
    expect(groups.map((g) => g.name)).toEqual(["Design", "Support", "No team"]);
    expect(groups[0]?.people.map((r) => r.full_name)).toEqual(["Arjun", "Zoe"]);
    expect(seatGroups(rows, []).map((g) => g.name)).toEqual(["Everyone"]);
  });

  it("puts a team above the maximum on more tables with the same label", () => {
    const layout = layoutSeats(seatGroups(people(130, { team_id: "t2" }), teams));
    expect(layout.tables.map((t) => [t.name, t.people.length])).toEqual([
      ["Support", 44],
      ["Support", 43],
      ["Support", 43],
    ]);
    expect(layout.tables.map(tableLabel)).toEqual([
      "Support · table 1 of 3",
      "Support · table 2 of 3",
      "Support · table 3 of 3",
    ]);
  });

  const org = fc
    .array(
      fc.record({ team: fc.integer({ min: 0, max: 7 }), size: fc.integer({ min: 1, max: 90 }) }),
      {
        minLength: 1,
        maxLength: 12,
      },
    )
    .map((spec) => {
      const ts = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, name: `Team ${i}` }));
      const rs = spec.flatMap((s, j) => people(s.size, { team_id: `t${s.team}` }, `G${j}-`));
      return { teams: ts, rows: rs };
    });

  it("seats everyone exactly once, and no two tables overlap", () => {
    fc.assert(
      fc.property(org, ({ teams, rows }) => {
        const layout = layoutSeats(seatGroups(rows, teams));
        const seated = layout.tables.flatMap((t) => t.people);
        expect(seated.sort()).toEqual(rows.map((r) => r.user_id).sort());
        expect(layout.seatOf.size).toBe(rows.length);
        for (const [i, a] of layout.tables.entries()) {
          expect(a.x + a.w).toBeLessThanOrEqual(layout.width);
          expect(a.y + a.h).toBeLessThanOrEqual(layout.height);
          for (const b of layout.tables.slice(i + 1)) {
            const apart =
              a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
            expect(apart).toBe(true);
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it("is the same for the same people however the rows arrive, and statuses don't count", () => {
    fc.assert(
      fc.property(org, fc.integer(), ({ teams, rows }, seed) => {
        const shuffled = [...rows].sort((a, b) =>
          (seed ^ hash(a.user_id)) >>> 0 < (seed ^ hash(b.user_id)) >>> 0 ? -1 : 1,
        );
        const restatus = shuffled.map((r, i) => ({
          ...r,
          status: (i % 2 ? "away" : "active") as PresenceStatus,
          since: null,
        }));
        const a = layoutSeats(seatGroups(rows, teams));
        const b = layoutSeats(seatGroups(restatus, teams));
        expect(b.tables.map((t) => [t.key, t.x, t.y, t.people])).toEqual(
          a.tables.map((t) => [t.key, t.x, t.y, t.people]),
        );
      }),
      { numRuns: 40 },
    );
  });

  it("moves no table of an earlier team when someone joins or leaves a later one", () => {
    fc.assert(
      fc.property(org, fc.integer({ min: 0, max: 7 }), fc.boolean(), ({ teams, rows }, t, join) => {
        const team = `t${t}`;
        const changed = join
          ? [...rows, row("ZZ newcomer", { team_id: team })]
          : rows.filter(
              (r, i) => !(r.team_id === team && i === rows.findIndex((x) => x.team_id === team)),
            );
        const before = layoutSeats(seatGroups(rows, teams));
        const after = layoutSeats(seatGroups(changed, teams));
        const name = teams.find((x) => x.id === team)?.name ?? "";
        for (const tb of before.tables) {
          if (tb.name.localeCompare(name) >= 0) break;
          const ta = after.tables.find((x) => x.key === tb.key);
          // Unless the org grew enough to widen every row.
          if (after.rowWidth === before.rowWidth) expect([ta?.x, ta?.y]).toEqual([tb.x, tb.y]);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("usually moves nothing at all when one person joins", () => {
    const teams = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    const rows = [...people(18, { team_id: "a" }, "A"), ...people(18, { team_id: "b" }, "B")];
    const before = layoutSeats(seatGroups(rows, teams));
    const after = layoutSeats(seatGroups([...rows, row("A-new", { team_id: "a" })], teams));
    expect(after.tables.map((t) => [t.x, t.y])).toEqual(before.tables.map((t) => [t.x, t.y]));
  });
});

/** A cheap deterministic hash, for shuffling. */
function hash(s: string | null): number {
  let h = 0;
  for (const c of s ?? "") h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

describe("layoutKey", () => {
  it("ignores status, since, project and check-ins, and changes with names and teams", () => {
    const rows = people(5, { team_id: "t" });
    const teams = [{ id: "t", name: "T" }];
    const key = layoutKey(rows, teams);
    const live = rows.map((r) => ({
      ...r,
      status: "on_break" as const,
      since: "2026-11-05T10:00:00Z",
      project_id: "p",
      checkins_passed_today: 3,
    }));
    expect(layoutKey(live, teams)).toBe(key);
    expect(layoutKey(rows, [{ id: "t", name: "Renamed" }])).not.toBe(key);
    expect(layoutKey([...rows.slice(1), row("New", { team_id: "t" })], teams)).not.toBe(key);
    expect(
      layoutKey(
        rows.map((r, i) => (i ? r : { ...r, team_id: null })),
        teams,
      ),
    ).not.toBe(key);
  });
});

describe("findSeats", () => {
  const teams = [
    { id: "s", name: "Support" },
    { id: "d", name: "Design" },
  ];
  const rows = [
    row("Erin Employee", { team_id: "s" }),
    row("Lucas Martin", { team_id: "d" }),
    row("Sue Porter", { team_id: "d" }),
  ];
  const layout = layoutSeats(seatGroups(rows, teams));
  const nameOf = (id: string) => rows.find((r) => r.user_id === id)?.full_name ?? "";

  it("finds teams first, then people, in map order, ignoring case", () => {
    const found = findSeats(layout, nameOf, "su");
    expect(found.map((m) => (m.kind === "team" ? `team ${m.name}` : m.name))).toEqual([
      "team Support",
      "Sue Porter",
    ]);
    expect(findSeats(layout, nameOf, "  ")).toEqual([]);
    expect(findSeats(layout, nameOf, "nobody")).toEqual([]);
  });

  it("points at the right table and seat", () => {
    const [m] = findSeats(layout, nameOf, "lucas");
    expect(m?.kind).toBe("person");
    if (m?.kind !== "person") return;
    expect(layout.tables[m.table]?.people[m.seat]).toBe("Lucas Martin");
    const box = tablesBox(layout, [m.table]);
    expect(box).toMatchObject({ x: layout.tables[m.table]?.x, y: layout.tables[m.table]?.y });
  });
});

describe("seatTone", () => {
  it("is green for Active only and red for every other status, including new ones", () => {
    expect(seatTone("active")).toBe("active");
    for (const s of Object.keys(statusStyle) as PresenceStatus[]) {
      if (s !== "active") expect(seatTone(s)).toBe("inactive");
    }
    expect(seatTone(null)).toBe("inactive");
    expect(seatTone("on_leave" as PresenceStatus)).toBe("inactive");
  });

  it("names every not-active status in the legend from the status labels", () => {
    const labels = inactiveLabels();
    expect(labels).toHaveLength(Object.keys(statusStyle).length - 1);
    expect(labels).toContain("on break");
    expect(labels).not.toContain("active");
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
