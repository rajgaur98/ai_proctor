// rebuild-segments (#41; TS-01..06, LLD section 06): rebuilds timesheet segments
// for employee-days. For each day it loads the facts (segment_inputs), runs
// buildSegments() from packages/core, and replaces the day's auto segments
// (replace_day_segments, which holds the lock and clears the dirty mark).
//
// Two callers:
//  - the segments_kick cron job (service-role key as the bearer token): works
//    through up to `limit` (default 50, at most 200) due dirty days, oldest first
//    (due_segment_days: a day that keeps failing waits out its backoff). A failure is
//    reported through record_segment_failure, which counts the attempt and backs off;
//    one failing day never stops the rest. TODO(M6): send days that keep failing to
//    Sentry (stuck_segment_days lists them until then).
//  - a signed-in user, for one day: { user_id, day: "YYYY-MM-DD" }, allowed when
//    can_view_user(user_id). The dashboard asks for this when it opens a day.
// Reply: { rebuilt, locked, failed, days: { user_id, day, segments | locked | error }[] }.
//
// ../_shared/core is generated from packages/core (`pnpm core:fn`).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import { buildSegments, type DayInput } from "../_shared/core/segments.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Compares without stopping at the first difference. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

interface DayResult {
  user_id: string;
  day: string;
  segments?: number;
  locked?: boolean;
  error?: string;
}

async function rebuildDay(admin: SupabaseClient, userId: string, day: string): Promise<DayResult> {
  try {
    const loaded = await admin.rpc("segment_inputs", { p_user_id: userId, p_day: day });
    if (loaded.error) return { user_id: userId, day, error: loaded.error.message };
    const { input, loaded_at } = loaded.data as { input: DayInput; loaded_at: string };

    const segments = buildSegments(input).map((s) => ({
      start: s.start,
      end: s.end,
      type: s.type,
      project_id: s.projectId,
      counted: s.counted,
      flagged: s.flagged,
    }));
    const replaced = await admin.rpc("replace_day_segments", {
      p_user_id: userId,
      p_day: day,
      p_segments: segments,
      p_loaded_at: loaded_at,
    });
    if (replaced.error) return { user_id: userId, day, error: replaced.error.message };
    // null: the day is locked in an approved timesheet (#43); left as it is.
    return replaced.data === null
      ? { user_id: userId, day, locked: true }
      : { user_id: userId, day, segments: replaced.data as number };
  } catch (e) {
    // A day that throws (bad data, a bug in the rules) must not take the batch down.
    return { user_id: userId, day, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Counts the failed attempt and backs the day off; never throws. */
async function recordFailure(
  admin: SupabaseClient,
  result: DayResult,
  pickedAt: string,
): Promise<void> {
  try {
    const { error } = await admin.rpc("record_segment_failure", {
      p_user_id: result.user_id,
      p_day: result.day,
      p_error: result.error ?? "unknown",
      p_started_at: pickedAt,
    });
    if (error) console.error("record_segment_failure", result.user_id, result.day, error.message);
  } catch (e) {
    console.error("record_segment_failure", result.user_id, result.day, e);
  }
}

function summary(days: DayResult[]) {
  return {
    rebuilt: days.filter((d) => d.segments !== undefined).length,
    locked: days.filter((d) => d.locked).length,
    failed: days.filter((d) => d.error !== undefined).length,
    days,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authorization = req.headers.get("Authorization") ?? "";
  const bearer = authorization.replace(/^Bearer\s+/i, "");
  const body = await req.json().catch(() => null);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // The cron job: the oldest due dirty days first.
  if (serviceKey !== "" && sameSecret(bearer, serviceKey)) {
    const requested = Number(body?.limit);
    const limit = Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;
    const { data: due, error } = await admin.rpc("due_segment_days", { p_limit: limit });
    if (error) return reply({ error: "dirty_days_unreadable" }, 500);
    const days: DayResult[] = [];
    for (const d of (due ?? []) as { user_id: string; day: string; picked_at: string }[]) {
      const result = await rebuildDay(admin, d.user_id, d.day);
      if (result.error !== undefined) await recordFailure(admin, result, d.picked_at);
      days.push(result);
    }
    return reply(summary(days));
  }

  // A signed-in user, for one day they may view.
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: auth } = await caller.auth.getUser();
  if (!auth.user) return reply({ error: "not_signed_in" }, 401);

  const userId = typeof body?.user_id === "string" ? body.user_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !isDay(body?.day)) {
    return reply({ error: "invalid_request" }, 400);
  }
  const { data: allowed } = await caller.rpc("can_view_user", { target: userId });
  if (allowed !== true) return reply({ error: "forbidden" }, 403);

  return reply(summary([await rebuildDay(admin, userId, body.day)]));
});
