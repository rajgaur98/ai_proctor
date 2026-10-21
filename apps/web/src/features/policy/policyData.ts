import { type Policy, PolicySettings, UpdatePolicyReply } from "@ai-proctor/contracts";
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";

/** The org's policy with defaults filled in, the region presets and who it applies to (ADM-01). */
export const policySettingsQuery = queryOptions({
  queryKey: ["policy-settings"],
  queryFn: async (): Promise<PolicySettings> => {
    const { data, error } = await supabase.rpc("policy_settings");
    if (error) throw new Error(explain(error.message, error.details));
    return PolicySettings.parse(data);
  },
});

/** Saves the given keys; the database validates them again and writes the audit entries. */
export async function savePolicy(
  changes: Partial<Policy>,
  confirmations: { dpia: boolean; worksCouncil: boolean },
): Promise<UpdatePolicyReply> {
  const { data, error } = await supabase.rpc("update_policy", {
    p_policy: changes,
    p_dpia_confirmed: confirmations.dpia,
    p_works_council_confirmed: confirmations.worksCouncil,
  });
  if (error) throw new Error(explain(error.message, error.details));
  return UpdatePolicyReply.parse(data);
}

const messages: Record<string, string> = {
  admin_only: "Only owners and admins can change the policy.",
  mfa_required: "Verify two-factor authentication to change the policy.",
  eu_image_retention_max: "EU organisations keep images 30 days at most.",
  dpia_required: "Confirm the DPIA to turn webcam capture on.",
  works_council_required: "Confirm the works council consultation to turn webcam capture on.",
  face_presence_unavailable: "Face presence detection isn't available to EU organisations.",
};

/** `details` is the key the database refused, when it names one. */
export function explain(code: string, details?: string | null): string {
  if (code === "invalid_policy" || code === "unknown_policy_key") {
    return `The server refused ${details ?? "the policy"}.`;
  }
  return messages[code] ?? code;
}
