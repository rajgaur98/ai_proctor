// Pure helpers behind the policy page: validation, presets, what changed, and when the
// EU confirmations are needed. The page only wires these to inputs.
import {
  type Policy,
  type PolicyKey,
  type PolicySettings,
  policySchema,
  type Region,
} from "@ai-proctor/contracts";

export type FieldErrors = Partial<Record<PolicyKey, string>>;

/** The draft as the database will see it, or the first message per key. */
export function validate(
  draft: Policy,
  region: Region,
): { data: Policy; errors: null } | { data: null; errors: FieldErrors } {
  const result = policySchema(region).safeParse(draft);
  if (result.success) return { data: result.data, errors: null };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] as PolicyKey | undefined;
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return { data: null, errors };
}

/** Keys whose value differs between the saved policy and the draft. */
export function changedKeys(saved: Policy, draft: Policy): PolicyKey[] {
  return (Object.keys(saved) as PolicyKey[]).filter(
    (k) => JSON.stringify(saved[k]) !== JSON.stringify(draft[k]),
  );
}

/** Picks the keys out of a policy, in the policy's order. */
export function pick(policy: Policy, keys: PolicyKey[]): Partial<Policy> {
  return Object.fromEntries(keys.map((k) => [k, policy[k]]));
}

/**
 * Applying a region preset fills the form with that region's defaults. Two-factor for
 * admins is a security setting, not a regional one, so it stays as it is.
 */
export function applyPreset(draft: Policy, preset: Policy): Policy {
  return {
    ...preset,
    excluded_apps: [...preset.excluded_apps],
    require_admin_mfa: draft.require_admin_mfa,
  };
}

/**
 * CAP-05: turning the webcam on in an EU org needs the DPIA confirmed, and the works
 * council consultation where someone works from a country that usually has one. An org
 * whose stored policy already has the webcam on has been through it.
 */
export function confirmationsNeeded(
  settings: Pick<PolicySettings, "region_preset" | "webcam_confirmed" | "works_council_members">,
  draft: Pick<Policy, "webcam">,
): { dpia: boolean; worksCouncil: boolean } {
  const dpia = settings.region_preset === "eu" && draft.webcam && !settings.webcam_confirmed;
  return { dpia, worksCouncil: dpia && settings.works_council_members > 0 };
}

export function canSave(input: {
  valid: boolean;
  dirty: boolean;
  needed: { dpia: boolean; worksCouncil: boolean };
  confirmed: { dpia: boolean; worksCouncil: boolean };
}): boolean {
  return (
    input.valid &&
    input.dirty &&
    (!input.needed.dpia || input.confirmed.dpia) &&
    (!input.needed.worksCouncil || input.confirmed.worksCouncil)
  );
}

/** "A, B and C". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * CAP-07: what the note under the face presence switch says. In an EU organisation it
 * can't be turned on; elsewhere it is always off where the person works under a
 * biometric privacy law (the server's list), and it needs the webcam frame.
 */
export function facePresenceNote(
  settings: Pick<
    PolicySettings,
    "face_presence_available" | "biometric_law_places" | "biometric_law_members"
  >,
  draft: Pick<Policy, "face_presence" | "webcam">,
): string {
  if (!settings.face_presence_available) {
    return "Not available to EU organisations: no face detection or other AI-based monitoring in the EU.";
  }
  const people = settings.biometric_law_members;
  const here =
    people > 0 ? ` (${people} ${people === 1 ? "person works" : "people work"} there now)` : "";
  const webcam =
    draft.face_presence && !draft.webcam ? " It only runs while the webcam frame is on." : "";
  return `Always off for people who work in ${listText(settings.biometric_law_places)}, where biometric privacy laws apply${here}.${webcam}`;
}

export const regionLabels: Record<Region, string> = { us: "US", eu: "EU", india: "India" };

export const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
