// The email switches on the Alerts page: the daily digest (ALR-03, #67) and the weekly
// insights email (INS-06, #305). Each is the signed-in person's own preference
// (notification_prefs): the digest is on unless they turned it off, the weekly email off
// unless they turned it on. Both go to anyone with direct reports; one read serves both.
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "../../lib/supabase";

export interface EmailPrefs {
  dailyDigest: boolean;
  weeklyInsights: boolean;
}

export const emailPrefsQuery = (userId: string) =>
  queryOptions({
    queryKey: ["email-prefs", userId],
    queryFn: async (): Promise<EmailPrefs> => {
      const { data, error } = await supabase
        .from("notification_prefs")
        .select("daily_digest, weekly_insights")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return {
        dailyDigest: data?.daily_digest ?? true,
        weeklyInsights: data?.weekly_insights ?? false,
      };
    },
  });

const switches = {
  dailyDigest: {
    rpc: "set_daily_digest",
    label: "Daily digest email",
    hint: "Each morning: yesterday's hours, flagged time and missed check-ins for your direct reports.",
  },
  weeklyInsights: {
    rpc: "set_weekly_insights",
    label: "Weekly insights email",
    hint: "Each week: last week's attendance, check-in and time totals for your direct reports, against the week before. No names, scores or rankings.",
  },
} as const;

function PrefSwitch({ userId, pref }: { userId: string; pref: keyof EmailPrefs }) {
  const queryClient = useQueryClient();
  const prefs = useQuery(emailPrefsQuery(userId));
  // The value just picked, shown while it saves (and the old one again if it fails).
  const [picked, setPicked] = useState<boolean | null>(null);
  const s = switches[pref];
  const save = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { error } = await supabase.rpc(s.rpc, { p_enabled: enabled });
      if (error) throw error;
      return enabled;
    },
    onSuccess: (enabled) =>
      queryClient.setQueryData(emailPrefsQuery(userId).queryKey, (old) =>
        old ? { ...old, [pref]: enabled } : old,
      ),
    onSettled: () => setPicked(null),
  });

  return (
    <div className="flex flex-col gap-1">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[13.5px] font-medium">
        <input
          type="checkbox"
          checked={picked ?? prefs.data?.[pref] ?? pref === "dailyDigest"}
          disabled={prefs.isPending || save.isPending}
          onChange={(e) => {
            setPicked(e.target.checked);
            save.mutate(e.target.checked);
          }}
          className="h-5 w-5 flex-none accent-acc"
        />
        {s.label}
      </label>
      <p className="max-w-[420px] text-[12.5px] text-ink2">{s.hint}</p>
      {(prefs.error ?? save.error) && (
        <p role="alert" className="text-[12.5px] text-warnink">
          Couldn't save this: {(prefs.error ?? save.error)?.message}
        </p>
      )}
    </div>
  );
}

export function DigestToggle({ userId }: { userId: string }) {
  return (
    <div className="flex flex-col gap-2">
      <PrefSwitch userId={userId} pref="dailyDigest" />
      <PrefSwitch userId={userId} pref="weeklyInsights" />
    </div>
  );
}
