// Pure helpers behind a team's policy overrides (#66, ADM-02): which settings a team
// overrides, the draft the form edits, what it sends, and a one-line summary. The page
// only wires these to inputs.
import {
  type Policy,
  type TeamPolicy,
  type TeamPolicyKey,
  teamPolicySchema,
} from "@ai-proctor/contracts";

/** The settings a team overrides as a unit (the interval's two ends go together). */
export type OverrideGroup = "interval" | "response" | "idle" | "autoClockIn" | "clockOut";

export const groupKeys: Record<OverrideGroup, TeamPolicyKey[]> = {
  interval: ["checkin_min_interval_min", "checkin_max_interval_min"],
  response: ["checkin_response_s"],
  idle: ["idle_threshold_min"],
  autoClockIn: ["auto_clock_in"],
  clockOut: ["forgotten_clock_out_min"],
};

export const GROUPS = Object.keys(groupKeys) as OverrideGroup[];

/** Every team key with a value: the override where there is one, else the org's. */
export type OverrideValues = Pick<Policy, TeamPolicyKey>;

export interface OverrideDraft {
  on: Record<OverrideGroup, boolean>;
  values: OverrideValues;
}

export type OverrideErrors = Partial<Record<TeamPolicyKey, string>>;

/** The org's values of the team keys. */
export function orgValues(policy: Policy): OverrideValues {
  return {
    checkin_min_interval_min: policy.checkin_min_interval_min,
    checkin_max_interval_min: policy.checkin_max_interval_min,
    checkin_response_s: policy.checkin_response_s,
    idle_threshold_min: policy.idle_threshold_min,
    auto_clock_in: policy.auto_clock_in,
    forgotten_clock_out_min: policy.forgotten_clock_out_min,
  };
}

/** The form's starting point: a group is on when the team overrides any of its keys. */
export function draftFrom(overrides: TeamPolicy, org: OverrideValues): OverrideDraft {
  const on = Object.fromEntries(
    GROUPS.map((g) => [g, groupKeys[g].some((k) => overrides[k] !== undefined)]),
  ) as Record<OverrideGroup, boolean>;
  const set = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined),
  ) as Partial<OverrideValues>;
  return { on, values: { ...org, ...set } };
}

/** What set_team_policy gets: the values of the groups that are on, nothing else. */
export function toOverrides(draft: OverrideDraft): TeamPolicy {
  const out: Record<string, unknown> = {};
  for (const g of GROUPS) {
    if (!draft.on[g]) continue;
    for (const k of groupKeys[g]) out[k] = draft.values[k];
  }
  return out as TeamPolicy;
}

/** The overrides as the database will check them, or the first message per key. */
export function validateOverrides(
  draft: OverrideDraft,
): { data: TeamPolicy; errors: null } | { data: null; errors: OverrideErrors } {
  const result = teamPolicySchema.safeParse(toOverrides(draft));
  if (result.success) return { data: result.data, errors: null };
  const errors: OverrideErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] as TeamPolicyKey | undefined;
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return { data: null, errors };
}

/** Whether two sets of overrides are the same, whatever their key order. */
export function sameOverrides(a: TeamPolicy, b: TeamPolicy): boolean {
  const norm = (p: TeamPolicy) =>
    JSON.stringify(Object.entries(p).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}

/** One short phrase per overridden group, in the form's order; empty when there are none. */
export function overrideSummary(p: TeamPolicy): string[] {
  const out: string[] = [];
  const min = p.checkin_min_interval_min;
  const max = p.checkin_max_interval_min;
  if (min !== undefined && max !== undefined) {
    out.push(min === max ? `Check-ins every ${min} min` : `Check-ins every ${min} to ${max} min`);
  }
  if (p.checkin_response_s !== undefined) out.push(`${p.checkin_response_s} s to respond`);
  if (p.idle_threshold_min !== undefined) out.push(`Idle after ${p.idle_threshold_min} min`);
  if (p.auto_clock_in !== undefined) out.push(`Auto clock-in ${p.auto_clock_in ? "on" : "off"}`);
  if (p.forgotten_clock_out_min !== undefined) {
    out.push(`Clocked out ${p.forgotten_clock_out_min} min after a shift`);
  }
  return out;
}
