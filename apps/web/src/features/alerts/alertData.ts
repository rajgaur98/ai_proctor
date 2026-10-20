import type { Enums, Json } from "@ai-proctor/contracts";
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";

export interface Alert {
  id: string;
  kind: Enums<"alert_kind">;
  details: Json;
  triggeredAt: string;
  read: boolean;
  userId: string;
  employeeName: string;
  employeeZone: string;
}

const LIMIT = 30;

/** The signed-in recipient's latest alerts, newest first. */
export const alertsQuery = (recipientId: string) =>
  queryOptions({
    queryKey: ["alerts", recipientId],
    queryFn: async (): Promise<Alert[]> => {
      const { data, error } = await supabase
        .from("alerts")
        .select(
          "id, kind, details, triggered_at, read_at, user_id, employee:users!alerts_user_id_fkey(full_name, timezone)",
        )
        .eq("recipient_id", recipientId)
        .order("triggered_at", { ascending: false })
        .limit(LIMIT);
      if (error) throw error;
      return data.map((a) => ({
        id: a.id,
        kind: a.kind,
        details: a.details,
        triggeredAt: a.triggered_at,
        read: a.read_at !== null,
        userId: a.user_id,
        employeeName: a.employee?.full_name ?? "Someone",
        employeeZone: a.employee?.timezone ?? "UTC",
      }));
    },
    // No Realtime for alerts: new ones show up within this long.
    refetchInterval: 15_000,
  });

/** Marks the given alerts read, or all of the caller's when no ids are given. */
export async function markAlertsRead(ids?: string[]) {
  // Generated types don't mark function arguments nullable; no ids means all.
  const { error } = await supabase.rpc("mark_alerts_read", { p_ids: ids as string[] });
  if (error) throw error;
}
