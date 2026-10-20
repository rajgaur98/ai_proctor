// export-user-data (#54; ADM-05, AUD-01): an owner or admin downloads everything held
// about one person, as the same ZIP the person gets from export-my-data (the layout is in
// ../_shared/userData.ts). Request: { user_id, email } with the person's email typed to
// confirm. Reply: the ZIP.
//
// The rules are begin_user_data_request's, called with the admin's own token: an active
// owner or admin of the person's org (with MFA when the org requires it), the typed email
// matching. Only after that is anything read, with the service role and always for that
// user and org. Differences from the employee's own export: the pause reasons (the
// employee's own, BRK-03) and managers' private "keep" decisions are left out. The export
// is audit-logged as user_data.exported, with the row counts, before it is returned.
// Errors: 400 invalid_request, 401 unauthorized, 403/404/409 with the SQL error code.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { cors, exportResponse, isUuid, reply, requestError } from "../_shared/userData.ts";

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

  const begun = await caller.rpc("begin_user_data_request", {
    p_user_id: userId,
    p_email: email,
    p_action: "export",
  });
  if (begun.error) {
    return (
      requestError(begun.error) ?? reply({ error: "export_failed", message: "Try again." }, 500)
    );
  }
  const orgId = String((begun.data as { org_id: string }).org_id);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  try {
    return await exportResponse({
      mode: "admin",
      reader: admin,
      admin,
      userId,
      orgId,
      record: async (counts) => {
        const logged = await admin.rpc("record_user_data_export", {
          p_actor_id: auth.user.id,
          p_user_id: userId,
          p_counts: counts,
        });
        if (logged.error) throw new Error(logged.error.message);
      },
    });
  } catch (e) {
    console.error("export-user-data failed", e);
    return reply({ error: "export_failed", message: "The export failed. Try again." }, 500);
  }
});
