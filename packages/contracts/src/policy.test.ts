import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANTICHEAT_MAX_CV_LIMITS,
  POLICY_LIMITS,
  type Policy,
  PolicyKeys,
  PolicySettings,
  policySchema,
  TEAM_POLICY_KEYS,
  TeamPolicyKeys,
  teamPolicySchema,
  UpdatePolicyReply,
} from "./policy";

// The EU preset (PRD 5.1), as update_policy's region_preset('eu') returns it.
const eu: Policy = {
  checkin_min_interval_min: 45,
  checkin_max_interval_min: 120,
  checkin_response_s: 90,
  idle_threshold_min: 10,
  screenshots: "blurred",
  webcam: false,
  window_titles: false,
  excluded_apps: ["1Password"],
  activity_sampling: true,
  auto_clock_in: false,
  forgotten_clock_out_min: 30,
  breaks_paid: false,
  break_daily_max_min: null,
  pause_max_min: 15,
  pause_daily_max_min: 60,
  week_start: "monday",
  late_clock_in_min: 15,
  alert_consecutive_misses_enabled: true,
  alert_consecutive_misses: 3,
  alert_offline_enabled: true,
  alert_offline_min: 15,
  alert_tamper_enabled: true,
  alert_late_clock_in_enabled: true,
  alert_pause_over_cap_enabled: true,
  reminders_enabled: true,
  image_retention_days: 30,
  event_retention_months: 12,
  timesheet_retention_years: 3,
  anticheat_min_passes: 5,
  anticheat_max_cv: 0.1,
  require_admin_mfa: false,
};

const issues = (policy: unknown, region: "us" | "eu" | "india" = "us") => {
  const r = policySchema(region).safeParse(policy);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("policySchema", () => {
  it("accepts a preset", () => {
    expect(issues(eu, "eu")).toEqual([]);
  });

  it("takes both ends of every whole-number range and refuses just outside", () => {
    for (const [key, [min, max]] of Object.entries(POLICY_LIMITS)) {
      // Keep min <= max for the interval pair while testing one end at a time.
      const base = { ...eu, checkin_min_interval_min: 10, checkin_max_interval_min: 240 };
      for (const ok of [min, max]) {
        expect(issues({ ...base, [key]: ok }), `${key}=${ok}`).toEqual([]);
      }
      for (const bad of [min - 1, max + 1]) {
        expect(issues({ ...base, [key]: bad }).length, `${key}=${bad}`).toBeGreaterThan(0);
      }
    }
  });

  it("limits the anti-cheat variation, which may have decimals", () => {
    const [lo, hi] = ANTICHEAT_MAX_CV_LIMITS;
    expect(issues({ ...eu, anticheat_max_cv: lo })).toEqual([]);
    expect(issues({ ...eu, anticheat_max_cv: hi })).toEqual([]);
    expect(issues({ ...eu, anticheat_max_cv: 0.009 })).toHaveLength(1);
    expect(issues({ ...eu, anticheat_max_cv: 0.51 })).toHaveLength(1);
  });

  it("refuses decimals, strings and a blank number in whole-number keys", () => {
    expect(issues({ ...eu, checkin_response_s: 90.5 })).toHaveLength(1);
    expect(issues({ ...eu, checkin_response_s: "90" })).toHaveLength(1);
    expect(issues({ ...eu, checkin_response_s: Number.NaN })).toEqual([
      "checkin_response_s: Enter a whole number from 30 to 300",
    ]);
  });

  it("lets the daily break limit be empty, and no other key", () => {
    expect(issues({ ...eu, break_daily_max_min: null })).toEqual([]);
    expect(issues({ ...eu, pause_max_min: null })).toHaveLength(1);
  });

  it("needs the shortest interval at or below the longest", () => {
    expect(issues({ ...eu, checkin_min_interval_min: 100, checkin_max_interval_min: 90 })).toEqual([
      "checkin_max_interval_min: Must be at least the shortest interval",
    ]);
    expect(issues({ ...eu, checkin_min_interval_min: 90, checkin_max_interval_min: 90 })).toEqual(
      [],
    );
  });

  it("caps image retention at 30 days in the EU only", () => {
    expect(issues({ ...eu, image_retention_days: 31 }, "eu")).toEqual([
      "image_retention_days: EU organisations keep images 30 days at most",
    ]);
    expect(issues({ ...eu, image_retention_days: 90 }, "us")).toEqual([]);
    expect(issues({ ...eu, image_retention_days: 90 }, "india")).toEqual([]);
  });

  it("checks enums and the excluded apps list", () => {
    expect(issues({ ...eu, screenshots: "sharp" })).toHaveLength(1);
    expect(issues({ ...eu, week_start: "Sunday" })).toHaveLength(1);
    expect(issues({ ...eu, excluded_apps: ["Slack", ""] })).toHaveLength(1);
    expect(issues({ ...eu, excluded_apps: ["x".repeat(101)] })).toHaveLength(1);
    expect(
      issues({ ...eu, excluded_apps: Array.from({ length: 101 }, (_, i) => `app${i}`) }),
    ).toHaveLength(1);
  });

  it("trims excluded app names", () => {
    const r = PolicyKeys.parse({ ...eu, excluded_apps: ["  Slack "] });
    expect(r.excluded_apps).toEqual(["Slack"]);
  });

  it("refuses a key the database doesn't know, and a missing one", () => {
    expect(issues({ ...eu, surprise: 1 })).toHaveLength(1);
    const { webcam: _webcam, ...without } = eu;
    expect(issues(without)).toHaveLength(1);
  });
});

describe("replies", () => {
  it("parses what policy_settings returns", () => {
    const reply = {
      region_preset: "eu",
      policy_version: 4,
      policy: eu,
      webcam_confirmed: false,
      members: 12,
      works_council_members: 2,
      presets: { us: eu, eu, india: eu },
    };
    expect(PolicySettings.parse(reply).policy_version).toBe(4);
    expect(PolicySettings.safeParse({ ...reply, region_preset: "jp" }).success).toBe(false);
  });

  it("parses what update_policy returns", () => {
    expect(
      UpdatePolicyReply.parse({ policy_version: 5, changed: ["webcam"], notice_version: null }),
    ).toEqual({ policy_version: 5, changed: ["webcam"], notice_version: null });
  });
});

// The ranges here and in update_policy must not drift apart: read them from the migration
// that last defined policy_spec (#177 repeats the whole list when it adds a key).
describe("the database's ranges", () => {
  const sql = readFileSync(
    new URL("../../../supabase/migrations/20261020196000_reminder_shift_day.sql", import.meta.url),
    "utf8",
  );
  const rows = [...sql.matchAll(/\('([a-z_]+)', '(int|num)', ([\d.]+), ([\d.]+)/g)].map((m) => ({
    key: m[1] as string,
    lo: Number(m[3]),
    hi: Number(m[4]),
  }));

  it("match POLICY_LIMITS for every whole-number key", () => {
    const fromSql = Object.fromEntries(
      rows.filter((r) => r.key !== "anticheat_max_cv").map((r) => [r.key, [r.lo, r.hi]]),
    );
    expect(fromSql).toEqual(POLICY_LIMITS);
  });

  it("match the anti-cheat variation range", () => {
    const row = rows.find((r) => r.key === "anticheat_max_cv");
    expect([row?.lo, row?.hi]).toEqual([...ANTICHEAT_MAX_CV_LIMITS]);
  });

  it("list exactly the keys the schema has", () => {
    const keys = [...sql.matchAll(/^\s+\('([a-z_]+)', '(?:bool|enum|int|num|apps)'/gm)].map(
      (m) => m[1],
    );
    expect(keys.sort()).toEqual(Object.keys(PolicyKeys.shape).sort());
  });
});

describe("teamPolicySchema", () => {
  it("takes any of the team keys, none at all, and the org's ranges", () => {
    expect(teamPolicySchema.safeParse({}).success).toBe(true);
    expect(
      teamPolicySchema.safeParse({ checkin_response_s: 60, auto_clock_in: true }).success,
    ).toBe(true);
    expect(teamPolicySchema.safeParse({ checkin_response_s: 20 }).success).toBe(false);
    expect(teamPolicySchema.safeParse({ idle_threshold_min: 2.5 }).success).toBe(false);
  });

  it("refuses keys that stay org-wide", () => {
    expect(teamPolicySchema.safeParse({ screenshots: "off" }).success).toBe(false);
    expect(teamPolicySchema.safeParse({ late_clock_in_min: 10 }).success).toBe(false);
  });

  it("needs both ends of the interval, shortest at most longest", () => {
    const issue = (v: unknown) => teamPolicySchema.safeParse(v).error?.issues[0];
    expect(issue({ checkin_min_interval_min: 15 })?.path).toEqual(["checkin_max_interval_min"]);
    expect(issue({ checkin_max_interval_min: 15 })?.path).toEqual(["checkin_min_interval_min"]);
    expect(issue({ checkin_min_interval_min: 40, checkin_max_interval_min: 30 })?.message).toBe(
      "Must be at least the shortest interval",
    );
    expect(
      teamPolicySchema.safeParse({ checkin_min_interval_min: 15, checkin_max_interval_min: 30 })
        .success,
    ).toBe(true);
  });

  it("lists the same keys as the database", () => {
    const sql = readFileSync(
      new URL("../../../supabase/migrations/20261022100000_teams.sql", import.meta.url),
      "utf8",
    );
    const body = sql.match(
      /team_policy_keys\(\)\s+returns text\[\][\s\S]*?array\[([\s\S]*?)\]/,
    )?.[1];
    const keys = [...(body ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...TEAM_POLICY_KEYS]);
    expect(Object.keys(TeamPolicyKeys.shape).sort()).toEqual([...TEAM_POLICY_KEYS].sort());
  });
});
