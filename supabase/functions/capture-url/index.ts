// capture-url (#34; DSH-04, NFR-SEC-02): signed URLs for one check-in's captures.
// The access check and the audit row are capture_view's, called with the viewer's
// own token; this only signs what it returns, for at most 5 minutes.
// Request: { checkin_id }. Reply: capture_view's details plus
// files: { name, signed_path | null }[]: the signed URL's path and query, which the
// dashboard puts on its own Supabase URL (inside the runtime the API is an
// internal host the browser can't reach). Null when the file isn't there.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const SIGNED_FOR_SECONDS = 300;
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

interface View {
  expired: boolean;
  objects: { name: string; path: string }[];
  [key: string]: unknown;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => null);
  const checkinId = typeof body?.checkin_id === "string" ? body.checkin_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(checkinId)) return reply({ error: "invalid_request" }, 400);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const viewer = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data, error } = await viewer.rpc("capture_view", { p_checkin_id: checkinId });
  if (error) return reply({ error: "checkin_not_found" }, 404);
  const view = data as View;

  let files: { name: string; signed_path: string | null }[] = view.objects.map((o) => ({
    name: o.name,
    signed_path: null,
  }));
  if (!view.expired && view.objects.length > 0) {
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });
    const { data: signed } = await admin.storage.from("captures").createSignedUrls(
      view.objects.map((o) => o.path),
      SIGNED_FOR_SECONDS,
    );
    files = view.objects.map((o, i) => {
      const s = signed?.[i];
      if (!s?.signedUrl || s.error) return { name: o.name, signed_path: null };
      const u = new URL(s.signedUrl);
      return { name: o.name, signed_path: `${u.pathname}${u.search}` };
    });
  }
  const { objects: _paths, ...details } = view;
  return reply({ ...details, files, expires_in: SIGNED_FOR_SECONDS });
});
