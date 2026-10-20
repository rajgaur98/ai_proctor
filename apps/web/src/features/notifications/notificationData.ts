import type { Json } from "@ai-proctor/contracts";
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";

export interface AppNotification {
  id: string;
  kind: string;
  payload: Json;
  createdAt: string;
  read: boolean;
}

const LIMIT = 30;

/** The signed-in user's latest notifications, newest first. */
export const notificationsQuery = (userId: string) =>
  queryOptions({
    queryKey: ["notifications", userId],
    queryFn: async (): Promise<AppNotification[]> => {
      const { data, error } = await supabase
        .from("notifications")
        .select("id, kind, payload, created_at, read_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(LIMIT);
      if (error) throw error;
      return data.map((n) => ({
        id: n.id,
        kind: n.kind,
        payload: n.payload,
        createdAt: n.created_at,
        read: n.read_at !== null,
      }));
    },
    // No Realtime for notifications: new ones show up within this long.
    refetchInterval: 15_000,
  });

/** Marks the given notifications read, or all of the caller's when no ids are given. */
export async function markNotificationsRead(ids?: string[]) {
  // Generated types don't mark function arguments nullable; no ids means all.
  const { error } = await supabase.rpc("mark_notifications_read", { p_ids: ids as string[] });
  if (error) throw error;
}
