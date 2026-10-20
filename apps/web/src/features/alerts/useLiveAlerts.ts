// ALR-01: keeps the alert queries live. A new alert for the signed-in recipient arrives
// over Realtime (RLS applies to the subscription) and refetches the bell and the page;
// a reconnect, returning to the tab and coming back online refetch too. The queries
// also poll slowly (alertData.ts), for when the socket drops without saying so.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "../../lib/supabase";

export function useLiveAlerts(userId: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const refetch = () => queryClient.invalidateQueries({ queryKey: ["alerts", userId] });
    let seenOnce = false;

    const channel = supabase
      .channel(`alerts-${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "alerts", filter: `recipient_id=eq.${userId}` },
        refetch,
      )
      .on("system", {}, (m: { extension?: string; status?: string }) => {
        if (m.extension === "postgres_changes" && m.status === "ok") {
          // After a reconnect, alerts may have been missed: refetch.
          if (seenOnce) refetch();
          seenOnce = true;
        }
      })
      .subscribe();

    const onVisible = () => document.visibilityState === "visible" && refetch();
    window.addEventListener("online", refetch);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.removeEventListener("online", refetch);
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [queryClient, userId]);
}
