import { describe, expect, it } from "vitest";
import {
  bucketLabel,
  type Insights,
  parseInsights,
  peopleTable,
  projectChart,
  projectNames,
  projectsTable,
  reviewTable,
  share,
  summaryTable,
  trend,
  trendTable,
} from "./model";

const REVAMP = "p1";
const INTERNAL = "p2";
const DESIGN = "t1";

/** A reply as `insights` sends it (snake case, numbers that may come as strings). */
const reply = {
  from: "2026-03-16",
  to: "2026-03-22",
  previous_from: "2026-03-09",
  previous_to: "2026-03-15",
  bucket: "day",
  late_grace_min: 15,
  caps: { pause_max_min: 15, pause_daily_max_min: 60, break_daily_max_min: null },
  overtime: { daily_hours: 8, weekly_hours: null },
  billable_target_pct: 60,
  totals: {
    people: 2,
    worked_s: 23_400,
    billable_s: 10_800,
    unassigned_s: 5400,
    scheduled_s: 144_000,
    leave_s: 28_800,
    shift_days: 5,
    on_time: 3,
    late_clock_ins: 2,
    checkins_shown: 10,
    checkins_passed: 6,
    response_rate: 0.6,
    median_response_ms: 1500,
    anomaly_flags: 2,
    needs_review: 1,
    tamper: 1,
  },
  previous_totals: { people: 2, worked_s: "7200", response_rate: null, median_response_ms: null },
  people: [
    {
      user_id: "erin",
      full_name: "Erin Employee",
      team_id: "web",
      active: true,
      worked_s: 19_800,
      billable_s: 7200,
      leave_s: "28800",
      response_rate: 0.75,
      median_response_ms: 3000,
      shift_days: 4,
      on_time: 3,
    },
    { user_id: "ivan", full_name: "Ivan Inactive", team_id: null, active: false, worked_s: 3600 },
  ],
  series: [
    {
      bucket: "2026-03-16",
      worked_s: 19_800,
      leave_s: 28_800,
      response_rate: 0.75,
      median_response_ms: 1500,
    },
    { bucket: "2026-03-17", worked_s: 3600, response_rate: null, median_response_ms: null },
  ],
  projects: [
    {
      project_id: REVAMP,
      project_name: "Website revamp",
      client_id: "c1",
      client_name: "Northwind",
      task_id: null,
      task_name: null,
      billable: true,
      worked_s: 10_800,
      people: 2,
    },
    {
      project_id: REVAMP,
      project_name: "Website revamp",
      client_id: "c1",
      client_name: "Northwind",
      task_id: DESIGN,
      task_name: "Design",
      billable: false,
      worked_s: 3600,
      people: 1,
    },
    {
      project_id: INTERNAL,
      project_name: "Internal",
      client_id: null,
      client_name: null,
      task_id: null,
      task_name: null,
      billable: false,
      worked_s: 3600,
      people: 1,
    },
    {
      project_id: null,
      project_name: null,
      client_id: null,
      client_name: null,
      task_id: null,
      task_name: null,
      billable: false,
      worked_s: 5400,
      people: 1,
    },
  ],
  project_series: [
    { bucket: "2026-03-16", project_id: REVAMP, task_id: null, worked_s: 10_800 },
    { bucket: "2026-03-16", project_id: INTERNAL, task_id: null, worked_s: 3600 },
    { bucket: "2026-03-16", project_id: null, task_id: null, worked_s: 5400 },
    { bucket: "2026-03-17", project_id: REVAMP, task_id: DESIGN, worked_s: 3600 },
  ],
  teams: [
    {
      team_id: "web",
      name: "Web",
      billable_target_pct: 60,
      people: 1,
      worked_s: 19_800,
      billable_s: 7200,
    },
  ],
  review_days: [
    {
      user_id: "erin",
      full_name: "Erin Employee",
      day: "2026-03-17",
      anomaly_flags: 1,
      needs_review: 1,
      tamper: 0,
    },
  ],
  review_days_total: 1,
  people_options: [{ user_id: "erin", full_name: "Erin Employee", active: true }],
};

const data: Insights = parseInsights(reply);

describe("parseInsights", () => {
  it("reads the reply into typed numbers, zero for a missing one", () => {
    expect(data.bucket).toBe("day");
    expect(data.previousFrom).toBe("2026-03-09");
    expect(data.totals.worked_s).toBe(23_400);
    expect(data.totals.excluded_s).toBe(0);
    expect(data.previous.worked_s).toBe(7200);
    expect(data.previous.response_rate).toBeNull();
    expect(data.caps).toEqual({ pauseMaxMin: 15, pauseDailyMaxMin: 60, breakDailyMaxMin: null });
    expect(data.overtime).toEqual({ dailyHours: 8, weeklyHours: null });
    expect(data.billableTargetPct).toBe(60);
    expect(data.people.map((p) => [p.full_name, p.active, p.team_id])).toEqual([
      ["Erin Employee", true, "web"],
      ["Ivan Inactive", false, null],
    ]);
    expect(data.series[1]?.response_rate).toBeNull();
    expect(data.options).toEqual([{ userId: "erin", fullName: "Erin Employee", active: true }]);
  });

  it("survives an empty or broken reply", () => {
    const empty = parseInsights(null);
    expect(empty.people).toEqual([]);
    expect(empty.totals.worked_s).toBe(0);
    expect(empty.totals.median_response_ms).toBeNull();
    expect(empty.bucket).toBe("day");
  });
});

describe("trend", () => {
  it("is neutral: a signed change against the previous range", () => {
    expect(trend(5400, 1800, "duration")).toEqual({ text: "+1 h 00 min", direction: "up" });
    expect(trend(1800, 5400, "duration")).toEqual({ text: "−1 h 00 min", direction: "down" });
    expect(trend(3, 5, "count")).toEqual({ text: "−2", direction: "down" });
    expect(trend(0.75, 0.6, "rate")).toEqual({ text: "+15 pts", direction: "up" });
    expect(trend(1500, 3000, "ms")).toEqual({ text: "−1.5 s", direction: "down" });
  });

  it("says Same when what is shown is the same, and nothing without both sides", () => {
    expect(trend(3600, 3610, "duration")).toEqual({ text: "Same", direction: "same" });
    expect(trend(0.751, 0.749, "rate")).toEqual({ text: "Same", direction: "same" });
    expect(trend(null, 0.5, "rate")).toEqual({ text: "—", direction: "none" });
    expect(trend(1000, null, "ms")).toEqual({ text: "—", direction: "none" });
  });
});

describe("share and labels", () => {
  it("divides only when there is something to divide", () => {
    expect(share(10_800, 23_400)).toBeCloseTo(0.4615, 4);
    expect(share(5, 0)).toBeNull();
  });

  it("labels a day, and a 7-day bucket cut at the range's end", () => {
    expect(bucketLabel("2026-03-16", "day", "2026-03-22")).toBe("16 Mar");
    expect(bucketLabel("2026-01-01", "week", "2026-03-31")).toBe("1 Jan – 7 Jan");
    expect(bucketLabel("2026-03-26", "week", "2026-03-31")).toBe("26 Mar – 31 Mar");
  });
});

describe("projects", () => {
  const buckets = data.series.map((s) => s.bucket);

  it("charts hours by project, Unassigned last", () => {
    const chart = projectChart(buckets, data.projectSeries, data.projects, "project");
    expect(chart.groups.map((g) => g.label)).toEqual(["Internal", "Website revamp", "Unassigned"]);
    expect(chart.rows[0]).toEqual({
      bucket: "2026-03-16",
      [`p:${INTERNAL}`]: 1,
      [`p:${REVAMP}`]: 3,
      unassigned: 1.5,
    });
    expect(chart.rows[1]?.[`p:${REVAMP}`]).toBe(1);
  });

  it("by client, with No client for projects without one", () => {
    const chart = projectChart(buckets, data.projectSeries, data.projects, "client");
    expect(chart.groups.map((g) => g.label)).toEqual(["No client", "Northwind", "Unassigned"]);
  });

  it("by task, with No task for project time nobody tagged", () => {
    const chart = projectChart(buckets, data.projectSeries, data.projects, "task");
    expect(chart.groups.map((g) => g.label)).toEqual([
      "Internal · No task",
      "Website revamp · Design",
      "Website revamp · No task",
      "Unassigned",
    ]);
  });

  it("adds up what is past the limit as Other", () => {
    const chart = projectChart(buckets, data.projectSeries, data.projects, "project", 1);
    expect(chart.groups.map((g) => g.label)).toEqual(["Website revamp", "Other", "Unassigned"]);
    expect(chart.rows[0]?.other).toBe(1);
  });

  it("names rows as the table shows them", () => {
    expect(data.projects.map(projectNames)).toEqual([
      { client: "Northwind", project: "Website revamp", task: "No task" },
      { client: "Northwind", project: "Website revamp", task: "Design" },
      { client: "No client", project: "Internal", task: "No task" },
      { client: "", project: "Unassigned", task: "" },
    ]);
  });
});

describe("export tables", () => {
  it("summary: this range next to the previous one, hours as decimals", () => {
    const t = summaryTable(data);
    expect(t.header).toEqual(["Metric", "2026-03-16 to 2026-03-22", "2026-03-09 to 2026-03-15"]);
    expect(t.rows.find((r) => r[0] === "Worked (h)")).toEqual(["Worked (h)", 6.5, 2]);
    expect(t.rows.find((r) => r[0] === "Leave (h)")).toEqual(["Leave (h)", 8, 0]);
    expect(t.rows.find((r) => r[0] === "Response rate (%)")).toEqual([
      "Response rate (%)",
      60,
      null,
    ]);
    expect(t.rows.find((r) => r[0] === "Billable share (%)")).toEqual([
      "Billable share (%)",
      46.2,
      0,
    ]);
  });

  it("people by name, as the page lists them", () => {
    const t = peopleTable(data.people);
    expect(t.rows.map((r) => r[0])).toEqual(["Erin Employee", "Ivan Inactive"]);
    expect(t.rows[0]?.[1]).toBe(5.5);
    // LV-05 (#329): leave hours next to worked and scheduled.
    expect(t.header.slice(1, 4)).toEqual(["Worked (h)", "Scheduled (h)", "Leave (h)"]);
    expect(t.rows.map((r) => r[3])).toEqual([8, 0]);
    expect(t.header).toHaveLength(t.rows[0]?.length ?? 0);
  });

  it("trend, projects and the days to review", () => {
    expect(trendTable(data).rows.map((r) => [r[0], r[1], r[3]])).toEqual([
      ["2026-03-16", 5.5, 8],
      ["2026-03-17", 1, 0],
    ]);
    expect(projectsTable(data).rows[3]).toEqual(["", "Unassigned", "", 1.5, 23.1, "No", 1]);
    expect(reviewTable(data.reviewDays).rows).toEqual([["2026-03-17", "Erin Employee", 1, 1, 0]]);
  });
});
