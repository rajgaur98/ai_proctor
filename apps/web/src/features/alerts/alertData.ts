import type { Enums, Json } from "@ai-proctor/contracts";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import {
  type AlertCursor,
  type AlertFilters,
  cursorFilter,
  dateBounds,
  splitPage,
} from "./alertFilters";

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
const PAGE = 25;

/** How often to look again when Realtime is down; Realtime pushes new alerts at once. */
const FALLBACK_POLL_MS = 60_000;

const SELECT =
  "id, kind, details, triggered_at, read_at, user_id, employee:users!alerts_user_id_fkey(full_name, timezone)";

type Row = {
  id: string;
  kind: Alert["kind"];
  details: Json;
  triggered_at: string;
  read_at: string | null;
  user_id: string;
  employee: { full_name: string; timezone: string } | null;
};

function toAlert(a: Row): Alert {
  return {
    id: a.id,
    kind: a.kind,
    details: a.details,
    triggeredAt: a.triggered_at,
    read: a.read_at !== null,
    userId: a.user_id,
    employeeName: a.employee?.full_name ?? "Someone",
    employeeZone: a.employee?.timezone ?? "UTC",
  };
}

/** The signed-in recipient's latest alerts, newest first. */
export const alertsQuery = (recipientId: string) =>
  queryOptions({
    queryKey: ["alerts", recipientId],
    queryFn: async (): Promise<Alert[]> => {
      const { data, error } = await supabase
        .from("alerts")
        .select(SELECT)
        .eq("recipient_id", recipientId)
        .order("triggered_at", { ascending: false })
        .limit(LIMIT);
      if (error) throw error;
      return data.map(toAlert);
    },
    refetchInterval: FALLBACK_POLL_MS,
  });

/** The alerts page: the recipient's whole history, filtered, a page at a time (keyset). */
export const alertPageQuery = (recipientId: string, filters: AlertFilters) =>
  infiniteQueryOptions({
    queryKey: ["alerts", recipientId, "page", filters],
    initialPageParam: null as AlertCursor | null,
    queryFn: ({ pageParam }) => alertPage(recipientId, filters, pageParam, PAGE),
    getNextPageParam: (last) => last.next,
    refetchInterval: FALLBACK_POLL_MS,
  });

/** One page of the recipient's alerts that match the filters, newest first, after `cursor`. */
async function alertPage(
  recipientId: string,
  filters: AlertFilters,
  cursor: AlertCursor | null,
  size: number,
): Promise<{ rows: Alert[]; next: AlertCursor | null }> {
  let q = supabase.from("alerts").select(SELECT).eq("recipient_id", recipientId);
  if (filters.kind) q = q.eq("kind", filters.kind);
  if (filters.userId) q = q.eq("user_id", filters.userId);
  if (filters.read === "unread") q = q.is("read_at", null);
  if (filters.read === "read") q = q.not("read_at", "is", null);
  const { from, to } = dateBounds(filters);
  if (from) q = q.gte("triggered_at", from);
  if (to) q = q.lt("triggered_at", to);
  if (cursor) q = q.or(cursorFilter(cursor));
  const { data, error } = await q
    .order("triggered_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(size + 1);
  if (error) throw error;
  return splitPage(data.map(toAlert), size);
}

/** The most alerts one export holds; more is refused so nothing is cut off silently. */
export const EXPORT_MAX_ALERTS = 50_000;

/**
 * Every alert the page's filters match (#255), not only the loaded pages: the page's own
 * query, a page of 500 at a time (under the API's 1000-row cap).
 */
export async function matchingAlerts(recipientId: string, filters: AlertFilters): Promise<Alert[]> {
  const all: Alert[] = [];
  let cursor: AlertCursor | null = null;
  do {
    const page = await alertPage(recipientId, filters, cursor, 500);
    all.push(...page.rows);
    if (all.length > EXPORT_MAX_ALERTS) {
      throw new Error("Too many alerts for one export. Narrow the dates or other filters.");
    }
    cursor = page.next;
  } while (cursor);
  return all;
}

/** Marks the given alerts read, or all of the caller's when no ids are given. */
export async function markAlertsRead(ids?: string[]) {
  // Generated types don't mark function arguments nullable; no ids means all.
  const { error } = await supabase.rpc("mark_alerts_read", { p_ids: ids as string[] });
  if (error) throw error;
}

/** Marks the caller's unread alerts read that match the page's filters (not just the loaded ones). */
export async function markMatchingAlertsRead(filters: AlertFilters) {
  const { from, to } = dateBounds(filters);
  const { error } = await supabase.rpc("mark_alerts_read_matching", {
    ...(filters.kind ? { p_kind: filters.kind } : {}),
    ...(filters.userId ? { p_user_id: filters.userId } : {}),
    ...(from ? { p_from: from } : {}),
    ...(to ? { p_to: to } : {}),
  });
  if (error) throw error;
}
