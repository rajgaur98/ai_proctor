// Pure helpers for the enrollment tokens section (#86), kept apart from the data
// module so they test without a Supabase client.
import type { EnrollmentToken } from "./enrollmentData";

export function tokenStatus(t: Pick<EnrollmentToken, "revokedAt">): "Active" | "Revoked" {
  return t.revokedAt ? "Revoked" : "Active";
}

export function deviceCount(n: number): string {
  return `${n} ${n === 1 ? "device" : "devices"}`;
}

const messages: Record<string, string> = {
  admin_only: "Only owners and admins can manage enrollment tokens.",
  mfa_required: "Verify two-factor authentication to manage enrollment tokens.",
  invalid_label: "Enter a name of up to 80 characters.",
  token_not_found: "That token is no longer there. Reload the page.",
};

export function explain(code: string): string {
  return messages[code] ?? code;
}
