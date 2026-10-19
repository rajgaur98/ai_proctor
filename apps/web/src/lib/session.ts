import type { Enums, Json } from "@ai-proctor/contracts";
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "./supabase";

export interface Profile {
  id: string;
  fullName: string;
  role: Enums<"user_role">;
  timezone: string;
  orgName: string;
  requireAdminMfa: boolean;
}

export async function currentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/** The signed-in user's own row (always visible to them through RLS). */
export const profileQuery = (userId: string) =>
  queryOptions({
    queryKey: ["profile", userId],
    queryFn: async (): Promise<Profile | null> => {
      const { data, error } = await supabase
        .from("users")
        .select("id, full_name, role, timezone, orgs(name, policy)")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const policy = (data.orgs?.policy ?? {}) as { [key: string]: Json | undefined };
      return {
        id: data.id,
        fullName: data.full_name,
        role: data.role,
        timezone: data.timezone,
        orgName: data.orgs?.name ?? "",
        requireAdminMfa: policy.require_admin_mfa === true,
      };
    },
    staleTime: 60_000,
  });

/** NFR-SEC-05: owners/admins of an org that requires it must verify MFA. */
export async function needsMfa(profile: Profile): Promise<boolean> {
  if (!profile.requireAdminMfa || (profile.role !== "owner" && profile.role !== "admin")) {
    return false;
  }
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return data?.currentLevel !== "aal2";
}

/** OAuth providers switched on for this deployment (VITE_AUTH_PROVIDERS). */
export function oauthProviders(): ("google" | "azure")[] {
  return (import.meta.env.VITE_AUTH_PROVIDERS ?? "")
    .split(",")
    .map((p: string) => p.trim())
    .filter((p: string): p is "google" | "azure" => p === "google" || p === "azure");
}
