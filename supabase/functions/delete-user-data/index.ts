// delete-user-data (#54; ADM-05, AUD-01): an owner or admin permanently deletes everything
// held about one person: their capture images, every row, their devices and their sign-in.
// Request: { user_id, email } with the person's email typed to confirm. Reply:
// { ok: true, images_removed, counts } with the rows removed per table.
//
// Steps, all checked by SQL with the admin's own token (role, org, MFA, the typed email, not
// yourself, nobody still reporting to them):
//   1. begin_user_data_request: refuses, or stops the person (deactivated, devices revoked,
//      sessions ended) so nothing new arrives while this runs
//   2. the capture files under captures/<org>/<user>/, removed through the Storage API
//      (service role; the folder comes from list_user_capture_objects, never from the request)
//   3. delete_user_data: refuses while any file is left, then removes the rows and the Auth
//      account and writes the one tombstone audit row (user_data.deleted)
// If a step fails the person stays deactivated and the request can simply be run again.
// Errors: 400 invalid_request, 401 unauthorized, 403/404/409 with the SQL error code.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { cors, isUuid, reply, requestError } from "../_shared/userData.ts";

const BATCH = 1000;
// Rounds of "list the files, remove them, delete": a file can only appear again if
// something uploaded after step 1, which the capture policy forbids for an inactive user.
const ATTEMPTS = 3;

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
  const userId = body?.user_id;
  const email = body?.email;
  if (!isUuid(userId) || typeof email !== "string" || email.length > 254) {
    return reply({ error: "invalid_request" }, 400);
  }

  const failed = (e: unknown) => {
    console.error("delete-user-data failed", e);
    return reply(
      {
        error: "delete_failed",
        message: "The deletion didn't finish. The person is deactivated; run it again.",
      },
      500,
    );
  };

  const begun = await caller.rpc("begin_user_data_request", {
    p_user_id: userId,
    p_email: email,
    p_action: "delete",
  });
  if (begun.error) {
    return (
      requestError(begun.error) ?? reply({ error: "delete_failed", message: "Try again." }, 500)
    );
  }

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  let imagesRemoved = 0;
  try {
    for (let attempt = 1; ; attempt++) {
      for (;;) {
        const listed = await admin.rpc("list_user_capture_objects", {
          p_user_id: userId,
          p_limit: BATCH,
        });
        if (listed.error) throw new Error(listed.error.message);
        const names = (listed.data as { name: string }[]).map((o) => o.name);
        if (names.length === 0) break;
        const removed = await admin.storage.from("captures").remove(names);
        if (removed.error) throw new Error(removed.error.message);
        // Nothing removed would list the same names forever.
        if (removed.data.length === 0) throw new Error("Storage removed no files");
        imagesRemoved += removed.data.length;
      }
      const deleted = await caller.rpc("delete_user_data", { p_user_id: userId, p_email: email });
      if (!deleted.error) {
        return reply({ ok: true, images_removed: imagesRemoved, counts: deleted.data });
      }
      if (deleted.error.message === "captures_remain" && attempt < ATTEMPTS) continue;
      return requestError(deleted.error) ?? failed(deleted.error.message);
    }
  } catch (e) {
    return failed(e);
  }
});
