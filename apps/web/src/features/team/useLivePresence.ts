// DSH-01 / STS-03: keeps the team query live. Realtime presence changes (already
// filtered by RLS to people the viewer may see) patch rows in place; reconnects,
// returning to the tab and coming back online refetch everything.
import type { Tables } from "@ai-proctor/contracts";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { applyPresence, type TeamRow } from "./grid";

export type LiveState = "connecting" | "live" | "reconnecting";

type PresenceChange = Partial<Tables<"presence">> & { user_id: string };

/** Changes from the last two minutes, per query. */
const recent = new Map<string, { at: number; change: PresenceChange }[]>();
const KEEP_MS = 120_000;

/**
 * Re-applies the changes that arrived since a fetch started (`since`, from Date.now()). A big
 * team takes seconds to read (DSH-11), and a read that started before a change would
 * otherwise put the old status back when it lands.
 */
export function withRecentChanges(queryKey: QueryKey, since: number, rows: TeamRow[]): TeamRow[] {
  const list = recent.get(JSON.stringify(queryKey)) ?? [];
  return list.filter((c) => c.at >= since).reduce((acc, c) => applyPresence(acc, c.change), rows);
}

export function useLivePresence(queryKey: QueryKey): LiveState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveState>("connecting");

  useEffect(() => {
    const refetch = () => queryClient.invalidateQueries({ queryKey });
    const key = JSON.stringify(queryKey);
    let seenOnce = false;

    const channel = supabase
      .channel("team-presence")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "presence" },
        (msg: { new: Partial<Tables<"presence">> }) => {
          if (!msg.new.user_id) return;
          const change = { ...msg.new, user_id: msg.new.user_id };
          const at = Date.now();
          const list = (recent.get(key) ?? []).filter((c) => at - c.at < KEEP_MS);
          list.push({ at, change });
          recent.set(key, list);
          queryClient.setQueryData<TeamRow[]>(queryKey, (rows) =>
            rows ? applyPresence(rows, change) : rows,
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
      recent.delete(key);
    };
  }, [queryClient, queryKey]);

  return state;
}
