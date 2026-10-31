// delete-checkin-parts (#253; EMP-06, CAP-09, AUD-01): an employee removes parts of one of
// their own passed check-ins from My data: the webcam frame, the screen captures, the app
// activity or the browser domains of the minute it was answered in.
// Request: { checkin_id, parts: ("webcam" | "screen" | "apps" | "domains")[] }.
// Reply: { ok: true, removed: { webcam, screen, apps, domains } (when each part was
// removed, or null), objects_removed, samples_deleted, samples_cleared }.
//
// Steps:
//   1. delete_checkin_parts, with the employee's own token: refuses anyone but the person
//      the check-in belongs to (managers and admins included), then in one transaction
//      sets the tombstone, deletes or clears the activity rows and writes the audit rows
//      (capture.deleted / activity.deleted). It returns the removed files still in Storage.
//   2. those files, removed through the Storage API (service role; the paths come from
//      the database for the caller's own check-in, never from the request)
//   3. checkin_removed_paths, with the employee's token: nothing may be left. Another
//      round if something is; an error if it still is.
// Running it again is safe: removed parts stay removed and leftover files are removed.
// Errors: 400 invalid_request / invalid_parts, 401 unauthorized, 404 checkin_not_found,
// 409 not_a_pass, 500 delete_failed.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { cors, isUuid, reply } from "../_shared/userData.ts";

const PARTS = ["webcam", "screen", "apps", "domains"];
const ATTEMPTS = 3;

const ERRORS: Record<string, { status: number; message: string }> = {
  invalid_parts: { status: 400, message: "Pick what to delete." },
  checkin_not_found: { status: 404, message: "That check-in isn't yours to delete." },
  not_a_pass: { status: 409, message: "Only a passed check-in has captures and apps to delete." },
  not_signed_in: { status: 401, message: "Sign in again and retry." },
  user_not_provisioned: { status: 401, message: "Sign in again and retry." },
};

function sqlError(error: { message: string }) {
  const known = ERRORS[error.message];
  if (!known) return null;
  return reply({ error: error.message, message: known.message }, known.status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: auth, error: authError } = await caller.auth.getUser(token);
  if (authError || !auth.user) return reply({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  const checkinId = body?.checkin_id;
  const parts = body?.parts;
  if (
    !isUuid(checkinId) ||
    !Array.isArray(parts) ||
    parts.length === 0 ||
    parts.length > PARTS.length ||
    !parts.every((p) => typeof p === "string" && PARTS.includes(p))
  ) {
    return reply({ error: "invalid_request", message: "Pick what to delete." }, 400);
  }

  const failed = (e: unknown) => {
    console.error("delete-checkin-parts failed", e);
    return reply(
      {
        error: "delete_failed",
        message: "Some images couldn't be removed yet. They are hidden already; try again.",
      },
      500,
    );
  };

  const deleted = await caller.rpc("delete_checkin_parts", {
    p_checkin_id: checkinId,
    p_parts: parts,
  });
  if (deleted.error) {
    return sqlError(deleted.error) ?? reply({ error: "delete_failed", message: "Try again." }, 500);
  }
  const result = deleted.data as {
    removed: Record<string, string | null>;
    objects: number;
    samples_deleted: number;
    samples_cleared: number;
    paths: string[];
  };

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  let objectsRemoved = 0;
  let paths = result.paths ?? [];
  try {
    for (let attempt = 1; paths.length > 0; attempt++) {
      if (attempt > ATTEMPTS) throw new Error(`files left: ${paths.length}`);
      // Removing a file that is already gone is not an error.
      const removed = await admin.storage.from("captures").remove(paths);
      if (removed.error) throw new Error(removed.error.message);
      objectsRemoved += removed.data.length;
      const left = await caller.rpc("checkin_removed_paths", { p_checkin_id: checkinId });
      if (left.error) throw new Error(left.error.message);
      paths = (left.data as string[] | null) ?? [];
    }
  } catch (e) {
    return failed(e);
  }

  return reply({
    ok: true,
    removed: result.removed,
    objects_removed: objectsRemoved,
    samples_deleted: result.samples_deleted,
    samples_cleared: result.samples_cleared,
  });
});
