// Org API keys for the public API (#306, API-02). The database keeps only a hash: the key
// itself comes back once, from createKey. Creating and revoking are audit-logged by the
// database, and so is every request a key makes.
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { explain } from "./apiText";

export interface ApiKey {
  id: string;
  name: string;
  /** `aip_` and four characters, to tell keys apart. */
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string;
  createdBy: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface CreatedKey {
  id: string;
  name: string;
  key: string;
}

/** Where the API is served: the backend's URL plus the api-v1 function (the production
 * `/api` host is set at deploy). */
export const apiBaseUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api-v1`;

export const apiKeysQuery = queryOptions({
  queryKey: ["api-keys"],
  queryFn: async (): Promise<ApiKey[]> => {
    const { data, error } = await supabase.rpc("list_api_keys");
    if (error) throw new Error(explain(error.message));
    // Generated types mark every returned column non-null; these may be null.
    return data.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.key_prefix,
      scopes: k.scopes,
      expiresAt: (k.expires_at as string | null) ?? null,
      createdAt: k.created_at,
      createdBy: (k.created_by_name as string | null) ?? null,
      revokedAt: (k.revoked_at as string | null) ?? null,
      lastUsedAt: (k.last_used_at as string | null) ?? null,
    }));
  },
});

export async function createKey(
  name: string,
  scopes: string[],
  expiresAt: string | null,
): Promise<CreatedKey> {
  const { data, error } = await supabase.rpc("create_api_key", {
    p_name: name,
    p_scopes: scopes,
    ...(expiresAt ? { p_expires_at: expiresAt } : {}),
  });
  if (error) throw new Error(explain(error.message));
  const row = data[0];
  if (!row) throw new Error("The key wasn't created. Try again.");
  return { id: row.id, name: row.name, key: row.key };
}

/** Stops the key at once. */
export async function revokeKey(id: string) {
  const { error } = await supabase.rpc("revoke_api_key", { p_id: id });
  if (error) throw new Error(explain(error.message));
}
