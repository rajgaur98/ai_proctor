import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildExport,
  clockHours,
  decimalHours,
  type ExportSegment,
  type ExportView,
  exportCsv,
  exportFilename,
  formatTable,
  fromDbRow,
  sumSegments,
} from "./exportRows.ts";

const seg = (over: Partial<ExportSegment> = {}): ExportSegment => ({
  userId: "u1",
  employee: "Erin Employee",
  email: "erin@acme.test",
  timezone: "America/Los_Angeles",
  day: "2026-03-16",
  startLocal: "2026-03-16 09:00:00",
  endLocal: "2026-03-16 10:00:00",
  type: "verified",
  projectId: "p1",
  project: "Website revamp",
  client: "Acme",
  billable: true,
  counted: true,
  flagged: false,
  excluded: false,
  seconds: 3600,
  status: "draft",
  approver: null,
  ...over,
});

describe("decimalHours and clockHours", () => {
  it("shows 2 decimals and H:MM", () => {
    expect(decimalHours(26760)).toBe("7.43");
    expect(clockHours(26760)).toBe("7:26");
    expect(decimalHours(0)).toBe("0.00");
    expect(clockHours(0)).toBe("0:00");
    expect(decimalHours(3600 * 120)).toBe("120.00");
    expect(clockHours(3600 * 120 + 59 * 60)).toBe("120:59");
  });

  it("rounds half up, like the dashboard's minutes", () => {
    expect(decimalHours(18)).toBe("0.01");
    expect(decimalHours(17)).toBe("0.00");
    expect(clockHours(30)).toBe("0:01");
    expect(clockHours(29)).toBe("0:00");
    expect(clockHours(3599)).toBe("1:00");
  });

  it("is always d.dd within half a hundredth, and H:MM matches the rounded minutes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3600 * 2000 }), (s) => {
        const dec = decimalHours(s);
        expect(dec).toMatch(/^\d+\.\d{2}$/);
        expect(Math.abs(Number(dec) - s / 3600)).toBeLessThanOrEqual(0.005 + 1e-9);
        const [h, m] = clockHours(s).split(":").map(Number);
        expect(clockHours(s)).toMatch(/^\d+:\d{2}$/);
        expect((h ?? 0) * 60 + (m ?? 0)).toBe(Math.round(s / 60));
      }),
    );
  });
});

describe("totals", () => {
  it("counts like the dashboard", () => {
    const t = sumSegments([
      seg({ seconds: 3600 }),
      seg({ type: "idle", flagged: true, seconds: 600 }),
      seg({ type: "unverified", flagged: true, excluded: true, seconds: 300 }),
      seg({ type: "break", counted: false, seconds: 900 }),
      seg({ type: "manual", seconds: 1800, projectId: null, project: null, client: null }),
    ]);
    expect(t).toEqual({
      worked: 3600 + 600 + 1800,
      flagged: 600,
      excluded: 300,
      breakTime: 900,
      manual: 1800,
      billable: 3600 + 600,
      nonBillable: 1800,
    });
  });
});

describe("views", () => {
  const segs = [
    seg({ seconds: 7200 }),
    seg({ day: "2026-03-17", startLocal: "2026-03-17 09:00:00", seconds: 3600 }),
    seg({
      day: "2026-03-17",
      startLocal: "2026-03-17 11:00:00",
      projectId: null,
      project: null,
      client: null,
      billable: false,
      seconds: 1800,
    }),
    seg({
      userId: "u2",
      employee: "Lucas Martin",
      email: "lucas@acme.test",
      projectId: "p2",
      project: "Retainer",
      client: null,
      billable: false,
      seconds: 900,
      status: "approved",
      approver: "Max Manager",
    }),
  ];

  it("daily: one row per employee and day", () => {
    const lines = formatTable(buildExport("daily", segs));
    expect(lines[0]?.slice(0, 5)).toEqual([
      "Employee",
      "Email",
      "Date",
      "Worked (h)",
      "Worked (H:MM)",
    ]);
    expect(lines.slice(1, -1).map((l) => l.slice(0, 5))).toEqual([
      ["Erin Employee", "erin@acme.test", "2026-03-16", "2.00", "2:00"],
      ["Erin Employee", "erin@acme.test", "2026-03-17", "1.50", "1:30"],
      ["Lucas Martin", "lucas@acme.test", "2026-03-16", "0.25", "0:15"],
    ]);
    expect(lines.at(-1)?.slice(0, 5)).toEqual(["Total", "", "", "3.75", "3:45"]);
  });

  it("project: Unassigned is its own row, last for the person", () => {
    const lines = formatTable(buildExport("project", segs));
    expect(lines[0]?.slice(0, 5)).toEqual(["Employee", "Email", "Client", "Project", "Billable"]);
    expect(lines.slice(1, -1).map((l) => [l[0], l[2], l[3], l[4], l[5]])).toEqual([
      ["Erin Employee", "Acme", "Website revamp", "Yes", "3.00"],
      ["Erin Employee", "", "Unassigned", "No", "0.50"],
      ["Lucas Martin", "", "Retainer", "No", "0.25"],
    ]);
  });

  it("project: a mixed-status row says so and lists the approvers", () => {
    const lines = formatTable(
      buildExport("project", [
        seg({ status: "approved", approver: "Max Manager" }),
        seg({ day: "2026-03-23", status: "submitted" }),
      ]),
    );
    expect(lines[1]?.slice(-2)).toEqual(["Mixed", "Max Manager"]);
  });

  it("segments: one row per segment with local times", () => {
    const lines = formatTable(buildExport("segments", segs));
    expect(lines).toHaveLength(segs.length + 2);
    expect(lines[0]?.slice(0, 10)).toEqual([
      "Employee",
      "Email",
      "Date",
      "Start",
      "End",
      "Time zone",
      "Type",
      "Client",
      "Project",
      "Billable",
    ]);
    expect(lines[1]?.slice(0, 10)).toEqual([
      "Erin Employee",
      "erin@acme.test",
      "2026-03-16",
      "2026-03-16 09:00:00",
      "2026-03-16 10:00:00",
      "America/Los_Angeles",
      "verified",
      "Acme",
      "Website revamp",
      "Yes",
    ]);
  });

  it("ends with Status and Approver columns", () => {
    const lines = formatTable(buildExport("daily", segs));
    expect(lines[0]?.slice(-2)).toEqual(["Status", "Approver"]);
    expect(lines.at(-2)?.slice(-2)).toEqual(["approved", "Max Manager"]);
  });

  it("the total is summed from raw seconds, never from rounded rows", () => {
    // Three 20-minute-and-one-second blocks: each row rounds to 0.33 h (3 x 0.33 = 0.99),
    // the true total of 3603 s is 1.0008 h.
    const days = ["2026-03-16", "2026-03-17", "2026-03-18"];
    const lines = formatTable(
      buildExport(
        "daily",
        days.map((day) => seg({ day, seconds: 1201 })),
      ),
    );
    expect(lines.slice(1, -1).map((l) => l[3])).toEqual(["0.33", "0.33", "0.33"]);
    expect(lines.at(-1)?.[3]).toBe("1.00");
  });

  it("quotes and guards through the CSV writer", () => {
    const csv = exportCsv("daily", [seg({ employee: "=Evil, Inc" })]);
    expect(csv.split("\r\n")[1]?.startsWith(`"'=Evil, Inc",`)).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("names the file after the view and range", () => {
    expect(exportFilename("segments", "2026-03-16", "2026-03-22")).toBe(
      "timesheet-segments-2026-03-16_2026-03-22.csv",
    );
  });

  it("maps a database row", () => {
    const s = fromDbRow({
      user_id: "u1",
      employee: "Erin Employee",
      email: "erin@acme.test",
      timezone: "UTC",
      day: "2026-03-16",
      start_local: "2026-03-16 09:00:00",
      end_local: "2026-03-16 10:00:00",
      type: "verified",
      project_id: null,
      project: null,
      client: null,
      billable: false,
      counted: true,
      flagged: false,
      excluded: false,
      seconds: 3600,
      status: "draft",
      approver: null,
    });
    expect(s.userId).toBe("u1");
    expect(s.seconds).toBe(3600);
  });
});

describe("export properties", () => {
  const types = ["verified", "meeting", "idle", "unverified", "away", "offline", "break", "manual"];
  const segment = fc
    .record({
      user: fc.constantFrom("u1", "u2", "u3"),
      tick: fc.integer({ min: 0, max: 59 }),
      day: fc.constantFrom("2026-03-16", "2026-03-17", "2026-03-18"),
      type: fc.constantFrom(...types),
      project: fc.constantFrom(null, "p1", "p2", "p3"),
      billable: fc.boolean(),
      counted: fc.boolean(),
      flagged: fc.boolean(),
      excluded: fc.boolean(),
      seconds: fc.integer({ min: 1, max: 4 * 3600 }),
      status: fc.constantFrom("draft", "submitted", "approved", "returned"),
    })
    .map((r): ExportSegment => {
      const assigned = r.project !== null;
      return {
        userId: r.user,
        employee: `Person ${r.user}`,
        email: `${r.user}@acme.test`,
        timezone: "UTC",
        day: r.day,
        startLocal: `${r.day} 00:00:${String(r.tick).padStart(2, "0")}`,
        endLocal: `${r.day} 01:00:00`,
        type: r.type,
        projectId: r.project,
        project: assigned ? `Project ${r.project}` : null,
        client: assigned ? `Client ${r.project}` : null,
        billable: assigned && r.billable,
        counted: r.counted,
        flagged: r.flagged,
        // Only flagged time is ever excluded (TS-02).
        excluded: r.flagged && r.excluded,
        seconds: r.seconds,
        status: r.status,
        approver: null,
      };
    });
  const segments = fc.array(segment, { maxLength: 40 });
  const views: ExportView[] = ["daily", "project", "segments"];

  it("the total equals the sum of raw segment seconds, and so do the rows", () => {
    fc.assert(
      fc.property(segments, fc.constantFrom(...views), (segs, view) => {
        const table = buildExport(view, segs);
        const raw = {
          worked: segs.filter((s) => s.counted && !s.excluded).reduce((a, s) => a + s.seconds, 0),
          flagged: segs.filter((s) => s.flagged && !s.excluded).reduce((a, s) => a + s.seconds, 0),
          excluded: segs.filter((s) => s.excluded).reduce((a, s) => a + s.seconds, 0),
          breakTime: segs.filter((s) => s.type === "break").reduce((a, s) => a + s.seconds, 0),
          manual: segs
            .filter((s) => s.counted && !s.excluded && s.type === "manual")
            .reduce((a, s) => a + s.seconds, 0),
        };
        expect(table.total).toMatchObject(raw);
        for (const key of Object.keys(table.total) as (keyof typeof table.total)[]) {
          expect(table.rows.reduce((a, r) => a + r.seconds[key], 0)).toBe(table.total[key]);
        }
      }),
    );
  });

  it("billable plus non-billable is worked, in every row and in total", () => {
    fc.assert(
      fc.property(segments, fc.constantFrom(...views), (segs, view) => {
        const table = buildExport(view, segs);
        expect(table.total.billable + table.total.nonBillable).toBe(table.total.worked);
        for (const r of table.rows)
          expect(r.seconds.billable + r.seconds.nonBillable).toBe(r.seconds.worked);
      }),
    );
  });

  it("the Total line is the formatted raw total", () => {
    fc.assert(
      fc.property(segments, fc.constantFrom(...views), (segs, view) => {
        const lines = formatTable(buildExport(view, segs));
        const total = sumSegments(segs);
        const last = lines.at(-1) ?? [];
        const worked = last.length - 2 - 14;
        expect(last[worked]).toBe(decimalHours(total.worked));
        expect(last[worked + 1]).toBe(clockHours(total.worked));
        // Every line has the header's width.
        for (const l of lines) expect(l).toHaveLength(lines[0]?.length ?? 0);
      }),
    );
  });

  it("project view: Unassigned is one row per person holding exactly the unassigned time", () => {
    fc.assert(
      fc.property(segments, (segs) => {
        const table = buildExport("project", segs);
        for (const user of new Set(segs.map((s) => s.userId))) {
          const mine = segs.filter((s) => s.userId === user);
          const unassigned = sumSegments(mine.filter((s) => s.projectId === null));
          const email = `${user}@acme.test`;
          const rows = table.rows.filter(
            (r) => r.labels[1] === email && r.labels[3] === "Unassigned",
          );
          if (mine.some((s) => s.projectId === null)) {
            expect(rows).toHaveLength(1);
            expect(rows[0]?.seconds).toEqual(unassigned);
          } else {
            expect(rows).toHaveLength(0);
          }
          const distinct = new Set(mine.map((s) => s.projectId));
          expect(table.rows.filter((r) => r.labels[1] === email)).toHaveLength(distinct.size);
        }
      }),
    );
  });

  it("daily has a row per person and day, segments one per segment", () => {
    fc.assert(
      fc.property(segments, (segs) => {
        expect(buildExport("daily", segs).rows).toHaveLength(
          new Set(segs.map((s) => `${s.userId}|${s.day}`)).size,
        );
        expect(buildExport("segments", segs).rows).toHaveLength(segs.length);
      }),
    );
  });
});
