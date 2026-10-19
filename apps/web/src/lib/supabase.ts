import type { Database } from "@ai-proctor/contracts";
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  throw new Error("Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see apps/web/.env.example).");
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true },
});
