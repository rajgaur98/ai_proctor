// What the day page reads (#33, #124): the day's time_segments, its Tamper periods (for
// the reason, #160), its check-ins, its top apps (#67) and the org's response window.
import type { SegmentType } from "@ai-proctor/core";
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import type { TopApp } from "./appsData";
import type { Checkin, DaySegment, Span, TamperPeriod } from "./timeline";

export interface CheckinRow extends Checkin {
  respondedAt: string | null;
  responseMs: number | null;
  wrongClicks: number;
  idleSAtShow: number | null;
  deviceState: string | null;
  missedReason: string | null;
  missedReasonKind: string | null;
  projectId: string | null;
  /** Stored file names (screen-1.webp, webcam.webp); the files open through the audit-logged viewer. */
  objectKeys: string[];
  facePresent: boolean | null;
}

/**
 * Asks for the day's segments to be rebuilt (LLD section 6), so the numbers are current
 * when the page opens. A day in an approved week or a failing rebuild keeps what is
 * stored, so this never throws.
 */
export async function rebuildDay(userId: string, day: string): Promise<boolean> {
  const { error } = await supabase.functions.invoke("rebuild-segments", {
    body: { user_id: userId, day },
  });
  return !error;
}

export const daySegmentsQuery = (userId: string, date: string) =>
  queryOptions({
    queryKey: ["day-segments", userId, date],
    queryFn: async (): Promise<DaySegment[]> => {
      const { data, error } = await supabase
        .from("time_segments")
        .select("type, start_at, end_at, counted, flagged, excluded")
        .eq("user_id", userId)
        .eq("day", date)
        .order("start_at");
      if (error) throw error;
      return data.map((s) => ({
        type: s.type as SegmentType,
        start: Date.parse(s.start_at),
        end: Date.parse(s.end_at),
        counted: s.counted,
        flagged: s.flagged,
        excluded: s.excluded,
      }));
    },
  });

/** The day's Tamper status periods with their reason; one recorded without a reason reads as capture blocked. */
export const dayTamperQuery = (userId: string, day: Span, date: string) =>
  queryOptions({
    queryKey: ["day-tamper", userId, date],
    queryFn: async (): Promise<TamperPeriod[]> => {
      const from = new Date(day.start).toISOString();
      const to = new Date(day.end).toISOString();
      const { data, error } = await supabase
        .from("status_periods")
        .select("reason, start_at, end_at")
        .eq("user_id", userId)
        .eq("status", "tamper")
        .lt("start_at", to)
        .or(`end_at.is.null,end_at.gt.${from}`)
        .order("start_at");
      if (error) throw error;
      return data.map((p) => ({
        reason: p.reason ?? "capture_blocked",
        start: Date.parse(p.start_at),
        end: p.end_at === null ? null : Date.parse(p.end_at),
      }));
    },
  });

export const dayCheckinsQuery = (userId: string, day: Span, date: string, zone: string) =>
  queryOptions({
    queryKey: ["day-checkins", userId, date, zone],
    queryFn: async (): Promise<CheckinRow[]> => {
      const { data, error } = await supabase
        .from("checkin_events")
        .select(
          "id, scheduled_at, shown_at, responded_at, outcome, deferral_reason, response_ms, wrong_clicks, idle_s_at_show, device_state, missed_reason, missed_reason_kind, project_id, object_keys, face_present",
        )
        .eq("user_id", userId)
        .gte("scheduled_at", new Date(day.start).toISOString())
        .lt("scheduled_at", new Date(day.end).toISOString())
        .order("scheduled_at");
      if (error) throw error;
      return data.map((c) => ({
        id: c.id,
        scheduledAt: c.scheduled_at,
        shownAt: c.shown_at,
        respondedAt: c.responded_at,
        outcome: c.outcome,
        deferralReason: c.deferral_reason,
        responseMs: c.response_ms,
        wrongClicks: c.wrong_clicks,
        idleSAtShow: c.idle_s_at_show,
        deviceState: c.device_state,
        missedReason: c.missed_reason,
        missedReasonKind: c.missed_reason_kind,
        projectId: c.project_id,
        objectKeys: c.object_keys,
        facePresent: c.face_present,
      }));
    },
  });

/** The org's check-in response window in seconds (policy.checkin_response_s, default 90). */
export const responseWindowQuery = queryOptions({
  queryKey: ["response-window"],
  staleTime: 5 * 60_000,
  queryFn: async (): Promise<number> => {
    const { data, error } = await supabase.from("orgs").select("policy").limit(1).maybeSingle();
    if (error) throw error;
    const policy = (data?.policy ?? {}) as { checkin_response_s?: unknown };
    return typeof policy.checkin_response_s === "number" ? policy.checkin_response_s : 90;
  },
});

/** How many apps the top apps card lists (ACT-04). */
export const TOP_APPS = 5;

/** A person's top apps over [from, to) (ISO instants); empty while their sampling is off. */
export const topAppsQuery = (userId: string, from: string, to: string) =>
  queryOptions({
    queryKey: ["top-apps", userId, from, to],
    queryFn: async (): Promise<TopApp[]> => {
      const { data, error } = await supabase.rpc("top_apps", {
        p_user_id: userId,
        p_from: from,
        p_to: to,
        p_limit: TOP_APPS,
      });
      if (error) throw error;
      return data.map((r) => ({ appName: r.app_name, seconds: r.seconds }));
    },
  });
