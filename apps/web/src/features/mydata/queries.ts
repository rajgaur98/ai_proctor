// What the My data page reads (#49): the employee's own rows, through row-level
// security, plus the small functions that add names the employee can't read directly
// (who viewed a capture, who made an edit, their manager).
import type { Json } from "@ai-proctor/contracts";
import { queryOptions } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { type RemovedParts, removedFromRow } from "../day/removedText";
import type { Outcome } from "../day/timeline";
import type { AppSample, CaptureView, DaySegment } from "./helpers";
import { sampleMinute } from "./helpers";

export interface MyCheckin {
  id: string;
  scheduledAt: string;
  shownAt: string | null;
  respondedAt: string | null;
  outcome: Outcome;
  deferralReason: string | null;
  idleSAtShow: number | null;
  deviceState: string | null;
  missedReason: string | null;
  missedReasonKind: string | null;
  objectKeys: string[];
  projectId: string | null;
  /** CAP-07: whether the webcam frame showed a face; null when not checked. */
  facePresent: boolean | null;
  /** Parts the employee removed (#253). */
  removed: RemovedParts;
}

export interface ActivityRow {
  appName: string;
  domain: string | null;
  seconds: number;
  titles: string[];
}

export interface MyEdit {
  id: string;
  kind: "exclude" | "include" | "project" | "adjust";
  startAt: string;
  endAt: string;
  projectId: string | null;
  reason: string | null;
  editorName: string | null;
  createdAt: string;
  periodStart: string;
}

/** The employee's time segments overlapping [from, to) (ISO instants). */
export const segmentsQuery = (userId: string, from: string, to: string) =>
  queryOptions({
    queryKey: ["my-data", "segments", userId, from, to],
    queryFn: async (): Promise<DaySegment[]> => {
      const { data, error } = await supabase
        .from("time_segments")
        .select("type, start_at, end_at, counted, excluded")
        .eq("user_id", userId)
        .lt("start_at", to)
        .gt("end_at", from)
        .order("start_at");
      if (error) throw error;
      return data.map((s) => ({
        type: s.type as DaySegment["type"],
        start: s.start_at,
        end: s.end_at,
        counted: s.counted,
        excluded: s.excluded,
      }));
    },
  });

export const checkinsQuery = (userId: string, from: string, to: string) =>
  queryOptions({
    queryKey: ["my-data", "checkins", userId, from, to],
    queryFn: async (): Promise<MyCheckin[]> => {
      const { data, error } = await supabase
        .from("checkin_events")
        .select(
          "id, scheduled_at, shown_at, responded_at, outcome, deferral_reason, idle_s_at_show, device_state, missed_reason, missed_reason_kind, object_keys, project_id, face_present, webcam_deleted_at, screen_deleted_at, apps_deleted_at, domains_deleted_at",
        )
        .eq("user_id", userId)
        .gte("scheduled_at", from)
        .lt("scheduled_at", to)
        .order("scheduled_at");
      if (error) throw error;
      return data.map((c) => ({
        id: c.id,
        scheduledAt: c.scheduled_at,
        shownAt: c.shown_at,
        respondedAt: c.responded_at,
        outcome: c.outcome,
        deferralReason: c.deferral_reason,
        idleSAtShow: c.idle_s_at_show,
        deviceState: c.device_state,
        missedReason: c.missed_reason,
        missedReasonKind: c.missed_reason_kind,
        objectKeys: c.object_keys,
        projectId: c.project_id,
        facePresent: c.face_present,
        removed: removedFromRow(c),
      }));
    },
  });

/** The app in front at each check-in (the minute it was answered), by check-in id. */
export const appsAtCheckinsQuery = (userId: string, checkins: MyCheckin[]) => {
  const minutes = [
    ...new Set(
      checkins
        .filter((c) => c.outcome === "pass")
        .map((c) => sampleMinute(c.respondedAt, c.scheduledAt)),
    ),
  ];
  return queryOptions({
    queryKey: ["my-data", "apps-at", userId, minutes],
    enabled: minutes.length > 0,
    queryFn: async (): Promise<Map<string, AppSample[]>> => {
      const { data, error } = await supabase
        .from("activity_samples")
        .select("minute, app_name, domain, seconds")
        .eq("user_id", userId)
        .in("minute", minutes);
      if (error) throw error;
      const byMinute = new Map<number, AppSample[]>();
      for (const s of data) {
        const key = Date.parse(s.minute);
        byMinute.set(key, [
          ...(byMinute.get(key) ?? []),
          { appName: s.app_name, domain: s.domain, seconds: s.seconds },
        ]);
      }
      return new Map(
        checkins.map((c) => [
          c.id,
          byMinute.get(Date.parse(sampleMinute(c.respondedAt, c.scheduledAt))) ?? [],
        ]),
      );
    },
  });
};

/** Seconds per app and site over the day (ACT-05). */
export const activityQuery = (userId: string, from: string, to: string) =>
  queryOptions({
    queryKey: ["my-data", "activity", userId, from, to],
    queryFn: async (): Promise<ActivityRow[]> => {
      const { data, error } = await supabase.rpc("activity_summary", {
        p_user_id: userId,
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      return data.map((r) => ({
        appName: r.app_name,
        domain: r.domain,
        seconds: r.seconds,
        titles: r.titles ?? [],
      }));
    },
  });

/** Other people's views of the caller's captures, newest first (EMP-03). */
export const capturesViewedQuery = (userId: string) =>
  queryOptions({
    queryKey: ["my-data", "views", userId],
    // Another person may open a capture while the page is open.
    refetchInterval: 60_000,
    queryFn: async (): Promise<CaptureView[]> => {
      const { data, error } = await supabase.rpc("my_capture_views", { p_days: 3650 });
      if (error) throw error;
      return data.map((v) => ({
        viewedAt: v.viewed_at,
        viewerId: v.viewer_id,
        viewerName: v.viewer_name,
        viewerRole: v.viewer_role,
        checkinId: v.checkin_id,
        checkinAt: v.checkin_at,
      }));
    },
  });

/** The manager's edits to the caller's weeks, with their reasons, newest first. */
export const myEditsQuery = (userId: string) =>
  queryOptions({
    queryKey: ["my-data", "edits", userId],
    queryFn: async (): Promise<MyEdit[]> => {
      const { data, error } = await supabase.rpc("my_edit_history", { p_limit: 50 });
      if (error) throw error;
      return data.map((e) => ({
        id: e.id,
        kind: e.kind as MyEdit["kind"],
        startAt: e.start_at,
        endAt: e.end_at,
        projectId: e.project_id,
        reason: e.reason,
        editorName: e.editor_name,
        createdAt: e.created_at,
        periodStart: e.period_start,
      }));
    },
  });

export const myManagerQuery = (userId: string) =>
  queryOptions({
    queryKey: ["my-data", "manager", userId],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase.rpc("my_manager");
      if (error) throw error;
      return data[0]?.full_name ?? null;
    },
  });

/** The org's image retention in days (policy.image_retention_days, default 30). */
export const retentionQuery = queryOptions({
  queryKey: ["my-data", "retention"],
  staleTime: 5 * 60_000,
  queryFn: async (): Promise<number> => {
    const { data, error } = await supabase.from("orgs").select("policy").limit(1).maybeSingle();
    if (error) throw error;
    const policy = (data?.policy ?? {}) as { [key: string]: Json | undefined };
    const days = policy.image_retention_days;
    return typeof days === "number" && days > 0 ? Math.floor(days) : 30;
  },
});

/** Unassigned, counted time in [from, to): what the employee could tag with a project. */
export const unassignedQuery = (userId: string, from: string, to: string) =>
  queryOptions({
    queryKey: ["my-data", "unassigned", userId, from, to],
    queryFn: async (): Promise<{ start: string; end: string }[]> => {
      const { data, error } = await supabase
        .from("time_segments")
        .select("start_at, end_at")
        .eq("user_id", userId)
        .is("project_id", null)
        .eq("counted", true)
        .eq("excluded", false)
        .gte("start_at", from)
        .lt("start_at", to)
        .order("start_at");
      if (error) throw error;
      return data.map((s) => ({ start: s.start_at, end: s.end_at }));
    },
  });

/** Sets or changes the reason on one of the caller's own misses (CHK-23, #39). */
export async function setMissReason(
  checkinId: string,
  kind: string,
  note: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("set_miss_reason", {
    p_checkin_id: checkinId,
    p_kind: kind,
    // Generated types don't mark function arguments nullable; keep a written note.
    p_note: note as string,
  });
  if (error) throw new Error(missMessages[error.message] ?? error.message);
}

const missMessages: Record<string, string> = {
  checkin_not_found: "That check-in isn't available to you.",
  not_a_miss: "Only a missed check-in takes a reason.",
  invalid_reason: "Pick one of the reasons.",
  note_too_long: "The note is too long.",
};
