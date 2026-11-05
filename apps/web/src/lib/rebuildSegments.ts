// The dashboard's calls to the rebuild-segments Edge Function (LLD section 6): one call per
// day from the signed-in viewer, under rebuildDays' time limit and 401 renewal (#338).
import { rebuildDays } from "./rebuildDays";
import { supabase } from "./supabase";

/** Rebuilds a person's `days`; rejects with a RebuildError (see rebuildDays). */
export function rebuildSegments(userId: string, days: string[]): Promise<void> {
  return rebuildDays(days, {
    invoke: async (day, signal) => {
      const { error, response } = await supabase.functions.invoke("rebuild-segments", {
        body: { user_id: userId, day },
        signal,
      });
      return { error, status: response?.status ?? null };
    },
    renewSession: async () => {
      const { data } = await supabase.auth.refreshSession();
      return data.session !== null;
    },
  });
}
