// Org enrollment tokens for MDM installs (#86, AGT-01). The database keeps only a
// hash: the token itself comes back once, from createToken.
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { explain } from "./enrollmentText";

export interface EnrollmentToken {
  id: string;
  label: string;
  /** `apet_` and four characters, to tell tokens apart. */
  prefix: string;
  createdAt: string;
  createdBy: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** Devices it enrolled that are still in use. */
  devices: number;
}

export interface CreatedToken {
  id: string;
  label: string;
  token: string;
}

export const tokensQuery = queryOptions({
  queryKey: ["enrollment-tokens"],
  queryFn: async (): Promise<EnrollmentToken[]> => {
    const { data, error } = await supabase.rpc("list_enrollment_tokens");
    if (error) throw new Error(explain(error.message));
    // Generated types mark every returned column non-null; these may be null.
    return data.map((t) => ({
      id: t.id,
      label: t.label,
      prefix: t.token_prefix,
      createdAt: t.created_at,
      createdBy: (t.created_by_name as string | null) ?? null,
      revokedAt: (t.revoked_at as string | null) ?? null,
      lastUsedAt: (t.last_used_at as string | null) ?? null,
      devices: t.devices,
    }));
  },
});

/** Audit-logged by the database. */
export async function createToken(label: string): Promise<CreatedToken> {
  const { data, error } = await supabase.rpc("create_enrollment_token", { p_label: label });
  if (error) throw new Error(explain(error.message));
  const row = data[0];
  if (!row) throw new Error("The token wasn't created. Try again.");
  return { id: row.id, label: row.label, token: row.token };
}

/** Stops new enrollments; devices it already enrolled keep working. Audit-logged. */
export async function revokeToken(id: string) {
  const { error } = await supabase.rpc("revoke_enrollment_token", { p_id: id });
  if (error) throw new Error(explain(error.message));
}
