// export-my-data (#49; EMP-04, AUD-01): a ZIP with a copy of the caller's own data,
// for data-subject access requests (GDPR, DPDP, CPRA). POST with the caller's token,
// no body. It reads every table with that token, so row-level security decides what
// is theirs (their own rows only; a manager's private "keep" decisions stay hidden, as
// in the dashboard). The capture images still inside the retention window are
// downloaded with the service role, but only from the caller's own folder: the paths
// come from their own check-ins and export_capture_objects (service role only) checks
// the folder prefix again.
//
// The ZIP and how it is built are shared with the admin's export of someone else's data
// (export-user-data, #54): ../_shared/userData.ts has the layout. Before anything is
// returned the export is audit-logged as my_data.exported with the row counts. Over the
// image limit the reply is 413 export_too_large and nothing is sent.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { cors, exportResponse, reply } from "../_shared/userData.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const me = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: auth, error: authError } = await me.auth.getUser(token);
  if (authError || !auth.user) return reply({ error: "unauthorized" }, 401);
  const userId = auth.user.id;

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  try {
    return await exportResponse({
      mode: "self",
      reader: me,
      admin,
      userId,
      orgId: null,
      record: async (counts) => {
        const logged = await admin.rpc("record_my_data_export", {
          p_user_id: userId,
          p_counts: counts,
        });
        if (logged.error) throw new Error(logged.error.message);
      },
    });
  } catch (e) {
    console.error("export-my-data failed", e);
    return reply({ error: "export_failed", message: "The export failed. Try again." }, 500);
  }
});
