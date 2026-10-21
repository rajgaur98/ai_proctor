// The daily digest email switch (ALR-03, #67) on the Alerts page: the signed-in person's
// own preference (notification_prefs.daily_digest, on unless they turned it off). The
// digest goes to anyone with direct reports, each morning, about the day before.
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "../../lib/supabase";

export const dailyDigestQuery = (userId: string) =>
  queryOptions({
    queryKey: ["daily-digest", userId],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from("notification_prefs")
        .select("daily_digest")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return data?.daily_digest ?? true;
    },
  });

export function DigestToggle({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const pref = useQuery(dailyDigestQuery(userId));
  // The value just picked, shown while it saves (and the old one again if it fails).
  const [picked, setPicked] = useState<boolean | null>(null);
  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { error } = await supabase.rpc("set_daily_digest", { p_enabled: enabled });
      if (error) throw error;
      return enabled;
    },
    onSuccess: (enabled) => queryClient.setQueryData(dailyDigestQuery(userId).queryKey, enabled),
    onSettled: () => setPicked(null),
  });

  return (
    <div className="flex flex-col gap-1">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[13.5px] font-medium">
        <input
          type="checkbox"
          checked={picked ?? pref.data ?? true}
          disabled={pref.isPending || save.isPending}
          onChange={(e) => {
            setPicked(e.target.checked);
            save.mutate(e.target.checked);
          }}
          className="h-5 w-5 flex-none accent-acc"
        />
        Daily digest email
      </label>
      <p className="max-w-[420px] text-[12.5px] text-ink2">
        Each morning: yesterday's hours, flagged time and missed check-ins for your direct reports.
      </p>
      {(pref.error ?? save.error) && (
        <p role="alert" className="text-[12.5px] text-warnink">
          Couldn't save this: {(pref.error ?? save.error)?.message}
        </p>
      )}
    </div>
  );
}
