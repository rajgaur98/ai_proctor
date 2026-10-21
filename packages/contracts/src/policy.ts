// Org policy (#52, ADM-01): every key of orgs.policy that the settings page edits, with
// the same ranges update_policy enforces (policy_spec in
// supabase/migrations/20261020196000_reminder_shift_day.sql, its latest definition, is the
// source of truth; the dashboard validates the same rules before sending). The presets
// themselves come from the database with the settings, so they are not repeated here.
import { z } from "zod";

export const Region = z.enum(["us", "eu", "india"]);
export type Region = z.infer<typeof Region>;

/** PRD 5.1: images are kept 30 days at most in the EU. */
export const EU_IMAGE_RETENTION_MAX_DAYS = 30;

/** [min, max] of every whole-number key (PRD section 6, ADM-03, and the alert and anti-cheat keys). */
export const POLICY_LIMITS = {
  checkin_min_interval_min: [10, 240],
  checkin_max_interval_min: [10, 240],
  checkin_response_s: [30, 300],
  idle_threshold_min: [3, 60],
  forgotten_clock_out_min: [10, 120],
  break_daily_max_min: [1, 1440],
  pause_max_min: [0, 60],
  pause_daily_max_min: [0, 240],
  late_clock_in_min: [5, 60],
  alert_consecutive_misses: [1, 10],
  alert_offline_min: [5, 240],
  image_retention_days: [7, 90],
  event_retention_months: [3, 36],
  timesheet_retention_years: [3, 10],
  anticheat_min_passes: [3, 50],
} as const;

/** Anti-cheat: the most a day's response times may vary (as a coefficient of variation) before it is flagged. */
export const ANTICHEAT_MAX_CV_LIMITS = [0.01, 0.5] as const;

export const SCREENSHOT_MODES = ["full", "blurred", "off"] as const;
export const WEEK_STARTS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export const ALERT_KINDS = [
  "consecutive_misses",
  "offline",
  "tamper",
  "late_clock_in",
  "pause_over_cap",
] as const;
export const EXCLUDED_APPS_MAX = 100;
export const EXCLUDED_APP_MAX_LENGTH = 100;

function whole(key: keyof typeof POLICY_LIMITS) {
  const [min, max] = POLICY_LIMITS[key];
  const message = `Enter a whole number from ${min} to ${max}`;
  return z.number({ error: message }).int(message).min(min, message).max(max, message);
}

const [cvMin, cvMax] = ANTICHEAT_MAX_CV_LIMITS;
const cvMessage = `Enter a number from ${cvMin} to ${cvMax}`;

const flag = z.boolean();

/** Every key, as the database stores it. A key the database doesn't know is an error. */
export const PolicyKeys = z.strictObject({
  checkin_min_interval_min: whole("checkin_min_interval_min"),
  checkin_max_interval_min: whole("checkin_max_interval_min"),
  checkin_response_s: whole("checkin_response_s"),
  idle_threshold_min: whole("idle_threshold_min"),
  screenshots: z.enum(SCREENSHOT_MODES),
  webcam: flag,
  window_titles: flag,
  excluded_apps: z
    .array(
      z
        .string()
        .trim()
        .min(1, "Enter an app name")
        .max(EXCLUDED_APP_MAX_LENGTH, `At most ${EXCLUDED_APP_MAX_LENGTH} characters`),
    )
    .max(EXCLUDED_APPS_MAX, `At most ${EXCLUDED_APPS_MAX} apps`),
  activity_sampling: flag,
  auto_clock_in: flag,
  forgotten_clock_out_min: whole("forgotten_clock_out_min"),
  breaks_paid: flag,
  // Null: no daily limit.
  break_daily_max_min: whole("break_daily_max_min").nullable(),
  pause_max_min: whole("pause_max_min"),
  pause_daily_max_min: whole("pause_daily_max_min"),
  week_start: z.enum(WEEK_STARTS),
  late_clock_in_min: whole("late_clock_in_min"),
  alert_consecutive_misses_enabled: flag,
  alert_consecutive_misses: whole("alert_consecutive_misses"),
  alert_offline_enabled: flag,
  alert_offline_min: whole("alert_offline_min"),
  alert_tamper_enabled: flag,
  alert_late_clock_in_enabled: flag,
  alert_pause_over_cap_enabled: flag,
  // Timesheet reminders (submit, approval, escalation) for the whole org (#177).
  reminders_enabled: flag,
  image_retention_days: whole("image_retention_days"),
  event_retention_months: whole("event_retention_months"),
  timesheet_retention_years: whole("timesheet_retention_years"),
  anticheat_min_passes: whole("anticheat_min_passes"),
  anticheat_max_cv: z.number({ error: cvMessage }).min(cvMin, cvMessage).max(cvMax, cvMessage),
  require_admin_mfa: flag,
});

export type Policy = z.infer<typeof PolicyKeys>;
export type PolicyKey = keyof Policy;

/** The whole policy for an org in `region`: the keys plus the rules that span keys or depend on the region. */
export function policySchema(region: Region) {
  return PolicyKeys.superRefine((p, ctx) => {
    if (p.checkin_min_interval_min > p.checkin_max_interval_min) {
      ctx.addIssue({
        code: "custom",
        message: "Must be at least the shortest interval",
        path: ["checkin_max_interval_min"],
      });
    }
    if (region === "eu" && p.image_retention_days > EU_IMAGE_RETENTION_MAX_DAYS) {
      ctx.addIssue({
        code: "custom",
        message: `EU organisations keep images ${EU_IMAGE_RETENTION_MAX_DAYS} days at most`,
        path: ["image_retention_days"],
      });
    }
  });
}

/** What policy_settings() returns. */
export const PolicySettings = z.object({
  region_preset: Region,
  policy_version: z.number().int(),
  policy: PolicyKeys,
  // The stored policy already has the webcam on (an EU org confirmed the DPIA when it did).
  webcam_confirmed: z.boolean(),
  members: z.number().int(),
  // Active people working where a works council is usually involved (PRD 5.2).
  works_council_members: z.number().int(),
  presets: z.object({ us: PolicyKeys, eu: PolicyKeys, india: PolicyKeys }),
});
export type PolicySettings = z.infer<typeof PolicySettings>;

/** What update_policy returns. notice_version: the notice a collection change published. */
export const UpdatePolicyReply = z.object({
  policy_version: z.number().int(),
  changed: z.array(z.string()),
  notice_version: z.number().int().nullable(),
});
export type UpdatePolicyReply = z.infer<typeof UpdatePolicyReply>;

// Teams (#66, ADM-02) ----------------------------------------------------------------------

/**
 * The keys a team may override (internal.team_policy_keys in
 * supabase/migrations/20261022100000_teams.sql): when and how check-ins run and the agent's
 * clock-in behaviour. Everything else stays org-wide.
 */
export const TEAM_POLICY_KEYS = [
  "checkin_min_interval_min",
  "checkin_max_interval_min",
  "checkin_response_s",
  "idle_threshold_min",
  "auto_clock_in",
  "forgotten_clock_out_min",
] as const satisfies readonly PolicyKey[];
export type TeamPolicyKey = (typeof TEAM_POLICY_KEYS)[number];

/** A team's overrides: any of the team keys, with the org policy's ranges. */
export const TeamPolicyKeys = PolicyKeys.pick({
  checkin_min_interval_min: true,
  checkin_max_interval_min: true,
  checkin_response_s: true,
  idle_threshold_min: true,
  auto_clock_in: true,
  forgotten_clock_out_min: true,
})
  .partial()
  .strict();
export type TeamPolicy = z.infer<typeof TeamPolicyKeys>;

/**
 * What set_team_policy accepts: the interval is overridden as a pair (both ends or
 * neither), shortest at most longest, so an org change can't leave a team's range upside down.
 */
export const teamPolicySchema = TeamPolicyKeys.superRefine((p, ctx) => {
  const min = p.checkin_min_interval_min;
  const max = p.checkin_max_interval_min;
  if ((min === undefined) !== (max === undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "Set both ends of the interval",
      path: [min === undefined ? "checkin_min_interval_min" : "checkin_max_interval_min"],
    });
  } else if (min !== undefined && max !== undefined && min > max) {
    ctx.addIssue({
      code: "custom",
      message: "Must be at least the shortest interval",
      path: ["checkin_max_interval_min"],
    });
  }
});

/** What set_team_policy returns. */
export const SetTeamPolicyReply = z.object({ changed: z.array(z.string()) });
export type SetTeamPolicyReply = z.infer<typeof SetTeamPolicyReply>;
