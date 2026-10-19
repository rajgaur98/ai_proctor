// DSH-01 / STS-03: keeps the team query live. Realtime presence changes (already
// filtered by RLS to people the viewer may see) patch rows in place; reconnects,
// returning to the tab and coming back online refetch everything.
import type { Tables } from "@ai-proctor/contracts";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { applyPresence, type TeamRow } from "./grid";

export type LiveState = "connecting" | "live" | "reconnecting";

export function useLivePresence(queryKey: QueryKey): LiveState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveState>("connecting");

  useEffect(() => {
    const refetch = () => queryClient.invalidateQueries({ queryKey });
    let seenOnce = false;

    const channel = supabase
      .channel("team-presence")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "presence" },
        (msg: { new: Partial<Tables<"presence">> }) => {
          const change = msg.new;
          if (!change.user_id) return;
          queryClient.setQueryData<TeamRow[]>(queryKey, (rows) =>
            rows ? applyPresence(rows, { ...change, user_id: change.user_id as string }) : rows,
          );
        },
      )
      .on("system", {}, (m: { extension?: string; status?: string }) => {
        if (m.extension === "postgres_changes" && m.status === "ok") {
          setState("live");
          // After a reconnect, changes may have been missed: refetch.
          if (seenOnce) refetch();
          seenOnce = true;
        }
      })
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setState("reconnecting");
        }
      });

    const onVisible = () => document.visibilityState === "visible" && refetch();
    window.addEventListener("online", refetch);
    document.addEventListener("visibilitychange", onVisible);
    // Today's counts change with check-ins that don't touch presence fields we patch.
    const timer = window.setInterval(refetch, 60_000);

    return () => {
      window.removeEventListener("online", refetch);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, [queryClient, queryKey]);

  return state;
}
